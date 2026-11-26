//! `__ln_host.sqlite`: the primitives behind `node:sqlite`.
//!
//! `ln-sqlite` owns the synchronous contract; this module only bridges it to JavaScript. The
//! boundary is handle-based because SQLite is a graph of live objects: a `Database` object holds
//! a numeric connection id, a `Statement` object holds a statement id, and both live in the
//! per-isolate [`SqliteState`]. Nothing here re-implements a SQLite rule; argument validation
//! that is part of Node's surface stays in `js/lib/sqlite.js`.
//!
//! Values are converted here, once: a JavaScript *number* becomes `REAL` (SQLite column affinity
//! decides whether an INTEGER column stores it as an integer), a bigint becomes `INTEGER`, a
//! boolean `1`/`0`, a string `TEXT`, a byte view a `BLOB`. Reading goes the other way, with
//! `INTEGER` → `number` unless the statement asked for BigInts.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use ln_engine::js;
use ln_engine::js::IntoJs;
use ln_error::NodeError;
use ln_perm::{Capability, Request};
use ln_sqlite::{
    Backup, BackupStep, BindOptions, Database, Generation, Limit, OpenOptions, Params, SessionId,
    Stat, StmtId, Value,
};

use crate::args;
use crate::host_error::{simple_error_object, throw_node_error_value};

use super::HostState;

mod callbacks;

use callbacks::{finish_call, CallbackScope};

/// The isolate's SQLite handles. One instance per isolate; ids are never reused, so a call on a
/// closed connection or statement fails loudly instead of touching freed SQLite memory.
pub(crate) struct SqliteState {
    inner: RefCell<SqliteInner>,
}

#[derive(Default)]
struct SqliteInner {
    connections: Vec<Option<Rc<RefCell<Database>>>>,
    statements: Vec<Option<StatementEntry>>,
    sessions: Vec<Option<SessionEntry>>,
    backups: Vec<Option<BackupEntry>>,
}

struct StatementEntry {
    database: Rc<RefCell<Database>>,
    id: StmtId,
}

#[derive(Clone)]
struct SessionEntry {
    database: Rc<RefCell<Database>>,
    id: SessionId,
}

struct BackupEntry {
    /// Keeps the source connection (and therefore the backup's source handle) alive.
    _source: Rc<RefCell<Database>>,
    backup: RefCell<Backup>,
}

impl SqliteState {
    pub(crate) fn new() -> Self {
        SqliteState {
            // Slot 0 is reserved so an unopened handle (the JavaScript side uses 0) can never
            // name a real connection.
            inner: RefCell::new(SqliteInner {
                connections: vec![None],
                statements: vec![None],
                sessions: vec![None],
                backups: vec![None],
            }),
        }
    }

    /// Close every connection. Called from `Isolate`'s `Drop` before the engine goes away, so a
    /// future user-defined function cannot outlive the context its callback lives in.
    pub(crate) fn shutdown(&self) {
        let mut inner = self.inner.borrow_mut();
        inner.statements.clear();
        inner.sessions.clear();
        inner.backups.clear();
        let connections = std::mem::take(&mut inner.connections);
        // The last `Rc` closes the `Database` (and its statements) through its `Drop`.
        drop(connections);
    }

    fn add_connection(&self, database: Database) -> u32 {
        let mut inner = self.inner.borrow_mut();
        inner
            .connections
            .push(Some(Rc::new(RefCell::new(database))));
        (inner.connections.len() - 1) as u32
    }

    fn connection(&self, id: u32) -> Result<Rc<RefCell<Database>>, NodeError> {
        self.inner
            .borrow()
            .connections
            .get(id as usize)
            .and_then(Clone::clone)
            .ok_or_else(|| invalid_state("database is not open"))
    }

    fn take_connection(&self, id: u32) -> Result<Rc<RefCell<Database>>, NodeError> {
        self.inner
            .borrow_mut()
            .connections
            .get_mut(id as usize)
            .and_then(Option::take)
            .ok_or_else(|| invalid_state("database is not open"))
    }

