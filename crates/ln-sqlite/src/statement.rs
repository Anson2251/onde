//! Statement-level helpers: parameter resolution, binding, row reading, metadata and counters.
//!
//! Every function here takes the raw `sqlite3_stmt` that [`crate::Database`] owns. The pointer is
//! valid for the duration of the call by the crate invariant (docs in `lib.rs`); no function here
//! stores it.

use std::ffi::c_void;

use rusqlite::ffi;

use crate::error::{Error, Result};
use crate::sqlite_transient;
use crate::value::Value;

/// The index of a prepared statement inside its connection's slot table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct StmtId(pub(crate) u32);

/// Distinguishes one execution of a statement from the next.
///
/// An iterator captures it when it starts; a later bind (which always precedes a re-execution)
/// bumps it, and `next` on the stale iterator is what Node reports as
/// `ERR_INVALID_STATE: iterator was invalidated`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Generation(u64);

impl Generation {
    pub fn from_raw(value: u64) -> Self {
        Generation(value)
    }

    pub fn value(self) -> u64 {
        self.0
    }
}

/// One entry returned by `statement.columns()`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Column {
    /// The result name (`AS` alias when present).
    pub name: String,
    /// The declared column name, `None` for an expression.
    pub column: Option<String>,
    /// The table name, `None` for an expression.
    pub table: Option<String>,
    /// The attached database name, `None` for an expression.
    pub database: Option<String>,
    /// The declared type, `None` for an expression.
    pub kind: Option<String>,
}

/// What `statement.run()` reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunResult {
    /// `sqlite3_changes64` after the step.
    pub changes: i64,
    /// `sqlite3_last_insert_rowid` after the step.
    pub last_insert_rowid: i64,
}

/// The runtime counters Node exposes through `statement.stat(name)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stat {
    FullscanStep,
    Sort,
    Autoindex,
    VmStep,
    Reprepare,
    Run,
    FilterMiss,
    FilterHit,
    Memused,
}

impl Stat {
    pub fn from_name(name: &str) -> Option<Self> {
        Some(match name {
            "fullscanStep" => Stat::FullscanStep,
            "sort" => Stat::Sort,
            "autoindex" => Stat::Autoindex,
            "vmStep" => Stat::VmStep,
            "reprepare" => Stat::Reprepare,
            "run" => Stat::Run,
            "filterMiss" => Stat::FilterMiss,
            "filterHit" => Stat::FilterHit,
            "memused" => Stat::Memused,
            _ => return None,
        })
    }

    pub fn name(self) -> &'static str {
        match self {
            Stat::FullscanStep => "fullscanStep",
            Stat::Sort => "sort",
            Stat::Autoindex => "autoindex",
            Stat::VmStep => "vmStep",
            Stat::Reprepare => "reprepare",
            Stat::Run => "run",
            Stat::FilterMiss => "filterMiss",
            Stat::FilterHit => "filterHit",
            Stat::Memused => "memused",
        }
    }

    fn code(self) -> i32 {
        match self {
            Stat::FullscanStep => ffi::SQLITE_STMTSTATUS_FULLSCAN_STEP,
            Stat::Sort => ffi::SQLITE_STMTSTATUS_SORT,
            Stat::Autoindex => ffi::SQLITE_STMTSTATUS_AUTOINDEX,
            Stat::VmStep => ffi::SQLITE_STMTSTATUS_VM_STEP,
            Stat::Reprepare => ffi::SQLITE_STMTSTATUS_REPREPARE,
            Stat::Run => ffi::SQLITE_STMTSTATUS_RUN,
            Stat::FilterMiss => ffi::SQLITE_STMTSTATUS_FILTER_MISS,
            Stat::FilterHit => ffi::SQLITE_STMTSTATUS_FILTER_HIT,
            Stat::Memused => ffi::SQLITE_STMTSTATUS_MEMUSED,
        }
    }
}

/// `sqlite3_bind_parameter_index` for a name, 0 when the statement has no such parameter.
fn parameter_index(stmt: *mut ffi::sqlite3_stmt, name: &str) -> i32 {
    let Some(name) = crate::cstring(name) else {
        return 0;
    };
    // SAFETY: `name` is NUL-terminated and lives for the call; `stmt` is live by the crate
    // invariant.
    unsafe { ffi::sqlite3_bind_parameter_index(stmt, name.as_ptr()) }
}

