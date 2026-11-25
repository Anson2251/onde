//! One SQLite connection and the prepared statements that belong to it.
//!
//! See the crate docs for the ownership invariant: a statement pointer is valid from
//! [`Database::prepare`] until it is finalized, and the connection outlives every statement. The
//! slot table below is what makes that true; no raw pointer is exposed outside the crate.

use std::path::Path;
use std::time::Duration;

use rusqlite::config::DbConfig;
use rusqlite::ffi;
use rusqlite::{Connection, OpenFlags};

use crate::error::{Error, Result};
use crate::statement::{self, Column, Generation, RunResult, Stat, StmtId};
use crate::value::{Params, Value};
use crate::Limit;

/// How to open a database. Mirrors Node's `Database` constructor options.
#[derive(Debug, Clone)]
pub struct OpenOptions {
    pub read_only: bool,
    /// `PRAGMA foreign_keys` enforcement. Node's default is `true`.
    pub foreign_keys: bool,
    /// `SQLITE_DBCONFIG_DQS_DML`/`DQS_DDL`. Node's default is `false`.
    pub double_quoted_strings: bool,
    /// Busy timeout in milliseconds. Node's default is `0`.
    pub timeout_ms: u32,
    /// `SQLITE_DBCONFIG_DEFENSIVE`. Node's default is `true` since v25.5.0.
    pub defensive: bool,
    /// Whether `enableLoadExtension(true)` may succeed. Node's default is `false`.
    pub allow_extension: bool,
    /// Run-time limits applied at open; an empty list leaves SQLite's defaults.
    pub limits: Vec<(Limit, i32)>,
}

impl Default for OpenOptions {
    fn default() -> Self {
        OpenOptions {
            read_only: false,
            foreign_keys: true,
            double_quoted_strings: false,
            timeout_ms: 0,
            defensive: true,
            allow_extension: false,
            limits: Vec::new(),
        }
    }
}

/// A live connection.
pub struct Database {
    /// `None` after [`Database::close`]; the statements are finalized first.
    pub(crate) connection: Option<Connection>,
    /// `StmtId.0` indexes this table. Slots are never reused, so a stale id fails loudly.
    statements: Vec<Option<StatementSlot>>,
    /// Buffers handed to `sqlite3_deserialize`, which requires them to outlive the connection.
    /// They are freed after the connection closes, in `Database`'s field drop order.
    deserialized: Vec<DeserializedBuffer>,
    /// Live session handles (`createSession`), deleted before the connection closes.
    pub(crate) sessions: Vec<Option<*mut ffi::sqlite3_session>>,
    /// The authorizer's user data; `set_authorizer` owns the allocation and frees it here.
    pub(crate) authorizer_data: Option<*mut std::ffi::c_void>,
    /// Whether the constructor allowed extension loading at all.
    pub(crate) allow_extension: bool,
    /// Whether `enableLoadExtension(true)` has been called.
    pub(crate) extension_enabled: bool,
    /// `sqlite3_module` definitions passed to `sqlite3_create_module_v2`; SQLite keeps the
    /// pointer for the connection's lifetime, so they are freed only after `sqlite3_close`.
    pub(crate) modules: Vec<*mut ffi::sqlite3_module>,
}

struct StatementSlot {
    raw: *mut ffi::sqlite3_stmt,
    generation: u64,
}

struct DeserializedBuffer {
    ptr: *mut u8,
    /// Kept for the allocator's diagnostics; the length is not read after allocation.
    _len: usize,
}

impl Drop for DeserializedBuffer {
    fn drop(&mut self) {
        // SAFETY: allocated by `sqlite3_malloc64` in `deserialize` and freed exactly once here.
        unsafe { ffi::sqlite3_free(self.ptr.cast()) };
    }
}

