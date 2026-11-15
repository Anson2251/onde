//! Buffer searching: `indexOf`, `lastIndexOf` and the `includes` built on them.
//!
//! These were JavaScript byte loops. A scan for a byte over 1 MB took 40 ms, against 18 µs for
//! Node, because QuickJS interprets every comparison; the same scan in Rust is a `memchr`-class
//! loop over a borrowed slice.
//!
//! The haystack is borrowed straight out of the engine's `ArrayBuffer` instead of being copied into
//! a `Vec`: copying 1 MB per call would cost more than the search. That borrow is only valid while
//! no JavaScript runs, which holds here because the closure passed to [`with_bytes`] does the whole
//! search and no callback happens inside it.
//!
//! Argument normalization stays in JavaScript (`buffer.js`), so the clamping rules for empty
//! needles and out-of-range offsets live in exactly one place.

use ln_engine::js;

use crate::{args, host_error::throw_node_error_value};

use super::HostState;

/// Borrow a typed array's bytes for the duration of `f`.
///
/// `js::ArrayBuffer::as_raw` documents the pointer as valid until the next call into the engine, so
/// `f` must not call any JS function; the compiler cannot enforce that, hence the closure shape.
fn with_bytes<'js, R>(
    ctx: &js::Ctx<'js>,
    value: &js::Value<'js>,
    f: impl FnOnce(&[u8]) -> R,
) -> js::Result<R> {
    let object = js::Object::from_value(value.clone())?;
    let buffer = object.get::<_, js::Value<'js>>("buffer")?;
    let offset: usize = object.get("byteOffset")?;
    let length: usize = object.get("byteLength")?;

    let Some(array) = js::ArrayBuffer::from_value(buffer) else {
        return Err(js::Error::new_from_js_message(
            "buffer",
            "ArrayBuffer",
            "the typed array has no ArrayBuffer backing",
        ));
    };
    let Some(raw) = array.as_raw() else {
        return Err(js::Error::new_from_js_message(
            "buffer",
            "ArrayBuffer",
            "the backing store is detached",
        ));
    };

    // SAFETY: no JavaScript runs inside `f`, and `value` keeps the backing store alive for the
    // duration of the call.
    let all = unsafe { raw.as_ref() };
    let end = offset.saturating_add(length).min(all.len());
    if offset > all.len() {
        return Err(js::Error::new_from_js_message(
            "buffer",
            "ArrayBuffer",
            "the typed array points past its backing store",
        ));
    }
    let _ = ctx;
    Ok(f(&all[offset..end]))
}

/// Borrow the bytes of two typed arrays at once for the duration of `f`.
fn with_two_bytes<'js, R>(
    ctx: &js::Ctx<'js>,
    left: &js::Value<'js>,
    right: &js::Value<'js>,
    f: impl FnOnce(&[u8], &[u8]) -> R,
) -> js::Result<R> {
    with_bytes(ctx, left, |a| with_bytes(ctx, right, |b| f(a, b)))?
}

/// A byte needle for `indexOf(number)`, or the bytes of a `Buffer`/`Uint8Array` needle.
enum Needle {
    Byte(u8),
    Bytes(Vec<u8>),
}

fn needle_of<'js>(ctx: &js::Ctx<'js>, value: &js::Value<'js>) -> js::Result<Needle> {
    if let Some(number) = value.as_number() {
        // Node masks the value: `buf.indexOf(0x1ff)` looks for 0xff.
        return Ok(Needle::Byte((number as i64 & 0xff) as u8));
    }
    let bytes =
        args::bytes(Some(value), "value").map_err(|error| throw_node_error_value(ctx, &error))?;
    Ok(Needle::Bytes(bytes))
}

pub(super) fn install<'js>(
    ctx: &js::Ctx<'js>,
    host: &js::Object<'js>,
    _state: &HostState,
) -> js::Result<()> {
    let buffer = js::Object::new(ctx.clone())?;

    buffer.set(
        "indexOf",
        js::Function::new(
            ctx.clone(),
            |ctx: js::Ctx<'js>,
             haystack: js::Value<'js>,
             needle: js::Value<'js>,
             start: js::Value<'js>|
             -> js::Result<f64> {
                let start = args::u64_value(Some(&start), "start")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?
                    as usize;
                let needle = needle_of(&ctx, &needle)?;
                with_bytes(&ctx, &haystack, |hay| {
                    if start > hay.len() {
                        return -1.0;
                    }
                    match &needle {
                        Needle::Byte(byte) => match memchr::memchr(*byte, &hay[start..]) {
                            Some(found) => (start + found) as f64,
                            None => -1.0,
                        },
                        Needle::Bytes(bytes) => match memchr::memmem::find(&hay[start..], bytes) {
                            Some(found) => (start + found) as f64,
                            None => -1.0,
                        },
                    }
                })
            },
        )?,
    )?;

    buffer.set(
        "lastIndexOf",
        js::Function::new(
            ctx.clone(),
            |ctx: js::Ctx<'js>,
             haystack: js::Value<'js>,
             needle: js::Value<'js>,
             start: js::Value<'js>|
             -> js::Result<f64> {
                let start = args::u64_value(Some(&start), "start")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?
                    as usize;
                let needle = needle_of(&ctx, &needle)?;
                with_bytes(&ctx, &haystack, |hay| {
                    if hay.is_empty() {
                        return -1.0;
                    }
                    let start = start.min(hay.len() - 1);
                    match &needle {
                        Needle::Byte(byte) => match memchr::memrchr(*byte, &hay[..=start]) {
                            Some(found) => found as f64,
                            None => -1.0,
                        },
                        Needle::Bytes(bytes) => {
                            // A match has to end at or before `start + needle.len()`, which is what
                            // Node's backwards search means.
                            if bytes.is_empty() {
                                return start as f64;
                            }
                            let end = (start + bytes.len()).min(hay.len());
                            match memchr::memmem::rfind(&hay[..end], bytes) {
                                Some(found) => found as f64,
                                None => -1.0,
                            }
                        }
                    }
                })
            },
        )?,
    )?;

    buffer.set(
        "compare",
        js::Function::new(
            ctx.clone(),
            |ctx: js::Ctx<'js>,
             left: js::Value<'js>,
             left_start: js::Value<'js>,
             left_end: js::Value<'js>,
             right: js::Value<'js>,
             right_start: js::Value<'js>,
             right_end: js::Value<'js>|
             -> js::Result<f64> {
                let left_start = args::u64_value(Some(&left_start), "leftStart")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?
                    as usize;
                let left_end = args::u64_value(Some(&left_end), "leftEnd")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?
                    as usize;
                let right_start = args::u64_value(Some(&right_start), "rightStart")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?
                    as usize;
                let right_end = args::u64_value(Some(&right_end), "rightEnd")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?
                    as usize;

                with_two_bytes(&ctx, &left, &right, |a, b| {
                    // Ranges are clamped rather than rejected: the JS layer validated them against
                    // the buffer lengths it already knows.
                    let a = &a[left_start.min(a.len())..left_end.min(a.len())];
                    let b = &b[right_start.min(b.len())..right_end.min(b.len())];
                    match a.cmp(b) {
                        std::cmp::Ordering::Less => -1.0,
                        std::cmp::Ordering::Equal => 0.0,
                        std::cmp::Ordering::Greater => 1.0,
                    }
                })
            },
        )?,
    )?;

    host.set("buffer", buffer)?;
    Ok(())
}