/// Resolve one named-parameter key against the statement.
///
/// Mirrors Node's rules (`docs/research/node-sqlite-api.md` §4.1): an exact key wins; with bare
/// names enabled, the key is also tried with each SQLite prefix; more than one match is
/// ambiguous and is an error rather than a guess.
pub(crate) fn resolve_named(
    stmt: *mut ffi::sqlite3_stmt,
    key: &str,
    allow_bare: bool,
) -> Result<Option<i32>> {
    let exact = parameter_index(stmt, key);
    if exact != 0 {
        return Ok(Some(exact));
    }
    let prefixed = key.starts_with(['$', ':', '@']);
    if !allow_bare || prefixed {
        return Ok(None);
    }
    let mut matches: Vec<(i32, String)> = Vec::new();
    for prefix in ['$', ':', '@'] {
        let name = format!("{prefix}{key}");
        let index = parameter_index(stmt, &name);
        if index != 0 && !matches.iter().any(|(other, _)| *other == index) {
            matches.push((index, name));
        }
    }
    match matches.len() {
        0 => Ok(None),
        1 => Ok(Some(matches[0].0)),
        _ => {
            // Node's exact wording: it cannot pick one prefix for the bare name.
            let names: Vec<String> = matches
                .iter()
                .map(|(_, name)| format!("'{name}'"))
                .collect();
            let list = match names.len() {
                2 => format!("{} and {}", names[0], names[1]),
                _ => format!(
                    "{}, and {}",
                    names[..names.len() - 1].join(", "),
                    names[names.len() - 1]
                ),
            };
            Err(Error::invalid_state(format!(
                "Cannot create bare named parameter '{key}' because of conflicting names {list}."
            )))
        }
    }
}

/// The parameter indices a positional argument can bind, in index order.
///
/// Node binds positional arguments to `?` and `?NNN` slots only; `:a`/`$a`/`@a` are never bound
/// positionally (the oracle rejects `SELECT :a` with `.get(7)` as `ERR_SQLITE_ERROR`, errcode 25).
/// `sqlite3_bind_parameter_name` returns NULL for a plain `?` and `"?NNN"` for a numbered one,
/// which is exactly that set.
pub(crate) fn positional_slots(stmt: *mut ffi::sqlite3_stmt) -> Vec<i32> {
    // SAFETY: a pure query on a live statement.
    let count = unsafe { ffi::sqlite3_bind_parameter_count(stmt) };
    let mut slots = Vec::new();
    for index in 1..=count {
        // SAFETY: `index` is within the statement's parameter range.
        let name = unsafe { ffi::sqlite3_bind_parameter_name(stmt, index) };
        if name.is_null() {
            slots.push(index);
            continue;
        }
        // SAFETY: SQLite returns a NUL-terminated name owned by the statement.
        let name = unsafe { std::ffi::CStr::from_ptr(name) };
        if name.to_bytes().starts_with(b"?") {
            slots.push(index);
        }
    }
    slots
}

/// Bind one value at one parameter index.
pub(crate) fn bind_value(
    stmt: *mut ffi::sqlite3_stmt,
    db: *mut ffi::sqlite3,
    index: i32,
    value: &Value,
) -> Result<()> {
    // SAFETY: the statement is live, the index was resolved against this statement, and every
    // buffer passed with SQLITE_TRANSIENT is copied by SQLite before the call returns.
    let result = unsafe {
        match value {
            Value::Null => ffi::sqlite3_bind_null(stmt, index),
            Value::Integer(integer) => ffi::sqlite3_bind_int64(stmt, index, *integer),
            Value::Real(real) => ffi::sqlite3_bind_double(stmt, index, *real),
            Value::Text(text) => {
                let length = i32::try_from(text.len()).map_err(|_| Error::too_large(text.len()))?;
                ffi::sqlite3_bind_text(
                    stmt,
                    index,
                    text.as_ptr().cast(),
                    length,
                    sqlite_transient(),
                )
            }
            Value::Blob(blob) => {
                let length = i32::try_from(blob.len()).map_err(|_| Error::too_large(blob.len()))?;
                ffi::sqlite3_bind_blob(
                    stmt,
                    index,
                    blob.as_ptr().cast::<c_void>(),
                    length,
                    sqlite_transient(),
                )
            }
        }
    };
    if result != ffi::SQLITE_OK {
        return Err(Error::from_db(db, result));
    }
    Ok(())
}

