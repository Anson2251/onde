//! User-defined scalar functions, aggregates/window functions and the authorizer.
//!
//! This is the one part of `ln-sqlite` where SQLite calls *back* into Rust while a statement is
//! running. The crate stays engine-free: the C trampolines below own the user data and call a
//! trait object the host implements. The host's implementation is the bridge to JavaScript
//! (`docs/sqlite-plan.md` §3.7); everything unsafe about the boundary — pointer validity, panics
//! crossing `extern "C"`, transient strings — is contained here.
//!
//! # Lifetimes
//!
//! Every registration hands SQLite a `Box<dyn ...>` behind a raw pointer, with an `xDestroy`
//! callback. SQLite calls that destructor when the function is replaced or the connection closes
//! (including on a failed registration), so the trait object lives exactly as long as SQLite can
//! call it. Both paths run on the isolate thread; the host closes connections before its engine
//! goes away.

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;

use rusqlite::ffi;

use crate::database::Database;
use crate::error::{Error, Result};
use crate::sqlite_transient;
use crate::value::Value;

/// A scalar function the host can call.
pub trait ScalarFunction: 'static {
    fn call(&mut self, args: &[Value]) -> Result<Value>;
}

/// An aggregate or window function the host can call.
///
/// The state is an opaque `u64` handle chosen by the implementation; `0` means "no state". The
/// handle is stored in SQLite's per-aggregate context, and the implementation owns whatever the
/// handle refers to. When a step returns a different handle, the previous one is dropped.
pub trait AggregateFunction: 'static {
    fn start(&mut self) -> Result<u64>;
    fn step(&mut self, state: u64, args: &[Value]) -> Result<u64>;
    fn result(&mut self, state: u64) -> Result<Value>;
    fn inverse(&mut self, state: u64, args: &[Value]) -> Result<u64>;
    fn drop_state(&mut self, state: u64);
}

/// The authorizer callback. Any return value is passed through to SQLite, so the host does not
/// have to re-export the constants.
pub trait Authorizer: 'static {
    fn authorize(
        &mut self,
        action: i32,
        arg1: Option<&str>,
        arg2: Option<&str>,
        database: Option<&str>,
        trigger: Option<&str>,
    ) -> i32;
}

/// Registration flags shared by scalar and aggregate functions.
#[derive(Debug, Clone, Copy, Default)]
pub struct FunctionOptions {
    pub deterministic: bool,
    pub direct_only: bool,
}

struct ScalarData {
    function: Box<dyn ScalarFunction>,
}

struct AggregateData {
    function: Box<dyn AggregateFunction>,
}

struct AuthorizerData {
    authorizer: Box<dyn Authorizer>,
}

fn text_pointer(pointer: *const c_char) -> Option<String> {
    if pointer.is_null() {
        return None;
    }
    // SAFETY: SQLite passes NUL-terminated strings that live for the callback.
    Some(
        unsafe { CStr::from_ptr(pointer) }
            .to_string_lossy()
            .into_owned(),
    )
}

fn flags(options: FunctionOptions) -> c_int {
    let mut flags = ffi::SQLITE_UTF8;
    if options.deterministic {
        flags |= ffi::SQLITE_DETERMINISTIC;
    }
    if options.direct_only {
        flags |= ffi::SQLITE_DIRECTONLY;
    }
    flags
}

impl Database {
    /// Register a scalar function. `arity` is `-1` for `varargs`.
    pub fn create_scalar_function(
        &self,
        name: &str,
        arity: i32,
        options: FunctionOptions,
        function: Box<dyn ScalarFunction>,
    ) -> Result<()> {
        let db = self.handle()?;
        let name = CString::new(name)
            .map_err(|_| Error::invalid_arg_value("Function name contains a NUL byte."))?;
        let data = Box::into_raw(Box::new(ScalarData { function })).cast::<c_void>();
        // SAFETY: `name` and `data` are valid for the call; SQLite owns `data` afterwards and
        // calls `destroy_scalar` even when registration fails.
        let result = unsafe {
            ffi::sqlite3_create_function_v2(
                db,
                name.as_ptr(),
                arity,
                flags(options),
                data,
                Some(scalar_call),
                None,
                None,
                Some(destroy_scalar),
            )
        };
        if result != ffi::SQLITE_OK {
            return Err(Error::from_db(db, result));
        }
        Ok(())
    }