    fn add_statement(&self, database: Rc<RefCell<Database>>, id: StmtId) -> u32 {
        let mut inner = self.inner.borrow_mut();
        inner.statements.push(Some(StatementEntry { database, id }));
        (inner.statements.len() - 1) as u32
    }

    fn statement(&self, id: u32) -> Result<(Rc<RefCell<Database>>, StmtId), NodeError> {
        self.inner
            .borrow()
            .statements
            .get(id as usize)
            .and_then(|entry| {
                entry
                    .as_ref()
                    .map(|entry| (entry.database.clone(), entry.id))
            })
            .ok_or_else(|| invalid_state("statement has been finalized"))
    }

    fn take_statement(&self, id: u32) -> Result<StatementEntry, NodeError> {
        self.inner
            .borrow_mut()
            .statements
            .get_mut(id as usize)
            .and_then(Option::take)
            .ok_or_else(|| invalid_state("statement has been finalized"))
    }

    fn add_session(&self, database: Rc<RefCell<Database>>, id: SessionId) -> u32 {
        let mut inner = self.inner.borrow_mut();
        inner.sessions.push(Some(SessionEntry { database, id }));
        (inner.sessions.len() - 1) as u32
    }

    fn session(&self, id: u32) -> Result<SessionEntry, NodeError> {
        self.inner
            .borrow()
            .sessions
            .get(id as usize)
            .and_then(Clone::clone)
            .ok_or_else(|| invalid_state("session has been closed"))
    }

    fn take_session(&self, id: u32) -> Result<SessionEntry, NodeError> {
        self.inner
            .borrow_mut()
            .sessions
            .get_mut(id as usize)
            .and_then(Option::take)
            .ok_or_else(|| invalid_state("session has been closed"))
    }

    fn drop_sessions_of(&self, database: &Rc<RefCell<Database>>) {
        for entry in self.inner.borrow_mut().sessions.iter_mut() {
            if entry
                .as_ref()
                .is_some_and(|entry| Rc::ptr_eq(&entry.database, database))
            {
                *entry = None;
            }
        }
    }

    fn drop_statements_of(&self, database: &Rc<RefCell<Database>>) {
        for entry in self.inner.borrow_mut().statements.iter_mut() {
            if entry
                .as_ref()
                .is_some_and(|entry| Rc::ptr_eq(&entry.database, database))
            {
                *entry = None;
            }
        }
    }

    fn add_backup(&self, entry: BackupEntry) -> u32 {
        let mut inner = self.inner.borrow_mut();
        inner.backups.push(Some(entry));
        (inner.backups.len() - 1) as u32
    }

    fn take_backup(&self, id: u32) -> Result<BackupEntry, NodeError> {
        self.inner
            .borrow_mut()
            .backups
            .get_mut(id as usize)
            .and_then(Option::take)
            .ok_or_else(|| invalid_state("backup is no longer active"))
    }
}

impl Drop for SqliteState {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn invalid_state(message: &str) -> NodeError {
    NodeError::new("ERR_INVALID_STATE", message)
}

/// Turn an [`ln_sqlite::Error`] into a thrown JavaScript error.
///
/// SQLite failures carry Node's `errcode`/`errstr` fields; state and argument failures reuse the
/// shared `NodeError` vocabulary, with the constructor `ln-sqlite` selected (`TypeError`,
/// `RangeError`).
fn throw_sqlite<'js>(ctx: &js::Ctx<'js>, error: &ln_sqlite::Error) -> js::Error {
    if error.code == "ERR_SQLITE_ERROR" {
        let object = match simple_error_object(ctx, "Error", error.code, &error.message) {
            Ok(object) => object,
            Err(_) => {
                let value = match js::String::from_str(ctx.clone(), &error.message) {
                    Ok(text) => text.into_value(),
                    Err(_) => js::Value::new_undefined(ctx.clone()),
                };
                return ctx.throw(value);
            }
        };
        if let Some(errcode) = error.errcode {
            let _ = object.set("errcode", errcode);
        }
        if let Some(errstr) = &error.errstr {
            let _ = object.set("errstr", errstr.as_str());
        }
        return ctx.throw(object.into_value());
    }
    let mut node_error = NodeError::new(error.code, error.message.as_str());
    node_error.name = error.name;
    throw_node_error_value(ctx, &node_error)
}

