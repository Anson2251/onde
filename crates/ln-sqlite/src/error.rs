//! The error type crossing the SQLite → JavaScript boundary.
//!
//! Two families share one struct because the host maps either to a JavaScript `Error`:
//!
//! * a SQLite result carries `code = "ERR_SQLITE_ERROR"` plus `errcode`/`errstr` (Node exposes
//!   both, and `docs/research/node-sqlite-api.md` §9 records the shapes);
//! * a state or argument failure carries a Node code (`ERR_INVALID_STATE`,
//!   `ERR_INVALID_ARG_TYPE`, `ERR_INVALID_ARG_VALUE`, `ERR_OUT_OF_RANGE`) and the constructor the
//!   host should use.
//!
//! Keeping the SQLite-specific fields here means `ln-runtime`'s generic `NodeError` (which has no
//! `errcode` slot) does not have to grow one.

use std::ffi::CStr;
use std::fmt;

use rusqlite::ffi;

use crate::cstr;

/// A failure from [`crate::Database`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    /// `ERR_SQLITE_ERROR` or a Node argument/state code.
    pub code: &'static str,
    /// The JavaScript constructor: `"Error"`, `"TypeError"`, `"RangeError"`.
    pub name: &'static str,
    /// The JavaScript `message`.
    pub message: String,
    /// The primary SQLite result code, for `ERR_SQLITE_ERROR`.
    pub errcode: Option<i32>,
    /// `sqlite3_errstr`, for `ERR_SQLITE_ERROR`.
    pub errstr: Option<String>,
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    /// A failure reported by SQLite itself, read from the connection that produced it.
    ///
    /// Crate-private because it dereferences a connection pointer; the pointer is always one
    /// [`crate::Database`] owns.
    pub(crate) fn from_db(db: *mut ffi::sqlite3, _result: i32) -> Self {
        // `sqlite3_errcode` reports the primary code; `sqlite3_extended_errcode` the extended one.
        // Node's `err.errcode` is the primary code (the oracle reports 14 for CANTOPEN and 25 for
        // a range error), so the primary is what is recorded here.
        let errcode = unsafe { ffi::sqlite3_errcode(db) };
        let errstr = sqlite_errstr(errcode);
        let message = cstr(unsafe { ffi::sqlite3_errmsg(db) }).unwrap_or_else(|| errstr.clone());
        Error {
            code: "ERR_SQLITE_ERROR",
            name: "Error",
            message,
            errcode: Some(errcode),
            errstr: Some(errstr),
        }
    }

    /// Map `rusqlite`'s error without losing the SQLite fields.
    pub fn from_rusqlite(error: rusqlite::Error) -> Self {
        match error {
            rusqlite::Error::SqliteFailure(inner, message) => {
                let errcode = inner.extended_code & 0xff;
                let errstr = sqlite_errstr(errcode);
                Error {
                    code: "ERR_SQLITE_ERROR",
                    name: "Error",
                    message: message.unwrap_or_else(|| errstr.clone()),
                    errcode: Some(errcode),
                    errstr: Some(errstr),
                }
            }
            other => Error {
                code: "ERR_SQLITE_ERROR",
                name: "Error",
                message: other.to_string(),
                errcode: None,
                errstr: None,
            },
        }
    }

    /// `statement has been finalized`, `database is not open`, `Unknown named parameter 'x'`, ...
    pub fn invalid_state(message: impl Into<String>) -> Self {
        Error {
            code: "ERR_INVALID_STATE",
            name: "Error",
            message: message.into(),
            errcode: None,
            errstr: None,
        }
    }

    /// `ERR_INVALID_ARG_TYPE` is a `TypeError` in Node.
    pub fn invalid_arg_type(message: impl Into<String>) -> Self {
        Error {
            code: "ERR_INVALID_ARG_TYPE",
            name: "TypeError",
            message: message.into(),
            errcode: None,
            errstr: None,
        }
    }

    /// `ERR_INVALID_ARG_VALUE` is a `TypeError` in Node.
    pub fn invalid_arg_value(message: impl Into<String>) -> Self {
        Error {
            code: "ERR_INVALID_ARG_VALUE",
            name: "TypeError",
            message: message.into(),
            errcode: None,
            errstr: None,
        }
    }

    /// `ERR_OUT_OF_RANGE` is a `RangeError` in Node.
    pub fn out_of_range(message: impl Into<String>) -> Self {
        Error {
            code: "ERR_OUT_OF_RANGE",
            name: "RangeError",
            message: message.into(),
            errcode: None,
            errstr: None,
        }
    }

    /// An integer that cannot be represented as a JavaScript number.
    pub fn integer_out_of_range(value: i64) -> Self {
        Error::out_of_range(format!(
            "Value is too large to be represented as a JavaScript number: {value}"
        ))
    }

    /// `sqlite3_load_extension` failures: Node uses its own code and no `errcode`/`errstr`.
    pub fn extension(message: impl Into<String>) -> Self {
        Error {
            code: "ERR_LOAD_SQLITE_EXTENSION",
            name: "Error",
            message: message.into(),
            errcode: None,
            errstr: None,
        }
    }

    /// A failure inside a user-defined function or aggregate callback. The SQLite result code is
    /// `SQLITE_ERROR`; the host may replace this with the original JavaScript exception.
    pub fn callback(message: impl Into<String>) -> Self {
        Error {
            code: "ERR_SQLITE_ERROR",
            name: "Error",
            message: message.into(),
            errcode: Some(ffi::SQLITE_ERROR),
            errstr: Some("SQL logic error".to_owned()),
        }
    }

    /// The error SQLite reports for an argument that has no parameter slot left
    /// (`sqlite3_bind_*` with an index past the end).
    pub fn range() -> Self {
        Error {
            code: "ERR_SQLITE_ERROR",
            name: "Error",
            message: "column index out of range".to_owned(),
            errcode: Some(25),
            errstr: Some("column index out of range".to_owned()),
        }
    }

    /// A text/blob binding whose length cannot cross the C `int` boundary.
    pub fn too_large(len: usize) -> Self {
        Error::invalid_arg_value(format!(
            "Cannot bind a value larger than 2147483647 bytes to SQLite (got {len})"
        ))
    }
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

fn sqlite_errstr(result: i32) -> String {
    // SAFETY: `sqlite3_errstr` returns a static NUL-terminated string for every result code.
    unsafe { CStr::from_ptr(ffi::sqlite3_errstr(result)) }
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_error_matches_the_oracle() {
        let error = Error::range();
        assert_eq!(error.code, "ERR_SQLITE_ERROR");
        assert_eq!(error.errcode, Some(25));
        assert_eq!(error.errstr.as_deref(), Some("column index out of range"));
    }

    #[test]
    fn integer_out_of_range_is_a_range_error() {
        let error = Error::integer_out_of_range(9007199254740993);
        assert_eq!(error.code, "ERR_OUT_OF_RANGE");
        assert_eq!(error.name, "RangeError");
        assert!(error.message.contains("9007199254740993"));
    }
}