    /// Register an aggregate function, or a window function when `window` is true.
    pub fn create_aggregate_function(
        &self,
        name: &str,
        arity: i32,
        options: FunctionOptions,
        window: bool,
        function: Box<dyn AggregateFunction>,
    ) -> Result<()> {
        let db = self.handle()?;
        let name = CString::new(name)
            .map_err(|_| Error::invalid_arg_value("Function name contains a NUL byte."))?;
        let data = Box::into_raw(Box::new(AggregateData { function })).cast::<c_void>();
        let (inverse, value) = if window {
            (
                Some(
                    aggregate_inverse
                        as unsafe extern "C" fn(
                            *mut ffi::sqlite3_context,
                            c_int,
                            *mut *mut ffi::sqlite3_value,
                        ),
                ),
                Some(aggregate_value as unsafe extern "C" fn(*mut ffi::sqlite3_context)),
            )
        } else {
            (None, None)
        };
        // SAFETY: as in `create_scalar_function`; `sqlite3_create_window_function` accepts a NULL
        // `xInverse`/`xValue` and then behaves as an ordinary aggregate.
        let result = unsafe {
            ffi::sqlite3_create_window_function(
                db,
                name.as_ptr(),
                arity,
                flags(options),
                data,
                Some(aggregate_step),
                Some(aggregate_final),
                value,
                inverse,
                Some(destroy_aggregate),
            )
        };
        if result != ffi::SQLITE_OK {
            return Err(Error::from_db(db, result));
        }
        Ok(())
    }

    /// Install (or clear, with `None`) the connection's authorizer.
    pub fn set_authorizer(&mut self, authorizer: Option<Box<dyn Authorizer>>) -> Result<()> {
        let db = self.handle()?;
        // Disable first so no callback can observe the data we are about to free.
        // SAFETY: a live connection; a NULL callback is the documented way to remove one.
        unsafe {
            ffi::sqlite3_set_authorizer(db, None, ptr::null_mut());
        }
        if let Some(old) = self.authorizer_data.take() {
            // SAFETY: the pointer came from `Box::into_raw` below and SQLite no longer holds it.
            drop(unsafe { Box::from_raw(old.cast::<AuthorizerData>()) });
        }
        if let Some(authorizer) = authorizer {
            let data = Box::into_raw(Box::new(AuthorizerData { authorizer })).cast::<c_void>();
            // SAFETY: `data` is a live allocation and the trampoline only reads it during calls.
            let result = unsafe { ffi::sqlite3_set_authorizer(db, Some(authorize), data) };
            if result != ffi::SQLITE_OK {
                // SAFETY: SQLite did not take ownership after a failure.
                drop(unsafe { Box::from_raw(data.cast::<AuthorizerData>()) });
                return Err(Error::from_db(db, result));
            }
            self.authorizer_data = Some(data);
        }
        Ok(())
    }

    /// Release the authorizer and every user-data block at close time.
    pub(crate) fn drop_authorizer(&mut self) {
        let Some(data) = self.authorizer_data.take() else {
            return;
        };
        if let Some(connection) = &self.connection {
            // SAFETY: the connection is live; disable before freeing the data it points at.
            unsafe {
                ffi::sqlite3_set_authorizer(connection.handle(), None, ptr::null_mut());
            }
        }
        // SAFETY: the pointer came from `Box::into_raw` in `set_authorizer`.
        drop(unsafe { Box::from_raw(data.cast::<AuthorizerData>()) });
    }
}

unsafe extern "C" fn destroy_scalar(data: *mut c_void) {
    if data.is_null() {
        return;
    }
    // SAFETY: the pointer came from `Box::into_raw` in `create_scalar_function`.
    drop(unsafe { Box::from_raw(data.cast::<ScalarData>()) });
}

unsafe extern "C" fn destroy_aggregate(data: *mut c_void) {
    if data.is_null() {
        return;
    }
    // SAFETY: as above, for `create_aggregate_function`.
    drop(unsafe { Box::from_raw(data.cast::<AggregateData>()) });
}

unsafe extern "C" fn scalar_call(
    context: *mut ffi::sqlite3_context,
    argc: c_int,
    argv: *mut *mut ffi::sqlite3_value,
) {
    // A panic must not unwind through SQLite's C frames.
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: SQLite passes the pointer registered with `create_scalar_function`.
        let data = unsafe { &mut *ffi::sqlite3_user_data(context).cast::<ScalarData>() };
        let args = unsafe { read_arguments(argc, argv) }?;
        data.function.call(&args)
    }));
    match outcome {
        Ok(Ok(value)) => set_result(context, value),
        Ok(Err(error)) => set_error(context, &error),
        Err(_) => set_error(context, &Error::callback("JavaScript callback panicked")),
    }
}

