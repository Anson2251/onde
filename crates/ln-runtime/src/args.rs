//! Argument extraction for the host primitives.
//!
//! The host boundary is primitive-typed (see `docs/m3-plan.md` §2): JavaScript passes strings,
//! numbers, booleans, `Uint8Array`s and `null`; Rust validates them here. Keeping the validation
//! in one module means `fs` and `crypto` reject a wrong argument with the same Node-shaped
//! `ERR_INVALID_ARG_TYPE` error instead of an rquickjs conversion error.

use ln_engine::js;
use ln_error::NodeError;

/// Node's `Received ...` text for an argument.
pub(crate) fn type_name(value: &js::Value<'_>) -> &'static str {
    value.type_name()
}

fn missing(argument: &str, expected: &str) -> NodeError {
    NodeError::invalid_arg_type(argument, expected, "undefined")
}

fn wrong(argument: &str, expected: &str, value: &js::Value<'_>) -> NodeError {
    NodeError::invalid_arg_type(argument, expected, type_name(value))
}

/// A required `string` argument.
pub(crate) fn string<'js>(
    value: Option<&js::Value<'js>>,
    argument: &str,
) -> Result<String, NodeError> {
    let Some(value) = value else {
        return Err(missing(argument, "string"));
    };
    let Some(text) = value.as_string() else {
        return Err(wrong(argument, "string", value));
    };
    text.to_string().map_err(|_| {
        // A JS string with unpaired surrogates cannot be represented as UTF-8 Rust text.
        NodeError::invalid_arg_value(argument, "<string>", "is not a valid UTF-8 string")
    })
}

/// A required finite `number` argument.
pub(crate) fn number<'js>(
    value: Option<&js::Value<'js>>,
    argument: &str,
) -> Result<f64, NodeError> {
    let Some(value) = value else {
        return Err(missing(argument, "number"));
    };
    value
        .as_number()
        .ok_or_else(|| wrong(argument, "number", value))
}

pub(crate) fn i32_value<'js>(
    value: Option<&js::Value<'js>>,
    argument: &str,
) -> Result<i32, NodeError> {
    Ok(number(value, argument)? as i32)
}

pub(crate) fn u32_value<'js>(
    value: Option<&js::Value<'js>>,
    argument: &str,
) -> Result<u32, NodeError> {
    Ok(number(value, argument)? as u32)
}

pub(crate) fn u64_value<'js>(
    value: Option<&js::Value<'js>>,
    argument: &str,
) -> Result<u64, NodeError> {
    Ok(number(value, argument)? as u64)
}

pub(crate) fn i64_value<'js>(
    value: Option<&js::Value<'js>>,
    argument: &str,
) -> Result<i64, NodeError> {
    Ok(number(value, argument)? as i64)
}

/// A required `boolean` argument.
pub(crate) fn bool_value<'js>(
    value: Option<&js::Value<'js>>,
    argument: &str,
) -> Result<bool, NodeError> {
    let Some(value) = value else {
        return Err(missing(argument, "boolean"));
    };
    value
        .as_bool()
        .ok_or_else(|| wrong(argument, "boolean", value))
}

/// A required `Uint8Array` (or `ArrayBuffer`) argument, copied out of the engine.
pub(crate) fn bytes<'js>(
    value: Option<&js::Value<'js>>,
    argument: &str,
) -> Result<Vec<u8>, NodeError> {
    let Some(value) = value else {
        return Err(missing(argument, "an instance of Uint8Array"));
    };
    bytes_value(value, argument)
}

/// Like [`bytes`], but `undefined`/`null` mean "no data" (`hkdf`'s optional salt/info).
pub(crate) fn bytes_or_empty<'js>(value: Option<&js::Value<'js>>) -> Result<Vec<u8>, NodeError> {
    match value {
        Some(value) if !value.is_undefined() && !value.is_null() => bytes_value(value, "data"),
        _ => Ok(Vec::new()),
    }
}

fn bytes_value(value: &js::Value<'_>, argument: &str) -> Result<Vec<u8>, NodeError> {
    if let Some(array) = value
        .as_object()
        .and_then(|object| object.as_typed_array::<u8>())
    {
        if array.is_empty() {
            return Ok(Vec::new());
        }
        // SAFETY: the slice aliases the engine's backing store; it is copied immediately and no
        // JavaScript runs between the borrow and the copy.
        return Ok(unsafe { array.as_slice() }.to_vec());
    }
    if let Some(buffer) = js::ArrayBuffer::from_value(value.clone()) {
        // SAFETY: as above; `as_bytes` returns `None` for a detached buffer.
        return Ok(unsafe { buffer.as_bytes() }.unwrap_or_default().to_vec());
    }
    Err(wrong(argument, "an instance of Uint8Array", value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ln_engine::Engine;

    #[test]
    fn uint8_arrays_are_copied() {
        let engine = Engine::new().expect("engine");
        engine.with_ctx(|ctx| {
            let array = js::TypedArray::<u8>::new(ctx.clone(), vec![1_u8, 2, 3]).expect("array");
            let value = array.into_value();
            assert_eq!(bytes(Some(&value), "data").expect("bytes"), vec![1, 2, 3]);
        });
    }
}
