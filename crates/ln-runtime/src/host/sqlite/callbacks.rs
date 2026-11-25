//! Re-entrant SQLite callbacks: user-defined functions, aggregates, the authorizer and
//! changeset application.
//!
//! This is the file `docs/sqlite-plan.md` §3.7 describes. A SQLite C callback runs while a host
//! primitive is on the stack, so the JavaScript context is already alive: [`CallbackScope`]
//! publishes its raw pointer for the duration of the call, and the trampolines in `ln-sqlite`
//! call the trait objects below, which rebuild a [`js::Ctx`] from that pointer and call the
//! stored `Persistent` functions.
//!
//! # Invariants
//!
//! * The pointer is only set on the isolate thread, only while a host primitive that can execute
//!   SQL is on the stack, and is restored (not cleared) on exit so nested calls work.
//! * A JavaScript exception is never replaced by an `ERR_SQLITE_ERROR`: the trampoline records
//!   that a callback failed, and the host call returns `js::Error::Exception`, leaving the
//!   original exception pending.
//! * Every `Persistent` lives in the SQLite user-data block and is released by `xDestroy` when the
//!   function is replaced or the connection closes — which `SqliteState::shutdown` does before the
//!   engine goes away.

use std::cell::Cell;
use std::collections::HashMap;
use std::ptr::NonNull;

use crate::args;
use crate::host_error::throw_node_error_value;
use ln_engine::js;
use ln_engine::js::qjs;
use ln_engine::js::IntoJs;
use ln_error::NodeError;
use ln_sqlite::{
    AggregateFunction, Authorizer, ChangesetHandler, FunctionOptions, ScalarFunction, Value,
};

use super::{throw_sqlite, value_to_js};
use crate::host::HostState;

thread_local! {
    /// The context of the host call currently executing SQL. `None` outside such a call.
    static CALLBACK_CONTEXT: Cell<Option<NonNull<qjs::JSContext>>> = const { Cell::new(None) };
    /// Set when a JavaScript callback threw; the pending exception must be re-raised.
    static CALLBACK_FAILED: Cell<bool> = const { Cell::new(false) };
}

/// Publishes the current context for SQLite callbacks and restores the previous one on exit.
pub(super) struct CallbackScope {
    previous_context: Option<NonNull<qjs::JSContext>>,
    previous_failed: bool,
}

impl CallbackScope {
    pub(super) fn enter(ctx: &js::Ctx<'_>) -> Self {
        let previous_context = CALLBACK_CONTEXT.with(|cell| cell.replace(Some(ctx.as_raw())));
        let previous_failed = CALLBACK_FAILED.with(|cell| cell.replace(false));
        CallbackScope {
            previous_context,
            previous_failed,
        }
    }
}

impl Drop for CallbackScope {
    fn drop(&mut self) {
        CALLBACK_CONTEXT.with(|cell| cell.set(self.previous_context));
        CALLBACK_FAILED.with(|cell| cell.set(self.previous_failed));
    }
}

fn take_failed() -> bool {
    CALLBACK_FAILED.with(|cell| cell.replace(false))
}

fn mark_failed() {
    CALLBACK_FAILED.with(|cell| cell.set(true));
}

/// Finish a host operation: a callback failure re-raises its pending JavaScript exception, and
/// any other error becomes a Node-shaped error.
pub(super) fn finish_call<'js, T>(
    ctx: &js::Ctx<'js>,
    result: ln_sqlite::Result<T>,
) -> js::Result<T> {
    if take_failed() {
        return Err(js::Error::Exception);
    }
    result.map_err(|error| throw_sqlite(ctx, &error))
}

/// Rebuild the context captured by `CallbackScope`. The lifetime is the callback's; nothing here
/// lets it escape the synchronous execution.
fn callback_context() -> Result<js::Ctx<'static>, CallbackError> {
    let pointer = CALLBACK_CONTEXT
        .with(Cell::get)
        .ok_or(CallbackError::NoContext)?;
    // SAFETY: the pointer is set only for the duration of a host primitive on this thread, and
    // `Ctx::from_raw` duplicates the underlying context so the clone is independent.
    Ok(unsafe { js::Ctx::from_raw(pointer) })
}

/// Why a callback could not produce a value.
enum CallbackError {
    /// A JavaScript exception is pending on the context.
    Js(js::Error),
    /// No host primitive is executing SQL (a programming error in this crate).
    NoContext,
    /// A JavaScript value that SQLite cannot store.
    Conversion(NodeError),
}