impl Database {
    /// Open `path` (a file, `":memory:"`, or a `file:` URI) with Node's defaults.
    pub fn open(path: &Path, options: &OpenOptions) -> Result<Self> {
        let mut flags = OpenFlags::SQLITE_OPEN_URI;
        if options.read_only {
            flags |= OpenFlags::SQLITE_OPEN_READ_ONLY;
        } else {
            flags |= OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE;
        }
        let connection = Connection::open_with_flags(path, flags).map_err(Error::from_rusqlite)?;
        connection
            .busy_timeout(Duration::from_millis(u64::from(options.timeout_ms)))
            .map_err(Error::from_rusqlite)?;
        for (config, value) in [
            (DbConfig::SQLITE_DBCONFIG_ENABLE_FKEY, options.foreign_keys),
            (
                DbConfig::SQLITE_DBCONFIG_DQS_DML,
                options.double_quoted_strings,
            ),
            (
                DbConfig::SQLITE_DBCONFIG_DQS_DDL,
                options.double_quoted_strings,
            ),
            (DbConfig::SQLITE_DBCONFIG_DEFENSIVE, options.defensive),
        ] {
            connection
                .set_db_config(config, value)
                .map_err(Error::from_rusqlite)?;
        }
        let mut database = Database {
            connection: Some(connection),
            statements: Vec::new(),
            deserialized: Vec::new(),
            sessions: Vec::new(),
            authorizer_data: None,
            allow_extension: options.allow_extension,
            extension_enabled: false,
            modules: Vec::new(),
        };
        for (limit, value) in &options.limits {
            database.set_limit(*limit, *value)?;
        }
        Ok(database)
    }

    pub fn is_open(&self) -> bool {
        self.connection.is_some()
    }

    /// The raw connection handle. `pub(crate)`: the invariant stays inside the crate.
    pub(crate) fn handle(&self) -> Result<*mut ffi::sqlite3> {
        match &self.connection {
            // SAFETY: a pure accessor; the connection is live while `Some`.
            Some(connection) => Ok(unsafe { connection.handle() }),
            None => Err(Error::invalid_state("database is not open")),
        }
    }

    /// `database.exec(sql)`: every statement, stopping at the first error (earlier work stays).
    pub fn exec(&self, sql: &str) -> Result<()> {
        let connection = self
            .connection
            .as_ref()
            .ok_or_else(|| Error::invalid_state("database is not open"))?;
        connection.execute_batch(sql).map_err(Error::from_rusqlite)
    }

    /// `database.prepare(sql)`: compile the first statement and ignore the tail, as Node does.
    pub fn prepare(&mut self, sql: &str, persistent: bool) -> Result<StmtId> {
        let db = self.handle()?;
        let length = i32::try_from(sql.len())
            .map_err(|_| Error::invalid_arg_value("SQL text is too long"))?;
        let flags = if persistent {
            ffi::SQLITE_PREPARE_PERSISTENT
        } else {
            0
        };
        let mut raw = std::ptr::null_mut();
        let mut tail: *const std::ffi::c_char = std::ptr::null();
        // SAFETY: `sql` lives for the call, `raw`/`tail` are valid out-parameters, and the
        // statement is finalized by this crate before the connection is dropped.
        let result = unsafe {
            ffi::sqlite3_prepare_v3(db, sql.as_ptr().cast(), length, flags, &mut raw, &mut tail)
        };
        if result != ffi::SQLITE_OK {
            return Err(Error::from_db(db, result));
        }
        if raw.is_null() {
            return Err(Error::invalid_arg_value(
                "The SQL query contains no statements.",
            ));
        }
        self.statements
            .push(Some(StatementSlot { raw, generation: 0 }));
        Ok(StmtId((self.statements.len() - 1) as u32))
    }

    /// `statement.close()`: finalize one statement. A second call is a state error.
    pub fn finalize(&mut self, id: StmtId) -> Result<()> {
        let slot = self
            .statements
            .get_mut(id.0 as usize)
            .and_then(Option::take)
            .ok_or_else(|| Error::invalid_state("statement has been finalized"))?;
        // SAFETY: the slot owned the only reference; `sqlite3_finalize` resets an active
        // statement and frees it, which is legal.
        let result = unsafe { ffi::sqlite3_finalize(slot.raw) };
        if result != ffi::SQLITE_OK {
            let db = self.handle()?;
            return Err(Error::from_db(db, result));
        }
        Ok(())
    }