/// Convert one JavaScript value to the SQLite value it binds.
fn value_to_sql(value: &js::Value<'_>) -> Result<Value, NodeError> {
    if value.is_null() || value.is_undefined() {
        return Ok(Value::Null);
    }
    if let Some(boolean) = value.as_bool() {
        return Ok(Value::Integer(i64::from(boolean)));
    }
    if let Some(number) = value.as_number() {
        // Node binds every JavaScript number as a double; SQLite's column affinity decides the
        // storage class. `NaN` is stored as NULL by `sqlite3_bind_double`.
        return Ok(if number.is_nan() {
            Value::Null
        } else {
            Value::Real(number)
        });
    }
    if let Some(bigint) = value.as_big_int() {
        return match bigint.clone().to_i64() {
            Ok(integer) => Ok(Value::Integer(integer)),
            Err(_) => Err(NodeError::new(
                "ERR_INVALID_ARG_VALUE",
                "BigInt value is too large to bind.",
            )),
        };
    }
    if let Some(string) = value.as_string() {
        return string.to_string().map(Value::Text).map_err(|_| {
            NodeError::new("ERR_INVALID_ARG_VALUE", "The string is not valid UTF-8.")
        });
    }
    if let Some(object) = value.as_object() {
        if let Some(array) = object.as_typed_array::<u8>() {
            // SAFETY: the slice aliases the engine's backing store; it is copied immediately and
            // no JavaScript runs between the borrow and the copy.
            let bytes = if array.is_empty() {
                Vec::new()
            } else {
                unsafe { array.as_slice() }.to_vec()
            };
            return Ok(Value::Blob(bytes));
        }
    }
    if let Some(buffer) = js::ArrayBuffer::from_value(value.clone()) {
        // SAFETY: as above; `as_bytes` returns `None` for a detached buffer.
        let bytes = unsafe { buffer.as_bytes() }
            .map(<[u8]>::to_vec)
            .unwrap_or_default();
        return Ok(Value::Blob(bytes));
    }
    Err(NodeError::invalid_arg_type(
        "value",
        "a valid SQLite value",
        crate::args::type_name(value),
    ))
}

/// Convert one SQLite value into the JavaScript value it reads as.
fn value_to_js<'js>(
    ctx: &js::Ctx<'js>,
    value: Value,
    big_ints: bool,
) -> js::Result<js::Value<'js>> {
    Ok(match value {
        Value::Null => js::Value::new_null(ctx.clone()),
        Value::Integer(integer) => {
            if big_ints {
                js::BigInt::from_i64(ctx.clone(), integer)?.into_value()
            } else {
                (integer as f64).into_js(ctx)?
            }
        }
        Value::Real(real) => real.into_js(ctx)?,
        Value::Text(text) => text.into_js(ctx)?,
        Value::Blob(bytes) => js::TypedArray::<u8>::new(ctx.clone(), bytes)?.into_value(),
    })
}

/// One row as a JavaScript array of values. `all`/`first`/`begin` cross the boundary once per row,
/// not once per cell.
fn row_to_js<'js>(
    ctx: &js::Ctx<'js>,
    row: Vec<Value>,
    big_ints: bool,
) -> js::Result<js::Array<'js>> {
    let array = js::Array::new(ctx.clone())?;
    for (index, value) in row.into_iter().enumerate() {
        array.set(index, value_to_js(ctx, value, big_ints)?)?;
    }
    Ok(array)
}