unsafe extern "C" fn aggregate_step(
    context: *mut ffi::sqlite3_context,
    argc: c_int,
    argv: *mut *mut ffi::sqlite3_value,
) {
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: the pointer registered with `create_aggregate_function`.
        let data = unsafe { &mut *ffi::sqlite3_user_data(context).cast::<AggregateData>() };
        let slot = unsafe { aggregate_slot(context) }?;
        let args = unsafe { read_arguments(argc, argv) }?;
        if unsafe { *slot } == 0 {
            let state = data.function.start()?;
            unsafe { *slot = state };
        }
        let current = unsafe { *slot };
        match data.function.step(current, &args) {
            Ok(next) => {
                if next != current {
                    data.function.drop_state(current);
                    unsafe { *slot = next };
                }
                Ok(())
            }
            Err(error) => {
                data.function.drop_state(current);
                unsafe { *slot = 0 };
                Err(error)
            }
        }
    }));
    if let Err(error) = flatten(outcome) {
        set_error(context, &error);
    }
}

unsafe extern "C" fn aggregate_inverse(
    context: *mut ffi::sqlite3_context,
    argc: c_int,
    argv: *mut *mut ffi::sqlite3_value,
) {
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: as in `aggregate_step`.
        let data = unsafe { &mut *ffi::sqlite3_user_data(context).cast::<AggregateData>() };
        let slot = unsafe { aggregate_slot(context) }?;
        let current = unsafe { *slot };
        if current == 0 {
            return Ok(());
        }
        let args = unsafe { read_arguments(argc, argv) }?;
        match data.function.inverse(current, &args) {
            Ok(next) => {
                if next != current {
                    data.function.drop_state(current);
                    unsafe { *slot = next };
                }
                Ok(())
            }
            Err(error) => {
                data.function.drop_state(current);
                unsafe { *slot = 0 };
                Err(error)
            }
        }
    }));
    if let Err(error) = flatten(outcome) {
        set_error(context, &error);
    }
}

unsafe extern "C" fn aggregate_final(context: *mut ffi::sqlite3_context) {
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: as in `aggregate_step`.
        let data = unsafe { &mut *ffi::sqlite3_user_data(context).cast::<AggregateData>() };
        let slot = unsafe { aggregate_slot(context) }?;
        if unsafe { *slot } == 0 {
            // No rows: the identity is the result, as in the documented aggregate examples.
            let state = data.function.start()?;
            unsafe { *slot = state };
        }
        let state = unsafe { *slot };
        let value = data.function.result(state);
        data.function.drop_state(state);
        unsafe { *slot = 0 };
        value
    }));
    match flatten(outcome) {
        Ok(value) => set_result(context, value),
        Err(error) => set_error(context, &error),
    }
}

unsafe extern "C" fn aggregate_value(context: *mut ffi::sqlite3_context) {
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: as in `aggregate_step`.
        let data = unsafe { &mut *ffi::sqlite3_user_data(context).cast::<AggregateData>() };
        let slot = unsafe { aggregate_slot(context) }?;
        if unsafe { *slot } == 0 {
            return Ok(Value::Null);
        }
        data.function.result(unsafe { *slot })
    }));
    match flatten(outcome) {
        Ok(value) => set_result(context, value),
        Err(error) => set_error(context, &error),
    }
}

unsafe extern "C" fn authorize(
    data: *mut c_void,
    action: c_int,
    arg1: *const c_char,
    arg2: *const c_char,
    database: *const c_char,
    trigger: *const c_char,
) -> c_int {
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: the pointer registered with `sqlite3_set_authorizer`.
        let data = unsafe { &mut *data.cast::<AuthorizerData>() };
        let arg1 = text_pointer(arg1);
        let arg2 = text_pointer(arg2);
        let database = text_pointer(database);
        let trigger = text_pointer(trigger);
        data.authorizer.authorize(
            action,
            arg1.as_deref(),
            arg2.as_deref(),
            database.as_deref(),
            trigger.as_deref(),
        )
    }));
    match outcome {
        Ok(code) => code,
        // A panic denies the operation rather than unwinding through SQLite.
        Err(_) => ffi::SQLITE_DENY,
    }
}