impl CallbackError {
    fn into_sqlite(self) -> ln_sqlite::Error {
        match self {
            CallbackError::Js(error) => {
                mark_failed();
                ln_sqlite::Error::callback(error.to_string())
            }
            CallbackError::NoContext => {
                mark_failed();
                ln_sqlite::Error::callback("SQLite callback executed outside a statement host call")
            }
            CallbackError::Conversion(error) => ln_sqlite::Error::callback(error.message),
        }
    }
}

/// Convert a JavaScript callback result to the SQLite value Node produces.
///
/// Numbers become `REAL` (even integral ones), BigInts `INTEGER`, strings `TEXT`, byte views
/// `BLOB`, and `null`/`undefined` `NULL`. Booleans are rejected: Node reports
/// `ERR_SQLITE_ERROR: Returned JavaScript value cannot be converted to a SQLite value`.
fn result_to_sql(value: &js::Value<'_>) -> Result<Value, NodeError> {
    if value.is_null() || value.is_undefined() {
        return Ok(Value::Null);
    }
    if value.as_bool().is_some() {
        return Err(NodeError::new(
            "ERR_SQLITE_ERROR",
            "Returned JavaScript value cannot be converted to a SQLite value",
        ));
    }
    if let Some(number) = value.as_number() {
        return Ok(Value::Real(number));
    }
    if let Some(bigint) = value.as_big_int() {
        return bigint
            .clone()
            .to_i64()
            .map(Value::Integer)
            .map_err(|_| NodeError::new("ERR_SQLITE_ERROR", "BigInt value is too large"));
    }
    if let Some(string) = value.as_string() {
        return string
            .to_string()
            .map(Value::Text)
            .map_err(|_| NodeError::new("ERR_SQLITE_ERROR", "The string is not valid UTF-8."));
    }
    if let Some(object) = value.as_object() {
        if let Some(array) = object.as_typed_array::<u8>() {
            // SAFETY: the slice aliases engine memory and is copied immediately.
            let bytes = if array.is_empty() {
                Vec::new()
            } else {
                unsafe { array.as_slice() }.to_vec()
            };
            return Ok(Value::Blob(bytes));
        }
    }
    if let Some(buffer) = js::ArrayBuffer::from_value(value.clone()) {
        // SAFETY: as above; `None` for a detached buffer.
        return Ok(Value::Blob(
            unsafe { buffer.as_bytes() }
                .map(<[u8]>::to_vec)
                .unwrap_or_default(),
        ));
    }
    Err(NodeError::new(
        "ERR_SQLITE_ERROR",
        "Returned JavaScript value cannot be converted to a SQLite value",
    ))
}

fn push_sql_value<'js>(
    args: &mut js::function::Args<'js>,
    ctx: &js::Ctx<'js>,
    value: &Value,
    big_ints: bool,
) -> Result<(), CallbackError> {
    let value = value_to_js(ctx, value.clone(), big_ints).map_err(CallbackError::Js)?;
    args.push_arg(value).map_err(CallbackError::Js)
}

fn push_optional_string<'js>(
    args: &mut js::function::Args<'js>,
    ctx: &js::Ctx<'js>,
    value: Option<&str>,
) -> Result<(), CallbackError> {
    let value: js::Value = match value {
        Some(text) => text.into_js(ctx).map_err(CallbackError::Js)?,
        None => js::Value::new_null(ctx.clone()),
    };
    args.push_arg(value).map_err(CallbackError::Js)
}

/// Call one persistent function with SQLite arguments and convert its result.
fn call_function(
    function: &js::Persistent<js::Function<'static>>,
    sql_args: &[Value],
    big_ints: bool,
) -> Result<Value, CallbackError> {
    let ctx = callback_context()?;
    let function = function.clone().restore(&ctx).map_err(CallbackError::Js)?;
    let mut args = js::function::Args::new(ctx.clone(), sql_args.len());
    for value in sql_args {
        push_sql_value(&mut args, &ctx, value, big_ints)?;
    }
    let result: js::Value = function.call_arg(args).map_err(CallbackError::Js)?;
    result_to_sql(&result).map_err(CallbackError::Conversion)
}

struct HostScalar {
    function: js::Persistent<js::Function<'static>>,
    big_ints: bool,
}

impl ScalarFunction for HostScalar {
    fn call(&mut self, args: &[Value]) -> ln_sqlite::Result<Value> {
        call_function(&self.function, args, self.big_ints).map_err(CallbackError::into_sqlite)
    }
}