fn row_value<'js>(
    ctx: &js::Ctx<'js>,
    row: Option<Vec<Value>>,
    big_ints: bool,
) -> js::Result<js::Value<'js>> {
    match row {
        Some(row) => Ok(row_to_js(ctx, row, big_ints)?.into_value()),
        None => Ok(js::Value::new_null(ctx.clone())),
    }
}

/// Read the `open` options object the JavaScript layer builds.
fn read_options(options: &js::Object<'_>) -> js::Result<OpenOptions> {
    let mut settings = OpenOptions::default();
    let value: js::Value = options.get("readOnly")?;
    if let Some(flag) = value.as_bool() {
        settings.read_only = flag;
    }
    let value: js::Value = options.get("foreignKeys")?;
    if let Some(flag) = value.as_bool() {
        settings.foreign_keys = flag;
    }
    let value: js::Value = options.get("doubleQuotedStrings")?;
    if let Some(flag) = value.as_bool() {
        settings.double_quoted_strings = flag;
    }
    let value: js::Value = options.get("defensive")?;
    if let Some(flag) = value.as_bool() {
        settings.defensive = flag;
    }
    let value: js::Value = options.get("allowExtension")?;
    if let Some(flag) = value.as_bool() {
        settings.allow_extension = flag;
    }
    let value: js::Value = options.get("timeout")?;
    if let Some(timeout) = value.as_number() {
        settings.timeout_ms = timeout.max(0.0).min(f64::from(u32::MAX)) as u32;
    }
    let value: js::Value = options.get("limits")?;
    if let Some(limits) = value.as_array() {
        for index in 0..limits.len() {
            let pair: js::Array = limits.get(index)?;
            let name: String = pair.get(0)?;
            let value: f64 = pair.get(1)?;
            if let Some(limit) = Limit::from_name(&name) {
                // `Infinity` is the JavaScript spelling of "reset to SQLite's hard maximum".
                let value = if value >= f64::from(i32::MAX) {
                    i32::MAX
                } else {
                    value as i32
                };
                settings.limits.push((limit, value));
            }
        }
    }
    Ok(settings)
}

/// The database file's authority (ADR-0011 §5.3, §5.4 row 11).
///
/// Opening needs `fs.read` on the path, plus `fs.write` unless the open is `readOnly`. A write
/// grant on the database implicitly covers exactly its three side files, so they are not checked
/// against the policy; because SQLite opens them itself, a symlink beside the database is refused
/// instead. `:memory:` has no path and is exempt.
fn check_open(
    ctx: &js::Ctx<'_>,
    permit: &ln_io::Permit,
    path: &str,
    settings: &OpenOptions,
) -> js::Result<Option<PathBuf>> {
    if !permit.enforced() || path == ":memory:" || path.is_empty() {
        return Ok(None);
    }
    if is_file_uri(path) {
        // SQLite parses a `file:` URI itself, so the checked string and the opened string would
        // differ. Under a policy the URI form is refused: a plain path is the only spelling whose
        // resolution the gate can vouch for.
        return Err(throw_node_error_value(
            ctx,
            &NodeError::access_denied(
                if settings.read_only {
                    "fs.read"
                } else {
                    "fs.write"
                },
                path.to_owned(),
                "file: URIs are not supported under a policy",
            ),
        ));
    }
    let resolved = if settings.read_only {
        permit.resolve_read(Path::new(path), "open")
    } else {
        permit.resolve_create(Path::new(path), "open")
    }
    .map_err(|error| throw_node_error_value(ctx, &error))?;
    permit
        .check(&Request::Path {
            capability: Capability::FsRead,
            resolved: &resolved,
        })
        .map_err(|error| throw_node_error_value(ctx, &error))?;
    if !settings.read_only {
        permit
            .check(&Request::Path {
                capability: Capability::FsWrite,
                resolved: &resolved,
            })
            .map_err(|error| throw_node_error_value(ctx, &error))?;
    }
    for suffix in ["-journal", "-wal", "-shm"] {
        let mut side = resolved.as_os_str().to_os_string();
        side.push(suffix);
        let side = PathBuf::from(side);
        if std::fs::symlink_metadata(&side)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err(throw_node_error_value(
                ctx,
                &NodeError::access_denied(
                    "fs.write",
                    side.display().to_string(),
                    "a symlink sits beside a granted database",
                ),
            ));
        }
    }
    if settings.allow_extension {
        permit
            .check(&Request::Toggle {
                capability: Capability::FfiLoad,
            })
            .map_err(|error| throw_node_error_value(ctx, &error))?;
    }
    Ok(Some(resolved))
}

