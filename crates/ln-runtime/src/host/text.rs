//! UTF-8 encode and decode for `buffer` and the WHATWG `TextEncoder`/`TextDecoder`.
//!
//! Both used to be JavaScript. The decoder walked one byte at a time, pushed every code point into
//! an array and joined the result in chunks, which cost about 150 ns per byte: reading a 1 MB text
//! file took 142 ms against Node's 0.15 ms. The encoder had the same shape. These two functions are
//! the same algorithms in Rust, where UTF-8 is a library call.
//!
//! Only the whole-buffer path lives here. `TextDecoder` with `stream: true` still runs the JS state
//! machine, because a partial sequence has to be carried across calls and that is a rare path.
//!
//! BOM handling stays in JavaScript too: `TextDecoder` strips a leading BOM (unless `ignoreBOM`)
//! while `Buffer.toString` does not, so the policy belongs to the caller, not to the conversion.

use ln_engine::js;

use crate::{args, host_error::throw_node_error_value};

use super::buffer::{clamp_range, with_bytes};
use super::HostState;

/// Index where the held UTF-8 suffix starts, using Node's StringDecoder split rule.
///
/// A lead byte in `C0..=F7` declares a total length; the decoder holds it plus up to
/// `length - 1` continuation bytes while the chunk ends. A non-continuation byte flushes the
/// partial sequence (the lossy decoder replaces it) and is reprocessed, exactly as the JS loop
/// does. Bytes after the held suffix are decoded in one `from_utf8_lossy` pass.
fn utf8_held_suffix(bytes: &[u8]) -> usize {
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte < 0x80 {
            index += 1;
            continue;
        }
        if (0xc0..=0xf7).contains(&byte) {
            let need = if byte <= 0xdf {
                2
            } else if byte <= 0xef {
                3
            } else {
                4
            };
            let mut run = 0;
            let mut next = index + 1;
            while next < bytes.len() && run + 1 < need && (0x80..=0xbf).contains(&bytes[next]) {
                run += 1;
                next += 1;
            }
            if run + 1 == need {
                index = next;
                continue;
            }
            if next >= bytes.len() {
                return index;
            }
            // The sequence was interrupted; the prefix decoder handles the partial bytes and
            // this non-continuation starts the next unit.
            index = next;
            continue;
        }
        // A bare continuation or an invalid lead (F8..=FF).
        index += 1;
    }
    bytes.len()
}

