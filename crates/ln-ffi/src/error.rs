//! The error type shared by the loader, the type table and the call path.
//!
//! Codes are Node's `ERR_*` convention and are the contract with `js/lib/ffi.js` and the tests.
//! The crate has no engine dependency, so an error is data: the host turns it into a JavaScript
//! `Error` with a `code` at the boundary.

/// An FFI failure with a stable code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    pub code: &'static str,
    pub message: String,
}

impl Error {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Error {
            code,
            message: message.into(),
        }
    }

    /// A failure of the host or the library, not of a caller argument.
    pub fn fault(code: &'static str, message: impl Into<String>) -> Self {
        Error::new(code, message)
    }

    pub fn dlopen(message: impl Into<String>) -> Self {
        Error::new("ERR_FFI_DLOPEN", message)
    }

    pub fn symbol_not_found(name: &str) -> Self {
        Error::new(
            "ERR_FFI_SYMBOL_NOT_FOUND",
            format!("symbol `{name}` not found"),
        )
    }

    pub fn closed() -> Self {
        Error::new("ERR_FFI_CLOSED", "FFI handle is closed")
    }

    pub fn unsupported_layout(what: impl Into<String>) -> Self {
        Error::new("ERR_FFI_UNSUPPORTED_LAYOUT", what)
    }

    pub fn signature_conflict(message: impl Into<String>) -> Self {
        Error::new("ERR_FFI_SIGNATURE_CONFLICT", message)
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for Error {}

pub type Result<T, E = Error> = std::result::Result<T, E>;