/// `catch_unwind` around a `Result`; a panic becomes a callback error.
fn flatten<T>(outcome: std::thread::Result<Result<T>>) -> Result<T> {
    match outcome {
        Ok(result) => result,
        Err(_) => Err(Error::callback("JavaScript callback panicked")),
    }
}

unsafe fn aggregate_slot(context: *mut ffi::sqlite3_context) -> Result<*mut u64> {
    // SAFETY: allocation is zeroed by SQLite; `context` is the live callback context.
    let slot = unsafe {
        ffi::sqlite3_aggregate_context(context, std::mem::size_of::<u64>() as c_int).cast::<u64>()
    };
    if slot.is_null() {
        return Err(Error::callback("out of memory allocating aggregate state"));
    }
    Ok(slot)
}

unsafe fn read_arguments(argc: c_int, argv: *mut *mut ffi::sqlite3_value) -> Result<Vec<Value>> {
    if argc <= 0 {
        return Ok(Vec::new());
    }
    let values = unsafe { std::slice::from_raw_parts(argv, argc as usize) };
    values
        .iter()
        .map(|value| unsafe { read_value(*value) })
        .collect()
}

pub(crate) unsafe fn read_value(value: *mut ffi::sqlite3_value) -> Result<Value> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    // SAFETY: `value` is one of the arguments SQLite passed to the callback.
    Ok(match unsafe { ffi::sqlite3_value_type(value) } {
        ffi::SQLITE_NULL => Value::Null,
        ffi::SQLITE_INTEGER => Value::Integer(unsafe { ffi::sqlite3_value_int64(value) }),
        ffi::SQLITE_FLOAT => Value::Real(unsafe { ffi::sqlite3_value_double(value) }),
        ffi::SQLITE_TEXT => {
            let pointer = unsafe { ffi::sqlite3_value_text(value) };
            let length = unsafe { ffi::sqlite3_value_bytes(value) };
            if pointer.is_null() || length <= 0 {
                Value::Text(String::new())
            } else {
                let bytes = unsafe { std::slice::from_raw_parts(pointer, length as usize) };
                Value::Text(String::from_utf8_lossy(bytes).into_owned())
            }
        }
        ffi::SQLITE_BLOB => {
            let pointer = unsafe { ffi::sqlite3_value_blob(value) };
            let length = unsafe { ffi::sqlite3_value_bytes(value) };
            if pointer.is_null() || length <= 0 {
                Value::Blob(Vec::new())
            } else {
                let bytes =
                    unsafe { std::slice::from_raw_parts(pointer.cast::<u8>(), length as usize) };
                Value::Blob(bytes.to_vec())
            }
        }
        _ => Value::Null,
    })
}

pub(crate) unsafe fn set_result(context: *mut ffi::sqlite3_context, value: Value) {
    match value {
        Value::Null => unsafe { ffi::sqlite3_result_null(context) },
        Value::Integer(integer) => unsafe { ffi::sqlite3_result_int64(context, integer) },
        Value::Real(real) => unsafe { ffi::sqlite3_result_double(context, real) },
        Value::Text(text) => match c_int::try_from(text.len()) {
            Ok(length) => unsafe {
                ffi::sqlite3_result_text(context, text.as_ptr().cast(), length, sqlite_transient());
            },
            Err(_) => unsafe {
                ffi::sqlite3_result_error_toobig(context);
            },
        },
        Value::Blob(blob) => match c_int::try_from(blob.len()) {
            Ok(length) => unsafe {
                ffi::sqlite3_result_blob(context, blob.as_ptr().cast(), length, sqlite_transient());
            },
            Err(_) => unsafe {
                ffi::sqlite3_result_error_toobig(context);
            },
        },
    }
}

unsafe fn set_error(context: *mut ffi::sqlite3_context, error: &Error) {
    match CString::new(error.message.as_str()) {
        Ok(message) => unsafe {
            ffi::sqlite3_result_error(context, message.as_ptr(), -1);
        },
        Err(_) => unsafe {
            ffi::sqlite3_result_error(context, c"callback failed".as_ptr(), -1);
        },
    }
    // SAFETY: a valid callback context.
    unsafe {
        ffi::sqlite3_result_error_code(context, error.errcode.unwrap_or(ffi::SQLITE_ERROR));
    }
}