pub(super) fn install<'js>(
    ctx: &js::Ctx<'js>,
    host: &js::Object<'js>,
    _state: &HostState,
) -> js::Result<()> {
    let text = js::Object::new(ctx.clone())?;

    text.set(
        "decode",
        js::Function::new(
            ctx.clone(),
            |ctx: js::Ctx<'js>,
             data: js::Value<'js>,
             fatal: js::Value<'js>|
             -> js::Result<js::Value<'js>> {
                let bytes = args::bytes(Some(&data), "data")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                let fatal = args::bool_value(Some(&fatal), "fatal")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;

                if fatal {
                    // `null` means "invalid": the JS layer owns the error, because the same
                    // `ERR_ENCODING_INVALID_ENCODED_DATA` shape is thrown for utf-16le as well.
                    return match std::str::from_utf8(&bytes) {
                        Ok(valid) => Ok(js::String::from_str(ctx.clone(), valid)?.into_value()),
                        Err(_) => Ok(js::Value::new_null(ctx.clone())),
                    };
                }

                // Lossy: one U+FFFD per maximal invalid subpart, which is the WHATWG replacement
                // rule and what the JS decoder produced.
                let lossy = String::from_utf8_lossy(&bytes);
                Ok(js::String::from_str(ctx.clone(), lossy.as_ref())?.into_value())
            },
        )?,
    )?;

    text.set(
        "decodeStream",
        js::Function::new(
            ctx.clone(),
            |ctx: js::Ctx<'js>,
             data: js::Value<'js>,
             start: js::Value<'js>,
             end: js::Value<'js>,
             pending: js::Value<'js>,
             fatal: js::Value<'js>|
             -> js::Result<js::Value<'js>> {
                let start = args::u64_value(Some(&start), "start")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?
                    as usize;
                let end = args::u64_value(Some(&end), "end")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?
                    as usize;
                let fatal = args::bool_value(Some(&fatal), "fatal")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                // The carried suffix is at most three bytes; copy it before borrowing the chunk,
                // because `with_bytes` must not call back into the engine.
                let pending_bytes = if pending.is_undefined() || pending.is_null() {
                    Vec::new()
                } else {
                    args::bytes(Some(&pending), "pending")
                        .map_err(|error| throw_node_error_value(&ctx, &error))?
                };

                let decoded = with_bytes(&ctx, &data, |slice| {
                    let (start, end) = clamp_range(start, end, slice.len());
                    let chunk = &slice[start..end];
                    let mut combined;
                    let bytes: &[u8] = if pending_bytes.is_empty() {
                        chunk
                    } else {
                        combined = Vec::with_capacity(pending_bytes.len() + chunk.len());
                        combined.extend_from_slice(&pending_bytes);
                        combined.extend_from_slice(chunk);
                        &combined
                    };

                    // Hold only a lead plus a run of continuation bytes whose declared length is
                    // not yet reached. This is the JS/Node split rule: an incomplete prefix is
                    // carried to the next write even when the bytes already present would not
                    // satisfy the stricter second-byte range on completion.
                    let split = utf8_held_suffix(bytes);
                    let prefix = &bytes[..split];
                    if fatal && std::str::from_utf8(prefix).is_err() {
                        return None;
                    }
                    Some((
                        String::from_utf8_lossy(prefix).into_owned(),
                        bytes[split..].to_vec(),
                    ))
                })?;

                let Some((text, pending)) = decoded else {
                    return Ok(js::Value::new_null(ctx.clone()));
                };
                let result = js::Object::new(ctx.clone())?;
                result.set("text", js::String::from_str(ctx.clone(), &text)?)?;
                result.set(
                    "pending",
                    js::TypedArray::<u8>::new(ctx.clone(), pending)?.into_value(),
                )?;
                Ok(result.into_value())
            },
        )?,
    )?;

    text.set(
        "encode",
        js::Function::new(
            ctx.clone(),
            |ctx: js::Ctx<'js>, value: js::Value<'js>| -> js::Result<js::Value<'js>> {
                let string = args::string(Some(&value), "string")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                // QuickJS hands over UTF-8 already, with unpaired surrogates replaced by U+FFFD,
                // which is what the WHATWG encoder does. No second pass is needed here.
                Ok(js::TypedArray::<u8>::new(ctx.clone(), string.into_bytes())?.into_value())
            },
        )?,
    )?;

    host.set("text", text)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::utf8_held_suffix;

    #[test]
    fn ascii_is_never_held() {
        assert_eq!(utf8_held_suffix(b""), 0);
        assert_eq!(utf8_held_suffix(b"hello"), 5);
    }

    #[test]
    fn a_complete_sequence_is_not_held() {
        assert_eq!(utf8_held_suffix(&[0xe2, 0x82, 0xac]), 3);
        assert_eq!(utf8_held_suffix(&[0xc0, 0x80]), 2); // invalid, but complete by declared length
        assert_eq!(utf8_held_suffix(&[0xe0, 0x80, 0x80]), 3);
    }

    #[test]
    fn a_truncated_suffix_is_held_from_its_lead() {
        assert_eq!(utf8_held_suffix(&[0x61, 0xe2]), 1);
        assert_eq!(utf8_held_suffix(&[0xe0, 0x80]), 0);
        assert_eq!(utf8_held_suffix(&[0x61, 0xf0, 0x9f]), 1);
        assert_eq!(utf8_held_suffix(&[0xf0, 0x9f, 0x98]), 0);
    }

    #[test]
    fn an_interrupted_sequence_is_flushed_and_the_next_byte_reprocessed() {
        // E2 82 is a valid prefix, but 61 is not a continuation: the prefix is completed (and
        // decoded as invalid) before 61.
        assert_eq!(utf8_held_suffix(&[0xe2, 0x82, 0x61]), 3);
        // A bare continuation byte and an invalid lead are single-byte units, not held.
        assert_eq!(utf8_held_suffix(&[0x80, 0xbf]), 2);
        assert_eq!(utf8_held_suffix(&[0xf8, 0x80]), 2);
    }
}