struct HostAggregate {
    start_value: Option<js::Persistent<js::Value<'static>>>,
    start_function: Option<js::Persistent<js::Function<'static>>>,
    step: js::Persistent<js::Function<'static>>,
    result: Option<js::Persistent<js::Function<'static>>>,
    inverse: Option<js::Persistent<js::Function<'static>>>,
    big_ints: bool,
    states: HashMap<u64, js::Persistent<js::Value<'static>>>,
    next_state: u64,
}

impl HostAggregate {
    fn fresh_state(&mut self) -> Result<u64, CallbackError> {
        let ctx = callback_context()?;
        let value: js::Value = if let Some(function) = &self.start_function {
            let function = function.clone().restore(&ctx).map_err(CallbackError::Js)?;
            function
                .call::<_, js::Value>(())
                .map_err(CallbackError::Js)?
        } else if let Some(start) = &self.start_value {
            start.clone().restore(&ctx).map_err(CallbackError::Js)?
        } else {
            js::Value::new_null(ctx.clone())
        };
        self.next_state = self.next_state.wrapping_add(1).max(1);
        let id = self.next_state;
        self.states.insert(id, js::Persistent::save(&ctx, value));
        Ok(id)
    }

    fn step_with(
        &mut self,
        function: &js::Persistent<js::Function<'static>>,
        state: u64,
        args: &[Value],
    ) -> Result<u64, CallbackError> {
        let ctx = callback_context()?;
        let current = self.states.remove(&state).ok_or(CallbackError::NoContext)?;
        let current = current.restore(&ctx).map_err(CallbackError::Js)?;
        let function = function.clone().restore(&ctx).map_err(CallbackError::Js)?;
        let mut call_args = js::function::Args::new(ctx.clone(), args.len() + 1);
        call_args.push_arg(current).map_err(CallbackError::Js)?;
        for value in args {
            push_sql_value(&mut call_args, &ctx, value, self.big_ints)?;
        }
        let result: js::Value = function.call_arg(call_args).map_err(CallbackError::Js)?;
        self.states
            .insert(state, js::Persistent::save(&ctx, result));
        Ok(state)
    }
}

impl AggregateFunction for HostAggregate {
    fn start(&mut self) -> ln_sqlite::Result<u64> {
        self.fresh_state().map_err(CallbackError::into_sqlite)
    }

    fn step(&mut self, state: u64, args: &[Value]) -> ln_sqlite::Result<u64> {
        let step = self.step.clone();
        self.step_with(&step, state, args)
            .map_err(CallbackError::into_sqlite)
    }

    fn result(&mut self, state: u64) -> ln_sqlite::Result<Value> {
        let outcome = (|| {
            let ctx = callback_context()?;
            let state_value = self
                .states
                .get(&state)
                .cloned()
                .ok_or(CallbackError::NoContext)?
                .restore(&ctx)
                .map_err(CallbackError::Js)?;
            let value: js::Value = match &self.result {
                Some(result) => {
                    let function = result.clone().restore(&ctx).map_err(CallbackError::Js)?;
                    let mut args = js::function::Args::new(ctx.clone(), 1);
                    args.push_arg(state_value).map_err(CallbackError::Js)?;
                    function.call_arg(args).map_err(CallbackError::Js)?
                }
                None => state_value,
            };
            result_to_sql(&value).map_err(CallbackError::Conversion)
        })();
        outcome.map_err(CallbackError::into_sqlite)
    }

    fn inverse(&mut self, state: u64, args: &[Value]) -> ln_sqlite::Result<u64> {
        let Some(inverse) = self.inverse.clone() else {
            return Ok(state);
        };
        self.step_with(&inverse, state, args)
            .map_err(CallbackError::into_sqlite)
    }

    fn drop_state(&mut self, state: u64) {
        self.states.remove(&state);
    }
}

struct HostAuthorizer {
    callback: js::Persistent<js::Function<'static>>,
}

