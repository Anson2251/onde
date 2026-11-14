//! Module resolution for lite-node, with no engine dependency.
//!
//! Resolution is the part of the module system that is easiest to get subtly wrong and easiest
//! to test in isolation, so it lives here: `ln-runtime` only bridges these functions to the
//! JavaScript loader and to the engine's module loader callback.
//!
//! Two resolvers share one implementation:
//!
//! - [`Kind::Require`] — CommonJS: extension and `index` lookup, `exports` conditions
//!   `node`/`require`/`default`, and a `format` that says whether `require()` may load the file
//!   at all (a `.mjs` file or a `.js` under `"type": "module"` resolves to [`Format::Module`]
//!   and is rejected by the CJS loader with `ERR_REQUIRE_ESM`).
//! - [`Kind::Import`] — ESM: no extension search, directories are errors, `exports` conditions
//!   `node`/`import`/`default`, and canonical `file:` URLs for the engine's module names.
//!
//! The implementation follows Node's documented algorithms ([ESM resolution] and the CJS
//! `require` algorithm) rather than the quirks of any one Node release. Where lite deliberately
//! differs, the divergence is listed in `docs/compat.md`.
//!
//! [ESM resolution]: https://nodejs.org/api/esm.html#resolution-algorithm

use std::fmt;
use std::path::PathBuf;

pub mod builtin;
pub mod package;
pub mod resolve;
pub mod scan;
pub mod url;

pub use builtin::{lookup as lookup_builtin, BUILTINS};
pub use package::{PackageJson, PackageType};
pub use resolve::{Format, Kind, Resolution, Resolver};
pub use scan::scan_named_exports;

/// A resolution error carrying the Node error code and a message ready for stderr.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolveFailure {
    /// `ERR_MODULE_NOT_FOUND`, `MODULE_NOT_FOUND`, `ERR_PACKAGE_PATH_NOT_EXPORTED`, ...
    pub code: &'static str,
    /// Node-shaped message (no trailing newline).
    pub message: String,
    /// The specifier as written, for the caller's diagnostics.
    pub specifier: String,
    /// The file (or `package.json`) that triggered the failure.
    pub from: Option<PathBuf>,
}

impl ResolveFailure {
    pub fn new(
        code: &'static str,
        message: impl Into<String>,
        specifier: impl Into<String>,
    ) -> Self {
        ResolveFailure {
            code,
            message: message.into(),
            specifier: specifier.into(),
            from: None,
        }
    }

    pub fn from_path(mut self, path: impl Into<PathBuf>) -> Self {
        self.from = Some(path.into());
        self
    }
}

impl fmt::Display for ResolveFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ResolveFailure {}

/// A [`ResolveFailure`] alias used by the resolver internals.
pub type ResolveResult<T> = Result<T, ResolveFailure>;