/// SQLite's `file:` URI prefix, which `SQLITE_OPEN_URI` parses after the gate has seen the string.
fn is_file_uri(path: &str) -> bool {
    path.get(..5)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file:"))
}

pub(super) fn install<'js>(
    ctx: &js::Ctx<'js>,
    host: &js::Object<'js>,
    state: &HostState,
) -> js::Result<()> {
    let sqlite = js::Object::new(ctx.clone())?;

    {
        let permit = state.permit.clone();
        let state = state.sqlite.clone();
        sqlite.set(
            "open",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      path: String,
                      options: js::Object<'js>|
                      -> js::Result<f64> {
                    let settings = read_options(&options)?;
                    let resolved = check_open(&ctx, &permit, &path, &settings)?;
                    let target = resolved.as_deref().unwrap_or_else(|| Path::new(&path));
                    let database = Database::open(target, &settings)
                        .map_err(|error| throw_sqlite(&ctx, &error))?;
                    Ok(f64::from(state.add_connection(database)))
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "close",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: u32| -> js::Result<()> {
                    let database = state
                        .take_connection(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    state.drop_statements_of(&database);
                    state.drop_sessions_of(&database);
                    let _scope = CallbackScope::enter(&ctx);
                    let result = database.borrow_mut().close();
                    finish_call(&ctx, result)?;
                    Ok(())
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "exec",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: u32, sql: String| -> js::Result<()> {
                    let database = state
                        .connection(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let _scope = CallbackScope::enter(&ctx);
                    let result = database.borrow().exec(&sql);
                    finish_call(&ctx, result)
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "prepare",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      id: u32,
                      sql: String,
                      persistent: bool|
                      -> js::Result<f64> {
                    let database = state
                        .connection(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let _scope = CallbackScope::enter(&ctx);
                    let statement =
                        finish_call(&ctx, database.borrow_mut().prepare(&sql, persistent))?;
                    Ok(f64::from(state.add_statement(database.clone(), statement)))
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "finalize",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: u32| -> js::Result<()> {
                    let entry = state
                        .take_statement(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let _scope = CallbackScope::enter(&ctx);
                    let result = entry.database.borrow_mut().finalize(entry.id);
                    finish_call(&ctx, result)
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "bind",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      id: u32,
                      named: js::Value<'js>,
                      anonymous: js::Array<'js>,
                      allow_bare: bool,
                      allow_unknown: bool|
                      -> js::Result<()> {
                    let (database, statement) = state
                        .statement(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let mut params = Params {
                        named: Vec::new(),
                        anonymous: Vec::new(),
                        options: BindOptions {
                            allow_bare_named: allow_bare,
                            allow_unknown_named: allow_unknown,
                        },
                    };
                    if let Some(entries) = named.as_array() {
                        for index in 0..entries.len() {
                            let pair: js::Array = entries.get(index)?;
                            let key: String = pair.get(0)?;
                            let value: js::Value = pair.get(1)?;
                            let value = value_to_sql(&value)
                                .map_err(|error| throw_node_error_value(&ctx, &error))?;
                            params.named.push((key, value));
                        }
                    }
                    for index in 0..anonymous.len() {
                        let value: js::Value = anonymous.get(index)?;
                        params.anonymous.push(
                            value_to_sql(&value)
                                .map_err(|error| throw_node_error_value(&ctx, &error))?,
                        );
                    }
                    let result = database
                        .borrow_mut()
                        .bind(statement, &params)
                        .map_err(|error| throw_sqlite(&ctx, &error));
                    result
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "run",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: u32, big_ints: bool| -> js::Result<js::Object<'js>> {
                    let (database, statement) = state
                        .statement(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let _scope = CallbackScope::enter(&ctx);
                    let result = finish_call(&ctx, database.borrow_mut().run(statement))?;
                    let object = js::Object::new(ctx.clone())?;
                    if big_ints {
                        object.set(
                            "changes",
                            js::BigInt::from_i64(ctx.clone(), result.changes)?,
                        )?;
                        object.set(
                            "lastInsertRowid",
                            js::BigInt::from_i64(ctx.clone(), result.last_insert_rowid)?,
                        )?;
                    } else {
                        object.set("changes", result.changes as f64)?;
                        object.set("lastInsertRowid", result.last_insert_rowid as f64)?;
                    }
                    Ok(object)
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "all",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: u32, big_ints: bool| -> js::Result<js::Array<'js>> {
                    let (database, statement) = state
                        .statement(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let _scope = CallbackScope::enter(&ctx);
                    let rows = finish_call(&ctx, database.borrow_mut().all(statement, big_ints))?;
                    let array = js::Array::new(ctx.clone())?;
                    for (index, row) in rows.into_iter().enumerate() {
                        array.set(index, row_to_js(&ctx, row, big_ints)?)?;
                    }
                    Ok(array)
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "first",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: u32, big_ints: bool| -> js::Result<js::Value<'js>> {
                    let (database, statement) = state
                        .statement(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let _scope = CallbackScope::enter(&ctx);
                    let row = finish_call(&ctx, database.borrow_mut().first(statement, big_ints))?;
                    row_value(&ctx, row, big_ints)
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "begin",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: u32, big_ints: bool| -> js::Result<js::Object<'js>> {
                    let (database, statement) = state
                        .statement(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let _scope = CallbackScope::enter(&ctx);
                    let (generation, row) =
                        finish_call(&ctx, database.borrow_mut().begin(statement, big_ints))?;
                    let object = js::Object::new(ctx.clone())?;
                    object.set("generation", generation.value() as f64)?;
                    object.set("row", row_value(&ctx, row, big_ints)?)?;
                    Ok(object)
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "next",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      id: u32,
                      generation: f64,
                      big_ints: bool|
                      -> js::Result<js::Value<'js>> {
                    let (database, statement) = state
                        .statement(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let _scope = CallbackScope::enter(&ctx);
                    let row = finish_call(
                        &ctx,
                        database.borrow_mut().next(
                            statement,
                            Generation::from_raw(generation as u64),
                            big_ints,
                        ),
                    )?;
                    row_value(&ctx, row, big_ints)
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "finish",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: u32, generation: f64| -> js::Result<()> {
                    let (database, statement) = state
                        .statement(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let _scope = CallbackScope::enter(&ctx);
                    let result = database
                        .borrow_mut()
                        .finish(statement, Generation::from_raw(generation as u64));
                    finish_call(&ctx, result)
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "columns",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: u32| -> js::Result<js::Array<'js>> {
                    let (database, statement) = state
                        .statement(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let columns = database
                        .borrow()
                        .columns(statement)
                        .map_err(|error| throw_sqlite(&ctx, &error))?;
                    let array = js::Array::new(ctx.clone())?;
                    for (index, column) in columns.into_iter().enumerate() {
                        let object = js::Object::new(ctx.clone())?;
                        object.set("column", column.column)?;
                        object.set("database", column.database)?;
                        object.set("name", column.name)?;
                        object.set("table", column.table)?;
                        object.set("type", column.kind)?;
                        array.set(index, object)?;
                    }
                    Ok(array)
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "stat",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: u32, name: String| -> js::Result<f64> {
                    let stat = Stat::from_name(&name).ok_or_else(|| {
                        let error = NodeError::new(
                            "ERR_INVALID_ARG_VALUE",
                            "The \"counter\" argument is not a valid statistic name.",
                        );
                        throw_node_error_value(&ctx, &error)
                    })?;
                    let (database, statement) = state
                        .statement(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let value = database
                        .borrow()
                        .stat(statement, stat)
                        .map_err(|error| throw_sqlite(&ctx, &error))?;
                    Ok(value as f64)
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "resetStats",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: u32| -> js::Result<()> {
                    let (database, statement) = state
                        .statement(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let result = database
                        .borrow_mut()
                        .reset_stats(statement)
                        .map_err(|error| throw_sqlite(&ctx, &error));
                    result
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "sourceSQL",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: u32| -> js::Result<String> {
                    let (database, statement) = state
                        .statement(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let result = database
                        .borrow()
                        .source_sql(statement)
                        .map_err(|error| throw_sqlite(&ctx, &error));
                    result
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "expandedSQL",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: u32| -> js::Result<String> {
                    let (database, statement) = state
                        .statement(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let result = database
                        .borrow()
                        .expanded_sql(statement)
                        .map_err(|error| throw_sqlite(&ctx, &error));
                    result
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "isOpen",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: u32| -> js::Result<bool> {
                    let database = state
                        .connection(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let open = database.borrow().is_open();
                    Ok(open)
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "isTransaction",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: u32| -> js::Result<bool> {
                    let database = state
                        .connection(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let result = database
                        .borrow()
                        .is_transaction()
                        .map_err(|error| throw_sqlite(&ctx, &error));
                    result
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "location",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      id: u32,
                      database_name: String|
                      -> js::Result<js::Value<'js>> {
                    let database = state
                        .connection(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let location = database
                        .borrow()
                        .location(&database_name)
                        .map_err(|error| throw_sqlite(&ctx, &error))?;
                    match location {
                        Some(path) => path.into_js(&ctx),
                        None => Ok(js::Value::new_null(ctx.clone())),
                    }
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "serialize",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      id: u32,
                      database_name: String|
                      -> js::Result<js::TypedArray<'js, u8>> {
                    let database = state
                        .connection(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let bytes = database
                        .borrow()
                        .serialize(&database_name)
                        .map_err(|error| throw_sqlite(&ctx, &error))?;
                    js::TypedArray::<u8>::new(ctx.clone(), bytes)
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "deserialize",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      id: u32,
                      database_name: String,
                      buffer: js::Value<'js>|
                      -> js::Result<()> {
                    let bytes = args::bytes(Some(&buffer), "buffer")
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let database = state
                        .connection(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    database
                        .borrow_mut()
                        .deserialize(&database_name, bytes)
                        .map_err(|error| throw_sqlite(&ctx, &error))?;
                    state.drop_statements_of(&database);
                    Ok(())
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "limit",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: u32, name: String| -> js::Result<f64> {
                    let limit = Limit::from_name(&name).ok_or_else(|| {
                        let error =
                            NodeError::new("ERR_INVALID_ARG_VALUE", "The limit name is not valid.");
                        throw_node_error_value(&ctx, &error)
                    })?;
                    let database = state
                        .connection(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let value = database
                        .borrow()
                        .limit(limit)
                        .map_err(|error| throw_sqlite(&ctx, &error))?;
                    Ok(f64::from(value))
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "setLimit",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: u32, name: String, value: f64| -> js::Result<()> {
                    let limit = Limit::from_name(&name).ok_or_else(|| {
                        let error =
                            NodeError::new("ERR_INVALID_ARG_VALUE", "The limit name is not valid.");
                        throw_node_error_value(&ctx, &error)
                    })?;
                    let database = state
                        .connection(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let value = if value >= f64::from(i32::MAX) {
                        i32::MAX
                    } else {
                        value as i32
                    };
                    database
                        .borrow_mut()
                        .set_limit(limit, value)
                        .map_err(|error| throw_sqlite(&ctx, &error))?;
                    Ok(())
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "enableDefensive",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: u32, active: bool| -> js::Result<()> {
                    let database = state
                        .connection(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let result = database
                        .borrow_mut()
                        .set_defensive(active)
                        .map_err(|error| throw_sqlite(&ctx, &error));
                    result
                },
            )?,
        )?;
    }

    {
        let permit = state.permit.clone();
        let state = state.sqlite.clone();
        sqlite.set(
            "backupInit",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      source_id: u32,
                      path: String,
                      source_name: String,
                      target_name: String|
                      -> js::Result<f64> {
                    let source = state
                        .connection(source_id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    // A backup writes a new database: the target needs `fs.write`, resolved as a
                    // create because the file usually does not exist yet. The resolved path is
                    // what `Backup::start` opens, so check and open cannot disagree.
                    let target = if permit.enforced() {
                        if is_file_uri(&path) {
                            return Err(throw_node_error_value(
                                &ctx,
                                &NodeError::access_denied(
                                    "fs.write",
                                    path.clone(),
                                    "file: URIs are not supported under a policy",
                                ),
                            ));
                        }
                        let resolved = permit
                            .resolve_create(Path::new(&path), "open")
                            .map_err(|error| throw_node_error_value(&ctx, &error))?;
                        permit
                            .check(&Request::Path {
                                capability: Capability::FsWrite,
                                resolved: &resolved,
                            })
                            .map_err(|error| throw_node_error_value(&ctx, &error))?;
                        resolved
                    } else {
                        PathBuf::from(&path)
                    };
                    let backup =
                        Backup::start(&source.borrow(), &target, &source_name, &target_name)
                            .map_err(|error| throw_sqlite(&ctx, &error))?;
                    Ok(f64::from(state.add_backup(BackupEntry {
                        _source: source,
                        backup: RefCell::new(backup),
                    })))
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "backupStep",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: u32, pages: f64| -> js::Result<js::Object<'js>> {
                    let entry = {
                        let inner = state.inner.borrow();
                        inner.backups.get(id as usize).and_then(|entry| {
                            entry
                                .as_ref()
                                .map(|entry| entry.backup.borrow_mut().step(pages as u32))
                        })
                    };
                    let step = entry
                        .ok_or_else(|| {
                            throw_node_error_value(
                                &ctx,
                                &invalid_state("backup is no longer active"),
                            )
                        })?
                        .map_err(|error| throw_sqlite(&ctx, &error))?;
                    let object = js::Object::new(ctx.clone())?;
                    match step {
                        BackupStep::Done { page_count } => {
                            object.set("done", true)?;
                            object.set("totalPages", page_count as f64)?;
                            object.set("remainingPages", 0.0)?;
                        }
                        BackupStep::More {
                            page_count,
                            remaining,
                        } => {
                            object.set("done", false)?;
                            object.set("totalPages", page_count as f64)?;
                            object.set("remainingPages", remaining as f64)?;
                        }
                    }
                    Ok(object)
                },
            )?,
        )?;
    }

    {
        let state = state.sqlite.clone();
        sqlite.set(
            "backupFinish",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: u32| -> js::Result<f64> {
                    let entry = state
                        .take_backup(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let backup = entry.backup.into_inner();
                    // Keep the source connection alive until `finish` returns.
                    let source = entry._source;
                    let pages = backup
                        .finish()
                        .map_err(|error| throw_sqlite(&ctx, &error))?;
                    drop(source);
                    Ok(pages as f64)
                },
            )?,
        )?;
    }

    {
        // `process.versions.sqlite`; the JavaScript layer reads it once and stores a string.
        sqlite.set(
            "version",
            js::Function::new(ctx.clone(), move || -> js::Result<String> {
                Ok(ln_sqlite::version().to_owned())
            })?,
        )?;
    }

    callbacks::install(ctx, &sqlite, state)?;

    host.set("sqlite", sqlite)?;
    Ok(())
}
