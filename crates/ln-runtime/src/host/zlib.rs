//! The CPU-only compression primitives behind `node:zlib`.
//!
//! `ln_zlib` is engine-free and synchronous: one call compresses or decompresses a whole buffer.
//! The JavaScript surface (`js/lib/zlib.js`) owns the Node-shaped argument validation and the
//! callback plumbing; this module only maps the operation name to an [`ln_zlib::Format`] and
//! converts the returned bytes to a `Uint8Array` (the Buffer subclass wraps that array without
//! copying).

use ln_engine::js;
use ln_error::NodeError;

use crate::args;
use crate::host_error::throw_node_error_value;

use super::HostState;

/// `mode` -> (format, decompress?).
fn operation(mode: &str) -> Option<(ln_zlib::Format, bool)> {
    Some(match mode {
        "gunzip" => (ln_zlib::Format::Gzip, true),
        "inflate" => (ln_zlib::Format::Zlib, true),
        "inflateRaw" => (ln_zlib::Format::Raw, true),
        "gzip" => (ln_zlib::Format::Gzip, false),
        "deflate" => (ln_zlib::Format::Zlib, false),
        "deflateRaw" => (ln_zlib::Format::Raw, false),
        _ => return None,
    })
}

pub(super) fn install<'js>(
    ctx: &js::Ctx<'js>,
    host: &js::Object<'js>,
    _state: &HostState,
) -> js::Result<()> {
    let zlib = js::Object::new(ctx.clone())?;

    zlib.set(
        "run",
        js::Function::new(
            ctx.clone(),
            |ctx: js::Ctx<'js>,
             mode: js::Value<'js>,
             data: js::Value<'js>,
             level: js::Value<'js>,
             max_output: js::Value<'js>|
             -> js::Result<js::Value<'js>> {
                let mode = args::string(Some(&mode), "mode")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                let data = args::bytes(Some(&data), "data")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                // Decompression ignores `level`; compression ignores `maxOutput`. Both are still
                // read so a missing/wrong value is a host-contract error, not a silent default.
                let level = args::number(Some(&level), "level")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                let max_output = args::number(Some(&max_output), "maxOutput")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;

                let (format, decompress) = operation(&mode).ok_or_else(|| {
                    let error = NodeError::invalid_arg_value(
                        "mode",
                        &format!("'{mode}'"),
                        "is not a supported zlib operation",
                    );
                    throw_node_error_value(&ctx, &error)
                })?;

                let bytes = if decompress {
                    // `0` means "no explicit limit": the JS layer only sends a limit when the
                    // caller asked for one (Node's default is the maximum Buffer length).
                    ln_zlib::decompress(format, &data, max_output.max(0.0) as usize)
                } else {
                    ln_zlib::compress(format, &data, level as i32)
                }
                .map_err(|error| throw_node_error_value(&ctx, &error))?;
                Ok(js::TypedArray::<u8>::new(ctx.clone(), bytes)?.into_value())
            },
        )?,
    )?;

    zlib.set(
        "crc32",
        js::Function::new(
            ctx.clone(),
            |ctx: js::Ctx<'js>, data: js::Value<'js>| -> js::Result<f64> {
                let data = args::bytes(Some(&data), "data")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                // `u32` would cross the boundary as a signed int32; Node exposes the unsigned
                // 32-bit value (`crc32("123456789") === 0xCBF43926`).
                Ok(f64::from(ln_zlib::crc32(&data)))
            },
        )?,
    )?;

    host.set("zlib", zlib)?;
    Ok(())
}
