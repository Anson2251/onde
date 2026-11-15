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

use super::HostState;

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