    fn finalize_all(&mut self) {
        for slot in &mut self.statements {
            if let Some(slot) = slot.take() {
                // SAFETY: as in `finalize`; the result of a close-path finalize is not actionable.
                unsafe {
                    ffi::sqlite3_finalize(slot.raw);
                }
            }
        }
    }

    fn slot(&self, id: StmtId) -> Result<&StatementSlot> {
        self.statements
            .get(id.0 as usize)
            .and_then(Option::as_ref)
            .ok_or_else(|| Error::invalid_state("statement has been finalized"))
    }

    fn raw(&self, id: StmtId) -> Result<*mut ffi::sqlite3_stmt> {
        Ok(self.slot(id)?.raw)
    }

    /// Bind one execution's parameters. Bindings from the previous execution are cleared first;
    /// that is what makes `expandedSQL` describe this call and not the last one.
    pub fn bind(&mut self, id: StmtId, params: &Params) -> Result<()> {
        let stmt = self.raw(id)?;
        let db = self.handle()?;
        // SAFETY: a live statement; clearing bindings is always allowed.
        unsafe {
            ffi::sqlite3_clear_bindings(stmt);
        }
        for (key, value) in &params.named {
            match statement::resolve_named(stmt, key, params.options.allow_bare_named)? {
                Some(index) => statement::bind_value(stmt, db, index, value)?,
                None if params.options.allow_unknown_named => {}
                None => {
                    return Err(Error::invalid_state(format!(
                        "Unknown named parameter '{key}'"
                    )))
                }
            }
        }
        let slots = statement::positional_slots(stmt);
        for (position, value) in params.anonymous.iter().enumerate() {
            let Some(index) = slots.get(position) else {
                return Err(Error::range());
            };
            statement::bind_value(stmt, db, *index, value)?;
        }
        if let Some(slot) = self
            .statements
            .get_mut(id.0 as usize)
            .and_then(Option::as_mut)
        {
            slot.generation = slot.generation.wrapping_add(1);
        }
        Ok(())
    }

    /// `statement.run()`: one step, then reset. Bindings stay, so `expandedSQL` keeps them.
    pub fn run(&mut self, id: StmtId) -> Result<RunResult> {
        let stmt = self.raw(id)?;
        let db = self.handle()?;
        // SAFETY: a live, bound statement.
        let result = unsafe { ffi::sqlite3_step(stmt) };
        let outcome = if result == ffi::SQLITE_ROW || result == ffi::SQLITE_DONE {
            // SAFETY: pure accessors on the live connection.
            Ok(RunResult {
                changes: unsafe { ffi::sqlite3_changes64(db) },
                last_insert_rowid: unsafe { ffi::sqlite3_last_insert_rowid(db) },
            })
        } else {
            Err(Error::from_db(db, result))
        };
        // SAFETY: reset is always allowed and keeps the bindings for `expandedSQL`.
        unsafe {
            ffi::sqlite3_reset(stmt);
        }
        outcome
    }

    /// `statement.all()`: step to the end and collect every row.
    pub fn all(&mut self, id: StmtId, big_ints: bool) -> Result<Vec<Vec<Value>>> {
        let stmt = self.raw(id)?;
        let db = self.handle()?;
        let mut rows = Vec::new();
        let outcome = loop {
            // SAFETY: a live, bound statement.
            match unsafe { ffi::sqlite3_step(stmt) } {
                ffi::SQLITE_ROW => match statement::read_row(stmt, big_ints) {
                    Ok(row) => rows.push(row),
                    Err(error) => break Err(error),
                },
                ffi::SQLITE_DONE => break Ok(()),
                result => break Err(Error::from_db(db, result)),
            }
        };
        // SAFETY: reset after draining (or on error) keeps the bindings for `expandedSQL`.
        unsafe {
            ffi::sqlite3_reset(stmt);
        }
        outcome.map(|()| rows)
    }

