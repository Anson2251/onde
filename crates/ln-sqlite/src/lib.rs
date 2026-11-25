//! SQLite for onde's `node:sqlite`, engine-free and tokio-free.
//!
//! This crate is the whole synchronous contract behind the module: opening a database, preparing
//! statements, binding, stepping, column metadata, limits, serialization and backup. It has no
//! QuickJS and no scheduler, so `cargo test -p ln-sqlite` exercises it directly; the host
//! (`crates/ln-runtime/src/host/sqlite.rs`) is the only thing that turns [`Value`]s into
//! JavaScript and back.
//!
//! # Why statements are raw
//!
//! `rusqlite::Statement<'conn>` borrows its connection, and the host needs a registry that owns
//! both and hands out stable integer ids. There is no safe way to store a statement beside its
//! connection, so the statement layer talks to `rusqlite::ffi` directly and this crate owns the
//! resulting invariant: **a statement pointer is valid from `prepare` until `finalize`/`close`,
//! and the connection outlives it**. [`Database`] enforces that by keeping its statements in a
//! slot table and finalizing every one of them before dropping or closing the connection; no
//! pointer leaves this crate.
//!
//! Everything else — open flags, `exec`, configuration, limits, serialize/deserialize, backup —
//! goes through `rusqlite`'s safe API.

use std::ffi::{c_char, c_void, CStr, CString};

use rusqlite::ffi;

pub mod backup;
pub mod database;
pub mod error;
pub mod function;
pub mod session;
pub mod statement;
pub mod value;
pub mod vtab;

pub use backup::{Backup, BackupStep};
pub use database::{Database, OpenOptions};
pub use error::{Error, Result};
pub use function::{AggregateFunction, Authorizer, FunctionOptions, ScalarFunction};
pub use session::{ChangesetHandler, SessionId};
pub use statement::{Column, Generation, RunResult, Stat, StmtId};
pub use value::{BindOptions, Params, Value};
pub use vtab::{ModuleColumn, VirtualTableModule};

/// The `SQLITE_TRANSIENT` destructor: SQLite copies the bytes before the call returns.
///
/// The bindings do not export the macro because it is `(void(*)(void*))-1`, which bindgen cannot
/// express; the `Option<fn>` representation uses the null niche, so this is the same value.
fn sqlite_transient() -> Option<unsafe extern "C" fn(*mut c_void)> {
    Some(unsafe {
        std::mem::transmute::<*mut c_void, unsafe extern "C" fn(*mut c_void)>(
            usize::MAX as *mut c_void,
        )
    })
}

/// A C string argument for the raw API. A NUL cannot appear in a SQL identifier or a database
/// name this crate passes down; if one does, the name simply will not match.
fn cstring(text: &str) -> Option<CString> {
    CString::new(text).ok()
}

/// Read a C string SQLite owns for the duration of the call.
fn cstr(pointer: *const c_char) -> Option<String> {
    if pointer.is_null() {
        return None;
    }
    // SAFETY: SQLite returns a NUL-terminated string that stays valid until the next call on the
    // same handle; it is copied immediately and nothing runs in between.
    Some(
        unsafe { CStr::from_ptr(pointer) }
            .to_string_lossy()
            .into_owned(),
    )
}

/// `sqlite3_limit` codes, in Node's `database.limits` order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Limit {
    Length,
    SqlLength,
    Column,
    ExprDepth,
    CompoundSelect,
    VdbeOp,
    FunctionArg,
    Attach,
    LikePatternLength,
    VariableNumber,
    TriggerDepth,
}

impl Limit {
    pub const ALL: [Limit; 11] = [
        Limit::Length,
        Limit::SqlLength,
        Limit::Column,
        Limit::ExprDepth,
        Limit::CompoundSelect,
        Limit::VdbeOp,
        Limit::FunctionArg,
        Limit::Attach,
        Limit::LikePatternLength,
        Limit::VariableNumber,
        Limit::TriggerDepth,
    ];

    pub fn from_name(name: &str) -> Option<Self> {
        Some(match name {
            "length" => Limit::Length,
            "sqlLength" => Limit::SqlLength,
            "column" => Limit::Column,
            "exprDepth" => Limit::ExprDepth,
            "compoundSelect" => Limit::CompoundSelect,
            "vdbeOp" => Limit::VdbeOp,
            "functionArg" => Limit::FunctionArg,
            "attach" => Limit::Attach,
            "likePatternLength" => Limit::LikePatternLength,
            "variableNumber" => Limit::VariableNumber,
            "triggerDepth" => Limit::TriggerDepth,
            _ => return None,
        })
    }

    pub fn name(self) -> &'static str {
        match self {
            Limit::Length => "length",
            Limit::SqlLength => "sqlLength",
            Limit::Column => "column",
            Limit::ExprDepth => "exprDepth",
            Limit::CompoundSelect => "compoundSelect",
            Limit::VdbeOp => "vdbeOp",
            Limit::FunctionArg => "functionArg",
            Limit::Attach => "attach",
            Limit::LikePatternLength => "likePatternLength",
            Limit::VariableNumber => "variableNumber",
            Limit::TriggerDepth => "triggerDepth",
        }
    }

    fn code(self) -> i32 {
        match self {
            Limit::Length => ffi::SQLITE_LIMIT_LENGTH,
            Limit::SqlLength => ffi::SQLITE_LIMIT_SQL_LENGTH,
            Limit::Column => ffi::SQLITE_LIMIT_COLUMN,
            Limit::ExprDepth => ffi::SQLITE_LIMIT_EXPR_DEPTH,
            Limit::CompoundSelect => ffi::SQLITE_LIMIT_COMPOUND_SELECT,
            Limit::VdbeOp => ffi::SQLITE_LIMIT_VDBE_OP,
            Limit::FunctionArg => ffi::SQLITE_LIMIT_FUNCTION_ARG,
            Limit::Attach => ffi::SQLITE_LIMIT_ATTACHED,
            Limit::LikePatternLength => ffi::SQLITE_LIMIT_LIKE_PATTERN_LENGTH,
            Limit::VariableNumber => ffi::SQLITE_LIMIT_VARIABLE_NUMBER,
            Limit::TriggerDepth => ffi::SQLITE_LIMIT_TRIGGER_DEPTH,
        }
    }
}

/// The public `sqlite3_libversion()`, reported through `process.versions.sqlite`.
pub fn version() -> &'static str {
    static VERSION: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    VERSION
        .get_or_init(|| {
            // SAFETY: a pure query returning a static string owned by SQLite.
            cstr(unsafe { ffi::sqlite3_libversion() }).unwrap_or_else(|| "unknown".to_owned())
        })
        .as_str()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limit_names_round_trip() {
        for limit in Limit::ALL {
            assert_eq!(Limit::from_name(limit.name()), Some(limit));
        }
        assert_eq!(Limit::from_name("bogus"), None);
    }

    #[test]
    fn version_is_a_version() {
        assert!(
            version().starts_with('3'),
            "unexpected SQLite version {}",
            version()
        );
    }
}