/// Read one column of the current row.
pub(crate) fn read_column(
    stmt: *mut ffi::sqlite3_stmt,
    column: i32,
    big_ints: bool,
) -> Result<Value> {
    // SAFETY: the statement is on a row and `column` is within its result width.
    let kind = unsafe { ffi::sqlite3_column_type(stmt, column) };
    Ok(match kind {
        ffi::SQLITE_NULL => Value::Null,
        ffi::SQLITE_INTEGER => {
            let integer = unsafe { ffi::sqlite3_column_int64(stmt, column) };
            if !big_ints && !is_safe_integer(integer) {
                return Err(Error::integer_out_of_range(integer));
            }
            Value::Integer(integer)
        }
        ffi::SQLITE_FLOAT => Value::Real(unsafe { ffi::sqlite3_column_double(stmt, column) }),
        ffi::SQLITE_TEXT => {
            // SAFETY: the pointer is valid until the next step/reset/finalize on this statement,
            // and the bytes are copied before anything else runs.
            let pointer = unsafe { ffi::sqlite3_column_text(stmt, column) };
            let length = unsafe { ffi::sqlite3_column_bytes(stmt, column) };
            if pointer.is_null() || length <= 0 {
                Value::Text(String::new())
            } else {
                let bytes =
                    unsafe { std::slice::from_raw_parts(pointer.cast::<u8>(), length as usize) };
                Value::Text(String::from_utf8_lossy(bytes).into_owned())
            }
        }
        ffi::SQLITE_BLOB => {
            let pointer = unsafe { ffi::sqlite3_column_blob(stmt, column) };
            let length = unsafe { ffi::sqlite3_column_bytes(stmt, column) };
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

/// Read the current row.
pub(crate) fn read_row(stmt: *mut ffi::sqlite3_stmt, big_ints: bool) -> Result<Vec<Value>> {
    // SAFETY: a pure query on a live statement.
    let width = unsafe { ffi::sqlite3_column_count(stmt) };
    let mut row = Vec::with_capacity(width as usize);
    for column in 0..width {
        row.push(read_column(stmt, column, big_ints)?);
    }
    Ok(row)
}

/// The metadata for every result column.
pub(crate) fn columns(stmt: *mut ffi::sqlite3_stmt) -> Vec<Column> {
    // SAFETY: pure metadata queries on a live prepared statement; every returned pointer is
    // owned by the statement and copied immediately.
    unsafe {
        let count = ffi::sqlite3_column_count(stmt);
        let mut columns = Vec::with_capacity(count as usize);
        for index in 0..count {
            let name = crate::cstr(ffi::sqlite3_column_name(stmt, index)).unwrap_or_default();
            let kind = crate::cstr(ffi::sqlite3_column_decltype(stmt, index));
            let table = crate::cstr(ffi::sqlite3_column_table_name(stmt, index));
            let column = crate::cstr(ffi::sqlite3_column_origin_name(stmt, index));
            let database = crate::cstr(ffi::sqlite3_column_database_name(stmt, index));
            columns.push(Column {
                name,
                column,
                table,
                database,
                kind,
            });
        }
        columns
    }
}

/// `statement.stat(name)`.
pub(crate) fn status(stmt: *mut ffi::sqlite3_stmt, stat: Stat) -> i64 {
    // SAFETY: a pure counter query on a live statement.
    unsafe { ffi::sqlite3_stmt_status(stmt, stat.code(), 0) as i64 }
}

/// `statement.resetStats()`: zero every counter except `memused`, which describes live memory.
pub(crate) fn reset_status(stmt: *mut ffi::sqlite3_stmt) {
    for stat in [
        Stat::FullscanStep,
        Stat::Sort,
        Stat::Autoindex,
        Stat::VmStep,
        Stat::Reprepare,
        Stat::Run,
        Stat::FilterMiss,
        Stat::FilterHit,
    ] {
        // SAFETY: a pure counter reset on a live statement.
        unsafe {
            ffi::sqlite3_stmt_status(stmt, stat.code(), 1);
        }
    }
}

/// `sqlite3_sql`, the text the statement was prepared from.
pub(crate) fn source_sql(stmt: *mut ffi::sqlite3_stmt) -> String {
    // SAFETY: a pure query returning a string owned by the statement.
    crate::cstr(unsafe { ffi::sqlite3_sql(stmt) }).unwrap_or_default()
}

/// `sqlite3_expanded_sql`, the SQL with the last execution's bound values substituted.
pub(crate) fn expanded_sql(stmt: *mut ffi::sqlite3_stmt) -> Result<String> {
    // SAFETY: `sqlite3_expanded_sql` returns a heap string that must be freed with
    // `sqlite3_free`; it is copied first.
    unsafe {
        let pointer = ffi::sqlite3_expanded_sql(stmt);
        if pointer.is_null() {
            return Err(Error::invalid_state("cannot expand the statement's SQL"));
        }
        let text = crate::cstr(pointer).unwrap_or_default();
        ffi::sqlite3_free(pointer.cast());
        Ok(text)
    }
}

fn is_safe_integer(value: i64) -> bool {
    const MAX: i64 = 9_007_199_254_740_991;
    (-MAX..=MAX).contains(&value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stat_names_round_trip() {
        for stat in [
            Stat::FullscanStep,
            Stat::Sort,
            Stat::Autoindex,
            Stat::VmStep,
            Stat::Reprepare,
            Stat::Run,
            Stat::FilterMiss,
            Stat::FilterHit,
            Stat::Memused,
        ] {
            assert_eq!(Stat::from_name(stat.name()), Some(stat));
        }
        assert_eq!(Stat::from_name("fullscanLookup"), None);
    }

    #[test]
    fn safe_integer_bounds() {
        assert!(is_safe_integer(0));
        assert!(is_safe_integer(9_007_199_254_740_991));
        assert!(!is_safe_integer(9_007_199_254_740_992));
        assert!(!is_safe_integer(-9_007_199_254_740_992));
    }
}