    /// `statement.get()`: one step, read the row if there is one, then reset.
    pub fn first(&mut self, id: StmtId, big_ints: bool) -> Result<Option<Vec<Value>>> {
        let stmt = self.raw(id)?;
        let db = self.handle()?;
        // SAFETY: a live, bound statement.
        let result = unsafe { ffi::sqlite3_step(stmt) };
        let outcome = match result {
            ffi::SQLITE_ROW => statement::read_row(stmt, big_ints).map(Some),
            ffi::SQLITE_DONE => Ok(None),
            result => Err(Error::from_db(db, result)),
        };
        // SAFETY: reset is always allowed.
        unsafe {
            ffi::sqlite3_reset(stmt);
        }
        outcome
    }

    /// First step of an iterator: the generation is captured so a later re-execution can
    /// invalidate the iterator (Node's `iterator was invalidated`).
    pub fn begin(
        &mut self,
        id: StmtId,
        big_ints: bool,
    ) -> Result<(Generation, Option<Vec<Value>>)> {
        let generation = Generation::from_raw(self.slot(id)?.generation);
        let stmt = self.raw(id)?;
        let db = self.handle()?;
        // SAFETY: a live, bound statement.
        let result = unsafe { ffi::sqlite3_step(stmt) };
        match result {
            ffi::SQLITE_ROW => Ok((generation, Some(statement::read_row(stmt, big_ints)?))),
            ffi::SQLITE_DONE => {
                // SAFETY: reset is always allowed.
                unsafe {
                    ffi::sqlite3_reset(stmt);
                }
                Ok((generation, None))
            }
            result => {
                // SAFETY: reset is always allowed.
                unsafe {
                    ffi::sqlite3_reset(stmt);
                }
                Err(Error::from_db(db, result))
            }
        }
    }

    /// Next step of an iterator.
    pub fn next(
        &mut self,
        id: StmtId,
        generation: Generation,
        big_ints: bool,
    ) -> Result<Option<Vec<Value>>> {
        if self.slot(id)?.generation != generation.value() {
            return Err(Error::invalid_state("iterator was invalidated"));
        }
        let stmt = self.raw(id)?;
        let db = self.handle()?;
        // SAFETY: a live statement, validated against its generation.
        let result = unsafe { ffi::sqlite3_step(stmt) };
        match result {
            ffi::SQLITE_ROW => statement::read_row(stmt, big_ints).map(Some),
            ffi::SQLITE_DONE => {
                // SAFETY: reset is always allowed.
                unsafe {
                    ffi::sqlite3_reset(stmt);
                }
                Ok(None)
            }
            result => {
                // SAFETY: reset is always allowed.
                unsafe {
                    ffi::sqlite3_reset(stmt);
                }
                Err(Error::from_db(db, result))
            }
        }
    }

    /// Release an iterator's statement. A stale generation is a no-op, not an error: Node's
    /// `return()` on an invalidated iterator returns `{ done: true }`.
    pub fn finish(&mut self, id: StmtId, generation: Generation) -> Result<()> {
        if self.slot(id)?.generation == generation.value() {
            let stmt = self.raw(id)?;
            // SAFETY: reset is always allowed.
            unsafe {
                ffi::sqlite3_reset(stmt);
            }
        }
        Ok(())
    }

    pub fn columns(&self, id: StmtId) -> Result<Vec<Column>> {
        Ok(statement::columns(self.raw(id)?))
    }

    pub fn stat(&self, id: StmtId, stat: Stat) -> Result<i64> {
        Ok(statement::status(self.raw(id)?, stat))
    }

    pub fn reset_stats(&mut self, id: StmtId) -> Result<()> {
        statement::reset_status(self.raw(id)?);
        Ok(())
    }

    pub fn source_sql(&self, id: StmtId) -> Result<String> {
        Ok(statement::source_sql(self.raw(id)?))
    }

    pub fn expanded_sql(&self, id: StmtId) -> Result<String> {
        statement::expanded_sql(self.raw(id)?)
    }

    /// `database.limits.<name>`: the current value, read without changing it.
    pub fn limit(&self, limit: Limit) -> Result<i32> {
        let db = self.handle()?;
        // SAFETY: `-1` is the documented "read the current value" form.
        Ok(unsafe { ffi::sqlite3_limit(db, limit.code(), -1) })
    }