impl Authorizer for HostAuthorizer {
    fn authorize(
        &mut self,
        action: i32,
        arg1: Option<&str>,
        arg2: Option<&str>,
        database: Option<&str>,
        trigger: Option<&str>,
    ) -> i32 {
        let outcome = (|| {
            let ctx = callback_context()?;
            let function = self
                .callback
                .clone()
                .restore(&ctx)
                .map_err(CallbackError::Js)?;
            let mut args = js::function::Args::new(ctx.clone(), 5);
            args.push_arg(action).map_err(CallbackError::Js)?;
            push_optional_string(&mut args, &ctx, arg1)?;
            push_optional_string(&mut args, &ctx, arg2)?;
            push_optional_string(&mut args, &ctx, database)?;
            push_optional_string(&mut args, &ctx, trigger)?;
            let value: js::Value = function.call_arg(args).map_err(CallbackError::Js)?;
            Ok::<i32, CallbackError>(value.as_number().map(|n| n as i32).unwrap_or(0))
        })();
        match outcome {
            Ok(code) => code,
            Err(error) => {
                error.into_sqlite();
                1 // SQLITE_DENY
            }
        }
    }
}

struct HostModule {
    rows: js::Persistent<js::Function<'static>>,
    big_ints: bool,
}

impl ln_sqlite::VirtualTableModule for HostModule {
    fn rows(&mut self, args: &[Value]) -> ln_sqlite::Result<Vec<Vec<Value>>> {
        let outcome = (|| {
            let ctx = callback_context()?;
            let function = self.rows.clone().restore(&ctx).map_err(CallbackError::Js)?;
            let mut call_args = js::function::Args::new(ctx.clone(), args.len());
            for value in args {
                push_sql_value(&mut call_args, &ctx, value, self.big_ints)?;
            }
            let iterable: js::Value = function.call_arg(call_args).map_err(CallbackError::Js)?;
            // Node requires an iterable and reports a coded SQLite error otherwise; `Array.from`
            // alone would silently accept any array-like value.
            let symbol: js::Object = ctx.globals().get("Symbol").map_err(CallbackError::Js)?;
            let iterator: js::Symbol = symbol.get("iterator").map_err(CallbackError::Js)?;
            let iterable_ok = iterable
                .as_object()
                .and_then(|object| object.get::<_, js::Value>(iterator).ok())
                .and_then(|method| method.as_function().map(|_| ()))
                .is_some();
            if !iterable_ok {
                return Err(CallbackError::Conversion(NodeError::new(
                    "ERR_SQLITE_ERROR",
                    "The \"options.rows\" function must return an iterable object",
                )));
            }
            let array_constructor: js::Object =
                ctx.globals().get("Array").map_err(CallbackError::Js)?;
            let from: js::Function = array_constructor.get("from").map_err(CallbackError::Js)?;
            let array: js::Array = from.call((iterable,)).map_err(CallbackError::Js)?;
            let mut rows = Vec::with_capacity(array.len());
            for index in 0..array.len() {
                let row: js::Value = array.get(index).map_err(CallbackError::Js)?;
                let row = row.as_array().ok_or_else(|| {
                    CallbackError::Conversion(NodeError::new(
                        "ERR_SQLITE_ERROR",
                        "Each row returned by the \"options.rows\" function must be an array",
                    ))
                })?;
                let mut values = Vec::with_capacity(row.len());
                for column in 0..row.len() {
                    let value: js::Value = row.get(column).map_err(CallbackError::Js)?;
                    values.push(result_to_sql(&value).map_err(CallbackError::Conversion)?);
                }
                rows.push(values);
            }
            Ok::<Vec<Vec<Value>>, CallbackError>(rows)
        })();
        outcome.map_err(CallbackError::into_sqlite)
    }
}

struct HostChangeset {
    filter: Option<js::Persistent<js::Function<'static>>>,
    on_conflict: Option<js::Persistent<js::Function<'static>>>,
}

fn truthy(value: &js::Value<'_>) -> bool {
    if value.is_null() || value.is_undefined() {
        return false;
    }
    if let Some(boolean) = value.as_bool() {
        return boolean;
    }
    if let Some(number) = value.as_number() {
        return number != 0.0 && !number.is_nan();
    }
    if let Some(string) = value.as_string() {
        return string
            .to_string()
            .map(|text| !text.is_empty())
            .unwrap_or(true);
    }
    true
}

impl ChangesetHandler for HostChangeset {
    fn filter(&mut self, table: &str) -> bool {
        let Some(filter) = &self.filter else {
            return true;
        };
        let outcome = (|| {
            let ctx = callback_context()?;
            let function = filter.clone().restore(&ctx).map_err(CallbackError::Js)?;
            let value: js::Value = function.call((table,)).map_err(CallbackError::Js)?;
            Ok::<bool, CallbackError>(truthy(&value))
        })();
        outcome.unwrap_or_else(|error| {
            error.into_sqlite();
            false
        })
    }

