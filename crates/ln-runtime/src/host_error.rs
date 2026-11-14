//! Error conversion shared by the host primitives and the module loader.
//!
//! Everything user-visible that fails at a syscall, an op or a resolution boundary becomes a
//! JavaScript `Error` with a Node `code` property. Keeping the construction in one place means the
//! CLI, `require`, `import`, `process`, `fs` and `crypto` all report the same shape:
//!
//! * the constructor comes from [`ln_error::NodeError::name`] (`Error`/`TypeError`/`RangeError`);
//! * `message` is used verbatim (system errors already start with `CODE: ...`);
//! * `code` is always set; `errno`, `syscall` and `path` only when the error has them;
//! * `stack` is the engine's own, from the constructor.

use ln_engine::js;
use ln_error::NodeError;

/// Throw a JS `Error` with `code` and `message`.
///
/// The value is built in JS (so `instanceof Error` holds, and `.stack` is present), then the
/// pending exception is set. Callers return the resulting [`js::Error`] from a host function or
/// loader callback, which is what makes the exception visible to user code.
pub(crate) fn throw_node_error<'js>(ctx: &js::Ctx<'js>, code: &str, message: &str) -> js::Error {
    match simple_error_object(ctx, "Error", code, message) {
        Ok(error) => ctx.throw(error.into_value()),
        Err(_) => fallback_throw(ctx, message),
    }
}

/// Build an `Error` object with `name`, `code` and `message` set (module/resolution helpers).
pub(crate) fn simple_error_object<'js>(
    ctx: &js::Ctx<'js>,
    name: &str,
    code: &str,
    message: &str,
) -> js::Result<js::Object<'js>> {
    let constructor: js::Function = ctx.globals().get("Error")?;
    // `Error(message)` called as a function produces the same object as `new Error(message)`.
    let error: js::Object = constructor.call((message,))?;
    error.set("name", name)?;
    error.set("code", code)?;
    Ok(error)
}

/// Build the JS error for a full [`NodeError`], including the optional properties.
///
/// This is the single conversion used by the sync throw paths, `__ln_op_done` and the crypto
/// primitives; the module loader keeps using [`throw_node_error`] because it only has a code and
/// a message.
pub(crate) fn node_error_object<'js>(
    ctx: &js::Ctx<'js>,
    error: &NodeError,
) -> js::Result<js::Object<'js>> {
    let constructor: js::Function = match error.name {
        "TypeError" => ctx.globals().get("TypeError")?,
        "RangeError" => ctx.globals().get("RangeError")?,
        _ => ctx.globals().get("Error")?,
    };
    // Calling the constructor as a function (`TypeError("x")`) returns a new error object.
    let value: js::Value = constructor.call((error.message.as_str(),))?;
    let object = value
        .into_object()
        .ok_or_else(|| js::Error::new_from_js("Error", "object"))?;
    // `Error` and friends already set `name`; anything else (`AbortError`, ...) needs it.
    if error.name != "Error" && error.name != "TypeError" && error.name != "RangeError" {
        object.set("name", error.name)?;
    }
    object.set("code", error.code)?;
    if let Some(errno) = error.errno {
        // `ln-error` stores the positive raw errno (the value `libc` reports); Node exposes the
        // negated form (`err.errno === -ENOENT`), so the sign flips exactly here, at the JS
        // boundary, not in the data model.
        object.set("errno", -errno)?;
    }
    if let Some(syscall) = error.syscall {
        object.set("syscall", syscall)?;
    }
    if let Some(path) = &error.path {
        object.set("path", path.display().to_string())?;
    }
    if let Some(cause) = &error.cause {
        object.set("cause", node_error_value(ctx, cause)?)?;
    }
    Ok(object)
}

/// Convert a [`NodeError`] into a JS value without throwing.
pub(crate) fn node_error_value<'js>(
    ctx: &js::Ctx<'js>,
    error: &NodeError,
) -> js::Result<js::Value<'js>> {
    Ok(node_error_object(ctx, error)?.into_value())
}

/// Throw the JS error for a [`NodeError`]. The returned [`js::Error`] carries the pending
/// exception; host functions return it as `Err`.
pub(crate) fn throw_node_error_value<'js>(ctx: &js::Ctx<'js>, error: &NodeError) -> js::Error {
    match node_error_value(ctx, error) {
        Ok(value) => ctx.throw(value),
        Err(_) => fallback_throw(ctx, &error.message),
    }
}

fn fallback_throw<'js>(ctx: &js::Ctx<'js>, message: &str) -> js::Error {
    match js::String::from_str(ctx.clone(), message) {
        Ok(text) => ctx.throw(text.into_value()),
        Err(_) => ctx.throw(js::Value::new_undefined(ctx.clone())),
    }
}

/// Map an I/O error to Node's `code`.
pub(crate) fn io_error_code(error: &std::io::Error) -> &'static str {
    use std::io::ErrorKind;
    match error.kind() {
        ErrorKind::NotFound => "ENOENT",
        ErrorKind::PermissionDenied => "EACCES",
        ErrorKind::AlreadyExists => "EEXIST",
        ErrorKind::IsADirectory => "EISDIR",
        ErrorKind::NotADirectory => "ENOTDIR",
        ErrorKind::InvalidInput => "EINVAL",
        ErrorKind::InvalidData => "EINVAL",
        _ => "EIO",
    }
}

/// Node-shaped `CODE: message, syscall 'path'`.
pub(crate) fn io_error_message(
    code: &str,
    syscall: &str,
    path: &std::path::Path,
    error: &std::io::Error,
) -> String {
    let mut detail = error.to_string();
    if let Some(index) = detail.find(" (os error") {
        detail.truncate(index);
    }
    let mut chars = detail.chars();
    if let Some(first) = chars.next() {
        detail = first.to_lowercase().collect::<String>() + chars.as_str();
    }
    format!("{code}: {detail}, {syscall} '{}'", path.display())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ln_engine::Engine;
    use std::path::Path;

    #[test]
    fn system_errors_carry_node_negative_errno() {
        let engine = Engine::new().expect("engine");
        engine.with_ctx(|ctx| {
            let error = NodeError::from_errno(libc::ENOENT, "open", Some(Path::new("/missing")));
            let object = node_error_object(&ctx, &error).expect("error object");
            assert_eq!(object.get::<_, i32>("errno").expect("errno"), -libc::ENOENT);
            assert_eq!(object.get::<_, String>("code").expect("code"), "ENOENT");
            assert_eq!(object.get::<_, String>("syscall").expect("syscall"), "open");
            assert_eq!(
                object.get::<_, String>("path").expect("path"),
                "/missing".to_owned()
            );
        });
    }

    #[test]
    fn coded_errors_have_no_errno_property() {
        let engine = Engine::new().expect("engine");
        engine.with_ctx(|ctx| {
            let error = NodeError::invalid_arg_type("path", "string", "undefined");
            let object = node_error_object(&ctx, &error).expect("error object");
            let errno: js::Value = object.get::<_, js::Value>("errno").expect("errno lookup");
            assert!(errno.is_undefined());
            assert_eq!(
                object.get::<_, String>("code").expect("code"),
                "ERR_INVALID_ARG_TYPE"
            );
        });
    }
}