    /// `database.limits.<name> = value`: set it; SQLite clamps to the compile-time maximum.
    pub fn set_limit(&mut self, limit: Limit, value: i32) -> Result<i32> {
        let db = self.handle()?;
        // SAFETY: a pure setter on a live connection.
        Ok(unsafe { ffi::sqlite3_limit(db, limit.code(), value) })
    }

    /// `database.enableDefensive(active)`: flip `SQLITE_DBCONFIG_DEFENSIVE` after open.
    pub fn set_defensive(&mut self, active: bool) -> Result<()> {
        let connection = self
            .connection
            .as_ref()
            .ok_or_else(|| Error::invalid_state("database is not open"))?;
        connection
            .set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, active)
            .map_err(Error::from_rusqlite)?;
        Ok(())
    }

    /// `database.isTransaction`: `sqlite3_get_autocommit() === 0`.
    pub fn is_transaction(&self) -> Result<bool> {
        let db = self.handle()?;
        // SAFETY: a pure query on a live connection.
        Ok(unsafe { ffi::sqlite3_get_autocommit(db) } == 0)
    }

    /// `database.location(dbName)`: `sqlite3_db_filename`, `None` for an in-memory database.
    pub fn location(&self, database: &str) -> Result<Option<String>> {
        let db = self.handle()?;
        let name = crate::cstring(database)
            .ok_or_else(|| Error::invalid_arg_value("database name contains a NUL byte"))?;
        // SAFETY: a pure query; the returned string is owned by the connection.
        let pointer = unsafe { ffi::sqlite3_db_filename(db, name.as_ptr()) };
        // An in-memory database reports an empty string here; Node reports null.
        Ok(crate::cstr(pointer).filter(|location| !location.is_empty()))
    }

    /// `database.serialize(dbName)`: copy SQLite's buffer into an owned `Vec`.
    pub fn serialize(&self, database: &str) -> Result<Vec<u8>> {
        let db = self.handle()?;
        let name = crate::cstring(database)
            .ok_or_else(|| Error::invalid_arg_value("database name contains a NUL byte"))?;
        let mut length: ffi::sqlite3_int64 = 0;
        // SAFETY: `length` is a valid out-parameter; the returned pointer is freed below.
        let pointer = unsafe { ffi::sqlite3_serialize(db, name.as_ptr(), &mut length, 0) };
        if pointer.is_null() {
            let code = unsafe { ffi::sqlite3_errcode(db) };
            return Err(Error::from_db(db, code));
        }
        let bytes = if length <= 0 {
            Vec::new()
        } else {
            // SAFETY: SQLite reports `length` valid bytes at `pointer`; copied before freeing.
            unsafe { std::slice::from_raw_parts(pointer.cast::<u8>(), length as usize).to_vec() }
        };
        // SAFETY: `sqlite3_serialize` memory is released with `sqlite3_free`.
        unsafe {
            ffi::sqlite3_free(pointer.cast());
        }
        Ok(bytes)
    }

    /// `database.deserialize(buffer)`: replace the database, finalizing every statement first
    /// (Node documents that this happens even when deserialization fails).
    pub fn deserialize(&mut self, database: &str, bytes: Vec<u8>) -> Result<()> {
        self.finalize_all();
        let db = self.handle()?;
        let name = crate::cstring(database)
            .ok_or_else(|| Error::invalid_arg_value("database name contains a NUL byte"))?;
        let length = bytes.len();
        if length == 0 {
            return Err(Error::invalid_arg_value(
                "The serialized database is empty.",
            ));
        }
        let size = u64::try_from(length)
            .map_err(|_| Error::invalid_arg_value("The serialized database is too large."))?;
        // SAFETY: SQLite-owned allocation; it stays alive in `deserialized` until close.
        let buffer = unsafe { ffi::sqlite3_malloc64(size) }.cast::<u8>();
        if buffer.is_null() {
            return Err(Error::out_of_range(
                "Out of memory deserializing the database",
            ));
        }
        // SAFETY: `buffer` has room for `length` bytes and does not overlap `bytes`.
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), buffer, length);
        }
        // SAFETY: the buffer is SQLite-allocated, `length` bytes, and is NOT freed by SQLite
        // because `SQLITE_DESERIALIZE_FREEONCLOSE` is not requested; this crate frees it after the
        // connection closes.
        let result = unsafe {
            ffi::sqlite3_deserialize(
                db,
                name.as_ptr(),
                buffer,
                length as ffi::sqlite3_int64,
                length as ffi::sqlite3_int64,
                0,
            )
        };
        if result != ffi::SQLITE_OK {
            // SAFETY: SQLite did not take ownership after a failure.
            unsafe {
                ffi::sqlite3_free(buffer.cast());
            }
            return Err(Error::from_db(db, result));
        }
        self.deserialized.push(DeserializedBuffer {
            ptr: buffer,
            _len: length,
        });
        Ok(())
    }

    /// `database.enableLoadExtension(allow)`: only a database constructed with
    /// `allowExtension: true` may enable it.
    pub fn enable_load_extension(&mut self, allow: bool) -> Result<()> {
        if allow && !self.allow_extension {
            return Err(Error::invalid_state(
                "Cannot enable extension loading because it was disabled at database creation.",
            ));
        }
        let db = self.handle()?;
        // SAFETY: a live connection; the flag only toggles the C API.
        let result = unsafe { ffi::sqlite3_enable_load_extension(db, i32::from(allow)) };
        if result != ffi::SQLITE_OK {
            return Err(Error::from_db(db, result));
        }
        self.extension_enabled = allow;
        Ok(())
    }

    /// `database.loadExtension(path[, entryPoint])`.
    pub fn load_extension(&mut self, path: &str, entry_point: Option<&str>) -> Result<()> {
        if !self.extension_enabled {
            return Err(Error::invalid_state("extension loading is not allowed"));
        }
        let db = self.handle()?;
        let path = crate::cstring(path)
            .ok_or_else(|| Error::invalid_arg_value("Extension path contains a NUL byte."))?;
        let entry = match entry_point {
            Some(entry) => Some(crate::cstring(entry).ok_or_else(|| {
                Error::invalid_arg_value("Extension entry point contains a NUL byte.")
            })?),
            None => None,
        };
        let mut message: *mut std::ffi::c_char = std::ptr::null_mut();
        // SAFETY: both names are valid C strings, `message` is an out-parameter.
        let result = unsafe {
            ffi::sqlite3_load_extension(
                db,
                path.as_ptr(),
                entry
                    .as_ref()
                    .map_or(std::ptr::null(), |entry| entry.as_ptr()),
                &mut message,
            )
        };
        if result != ffi::SQLITE_OK {
            let text = if message.is_null() {
                String::from("extension could not be loaded")
            } else {
                // SAFETY: SQLite allocated the message with its allocator; copied before freeing.
                let text = unsafe { std::ffi::CStr::from_ptr(message) }
                    .to_string_lossy()
                    .into_owned();
                unsafe { ffi::sqlite3_free(message.cast()) };
                text
            };
            return Err(Error::extension(text));
        }
        Ok(())
    }

    /// Close the connection after finalizing every statement. A second close is a state error,
    /// as in Node; `[Symbol.dispose]` is the idempotent spelling on the JavaScript side.
    pub fn close(&mut self) -> Result<()> {
        let Some(connection) = self.connection.take() else {
            return Err(Error::invalid_state("database is not open"));
        };
        self.finalize_all();
        self.drop_sessions();
        self.drop_authorizer();
        if let Err((connection, error)) = connection.close() {
            self.connection = Some(connection);
            return Err(Error::from_rusqlite(error));
        }
        // SQLite no longer references the module definitions once the connection is closed.
        self.drop_modules();
        Ok(())
    }
}

impl Drop for Database {
    fn drop(&mut self) {
        let _ = self.close();
        // `deserialized` is dropped after this function body, i.e. after the connection closed.
    }
}

impl std::fmt::Debug for Database {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Database")
            .field("open", &self.is_open())
            .field("statements", &self.statements.len())
            .finish()
    }
}