    fn conflict(&mut self, conflict: i32) -> i32 {
        let Some(handler) = &self.on_conflict else {
            return 2 /* SQLITE_CHANGESET_ABORT */;
        };
        let outcome = (|| {
            let ctx = callback_context()?;
            let function = handler.clone().restore(&ctx).map_err(CallbackError::Js)?;
            let value: js::Value = function.call((conflict,)).map_err(CallbackError::Js)?;
            Ok::<i32, CallbackError>(
                value
                    .as_number()
                    .map(|n| n as i32)
                    .unwrap_or(2 /* SQLITE_CHANGESET_ABORT */),
            )
        })();
        outcome.unwrap_or_else(|error| {
            error.into_sqlite();
            2 /* SQLITE_CHANGESET_ABORT */
        })
    }
}

/// Read a boolean field from an options object, defaulting to false.
fn option_flag(options: &js::Object<'_>, name: &str) -> js::Result<bool> {
    let value: js::Value = options.get(name)?;
    Ok(value.as_bool().unwrap_or(false))
}

/// Install the WP5/WP6 primitives on the `sqlite` host object.
pub(super) fn install<'js>(
    ctx: &js::Ctx<'js>,
    sqlite: &js::Object<'js>,
    state: &HostState,
) -> js::Result<()> {
    {
        let state = state.sqlite.clone();
        sqlite.set(
            "createFunction",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      id: u32,
                      name: String,
                      options: js::Object<'js>,
                      function: js::Function<'js>|
                      -> js::Result<()> {
                    let database = state
                        .connection(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let arity: f64 = options.get("arity")?;
                    let scalar = HostScalar {
                        function: js::Persistent::save(&ctx, function),
                        big_ints: option_flag(&options, "useBigIntArguments")?,
                    };
                    let result = database.borrow().create_scalar_function(
                        &name,
                        arity as i32,
                        FunctionOptions {
                            deterministic: option_flag(&options, "deterministic")?,
                            direct_only: option_flag(&options, "directOnly")?,
                        },
                        Box::new(scalar),
                    );
                    result.map_err(|error| throw_sqlite(&ctx, &error))
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "createAggregate",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      id: u32,
                      name: String,
                      options: js::Object<'js>,
                      parts: js::Array<'js>|
                      -> js::Result<()> {
                    let database = state
                        .connection(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let arity: f64 = options.get("arity")?;
                    let start: js::Value = parts.get(0)?;
                    let step: js::Function = parts.get(1)?;
                    let result: js::Value = parts.get(2)?;
                    let inverse: js::Value = parts.get(3)?;
                    let (start_value, start_function) = if let Some(function) = start.as_function()
                    {
                        (None, Some(js::Persistent::save(&ctx, function.clone())))
                    } else if start.is_undefined() {
                        (None, None)
                    } else {
                        (Some(js::Persistent::save(&ctx, start.clone())), None)
                    };
                    let aggregate = HostAggregate {
                        start_value,
                        start_function,
                        step: js::Persistent::save(&ctx, step),
                        result: result
                            .as_function()
                            .map(|function| js::Persistent::save(&ctx, function.clone())),
                        inverse: inverse
                            .as_function()
                            .map(|function| js::Persistent::save(&ctx, function.clone())),
                        big_ints: option_flag(&options, "useBigIntArguments")?,
                        states: HashMap::new(),
                        next_state: 0,
                    };
                    let result = database.borrow().create_aggregate_function(
                        &name,
                        arity as i32,
                        FunctionOptions {
                            deterministic: option_flag(&options, "deterministic")?,
                            direct_only: option_flag(&options, "directOnly")?,
                        },
                        inverse.as_function().is_some(),
                        Box::new(aggregate),
                    );
                    result.map_err(|error| throw_sqlite(&ctx, &error))
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "setAuthorizer",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: u32, callback: js::Value<'js>| -> js::Result<()> {
                    let database = state
                        .connection(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let authorizer = match callback.as_function() {
                        Some(function) => Some(Box::new(HostAuthorizer {
                            callback: js::Persistent::save(&ctx, function.clone()),
                        }) as Box<dyn Authorizer>),
                        None if callback.is_null() => None,
                        None => {
                            let error = NodeError::invalid_arg_type(
                                "callback",
                                "function or null",
                                args::type_name(&callback),
                            );
                            return Err(throw_node_error_value(&ctx, &error));
                        }
                    };
                    let result = database.borrow_mut().set_authorizer(authorizer);
                    result.map_err(|error| throw_sqlite(&ctx, &error))
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "createModule",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      id: u32,
                      name: String,
                      columns: js::Array<'js>,
                      options: js::Object<'js>|
                      -> js::Result<()> {
                    let database = state
                        .connection(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let mut definitions = Vec::with_capacity(columns.len());
                    for index in 0..columns.len() {
                        let column: js::Array = columns.get(index)?;
                        let name: String = column.get(0)?;
                        let kind: String = column.get(1)?;
                        let hidden: bool = column.get(2)?;
                        definitions.push(ln_sqlite::ModuleColumn { name, kind, hidden });
                    }
                    let module = HostModule {
                        rows: js::Persistent::save(
                            &ctx,
                            options
                                .get::<_, js::Function>("rows")
                                .map_err(|_| js::Error::new_from_js("options.rows", "function"))?,
                        ),
                        big_ints: option_flag(&options, "useBigIntArguments")?,
                    };
                    let result = database.borrow_mut().create_module(
                        &name,
                        definitions,
                        option_flag(&options, "directOnly")?,
                        Box::new(module),
                    );
                    result.map_err(|error| throw_sqlite(&ctx, &error))
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "createSession",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: u32, options: js::Object<'js>| -> js::Result<f64> {
                    let database = state
                        .connection(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let table: js::Value = options.get("table")?;
                    let table = match table.as_string() {
                        Some(table) => Some(table.to_string().map_err(|error| {
                            js::Error::new_from_js_message(
                                "options.table",
                                "string",
                                error.to_string(),
                            )
                        })?),
                        None => None,
                    };
                    let database_name: String = options.get("db")?;
                    let session = database
                        .borrow_mut()
                        .create_session(table.as_deref(), &database_name)
                        .map_err(|error| throw_sqlite(&ctx, &error))?;
                    Ok(f64::from(state.add_session(database, session)))
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "sessionChangeset",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: u32| -> js::Result<js::TypedArray<'js, u8>> {
                    let entry = state
                        .session(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let bytes = entry
                        .database
                        .borrow()
                        .session_changeset(entry.id)
                        .map_err(|error| throw_sqlite(&ctx, &error))?;
                    js::TypedArray::<u8>::new(ctx.clone(), bytes)
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "sessionPatchset",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: u32| -> js::Result<js::TypedArray<'js, u8>> {
                    let entry = state
                        .session(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let bytes = entry
                        .database
                        .borrow()
                        .session_patchset(entry.id)
                        .map_err(|error| throw_sqlite(&ctx, &error))?;
                    js::TypedArray::<u8>::new(ctx.clone(), bytes)
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "sessionClose",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: u32| -> js::Result<()> {
                    let entry = state
                        .take_session(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let result = entry.database.borrow_mut().close_session(entry.id);
                    result.map_err(|error| throw_sqlite(&ctx, &error))
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "applyChangeset",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      id: u32,
                      changeset: js::Value<'js>,
                      options: js::Object<'js>|
                      -> js::Result<bool> {
                    let bytes = args::bytes(Some(&changeset), "changeset")
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let database = state
                        .connection(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let filter: js::Value = options.get("filter")?;
                    let on_conflict: js::Value = options.get("onConflict")?;
                    let mut handler = HostChangeset {
                        filter: filter
                            .as_function()
                            .map(|function| js::Persistent::save(&ctx, function.clone())),
                        on_conflict: on_conflict
                            .as_function()
                            .map(|function| js::Persistent::save(&ctx, function.clone())),
                    };
                    let _scope = CallbackScope::enter(&ctx);
                    let result = database.borrow().apply_changeset(&bytes, &mut handler);
                    finish_call(&ctx, result)
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "enableLoadExtension",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: u32, allow: bool| -> js::Result<()> {
                    let database = state
                        .connection(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let result = database.borrow_mut().enable_load_extension(allow);
                    result.map_err(|error| throw_sqlite(&ctx, &error))
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "loadExtension",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      id: u32,
                      path: String,
                      entry_point: js::Value<'js>|
                      -> js::Result<()> {
                    let database = state
                        .connection(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let entry = match entry_point.as_string() {
                        Some(entry) => Some(entry.to_string().map_err(|error| {
                            js::Error::new_from_js_message(
                                "entryPoint",
                                "string",
                                error.to_string(),
                            )
                        })?),
                        None => None,
                    };
                    let _scope = CallbackScope::enter(&ctx);
                    let result = database
                        .borrow_mut()
                        .load_extension(&path, entry.as_deref());
                    finish_call(&ctx, result)
                },
            )?,
        )?;
    }

    Ok(())
}
