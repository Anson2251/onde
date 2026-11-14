//! `package.json` parsing.
//!
//! Only the fields the resolver needs are kept. Unknown fields are ignored (Node does the same);
//! malformed JSON, or a `type` that is neither `"module"` nor `"commonjs"`, produces
//! `ERR_INVALID_PACKAGE_CONFIG` like Node's ESM loader.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::ResolveFailure;

/// How `.js` files under this package are interpreted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PackageType {
    /// `"type": "commonjs"`, a missing `type`, or no `package.json` at all.
    #[default]
    CommonJs,
    /// `"type": "module"`.
    Module,
}

impl PackageType {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "module" => Some(PackageType::Module),
            "commonjs" => Some(PackageType::CommonJs),
            _ => None,
        }
    }
}

/// The parts of a `package.json` that affect resolution.
#[derive(Debug, Clone, Default)]
pub struct PackageJson {
    /// Directory containing the file.
    pub dir: PathBuf,
    /// Absolute path of the `package.json` itself (for error messages).
    pub path: PathBuf,
    pub name: Option<String>,
    /// Legacy entry point, used when there is no `exports` map.
    pub main: Option<String>,
    pub package_type: PackageType,
    /// The `exports` field, validated only when used.
    pub exports: Option<Value>,
    /// The `imports` field (`#` specifiers).
    pub imports: Option<Value>,
}

impl PackageJson {
    /// Load `dir/package.json`.
    ///
    /// Returns `Ok(None)` when the file does not exist: a missing `package.json` is normal.
    pub fn load(dir: &Path) -> Result<Option<Self>, ResolveFailure> {
        let dir = if dir.as_os_str().is_empty() {
            Path::new(".")
        } else {
            dir
        };
        let path = dir.join("package.json");
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            // A directory named package.json, a permission error, invalid UTF-8: Node reports
            // these too. `EISDIR` and `EACCES` remain distinguishable through the message.
            Err(error) => {
                return Err(ResolveFailure::new(
                    "ERR_INVALID_PACKAGE_CONFIG",
                    format!("Invalid package config {}: {error}", path.display()),
                    path.display().to_string(),
                ))
            }
        };

        let value: Value = serde_json::from_str(&text).map_err(|error| {
            ResolveFailure::new(
                "ERR_INVALID_PACKAGE_CONFIG",
                format!(
                    "Invalid package config {}: {} at line {} column {}",
                    path.display(),
                    error,
                    error.line(),
                    error.column()
                ),
                path.display().to_string(),
            )
        })?;
        let object = value.as_object().ok_or_else(|| {
            ResolveFailure::new(
                "ERR_INVALID_PACKAGE_CONFIG",
                format!(
                    "Invalid package config {}: expected a JSON object",
                    path.display()
                ),
                path.display().to_string(),
            )
        })?;

        let string = |key: &str| object.get(key).and_then(Value::as_str);
        let package_type = match string("type") {
            None => PackageType::CommonJs,
            Some(text) => PackageType::parse(text).ok_or_else(|| {
                ResolveFailure::new(
                    "ERR_INVALID_PACKAGE_CONFIG",
                    format!(
                        "Invalid package config {}: invalid package type \"{text}\"",
                        path.display()
                    ),
                    path.display().to_string(),
                )
            })?,
        };

        Ok(Some(PackageJson {
            dir: dir.to_path_buf(),
            path,
            name: string("name").map(ToOwned::to_owned),
            main: string("main").map(ToOwned::to_owned),
            package_type,
            exports: object.get("exports").cloned(),
            imports: object.get("imports").cloned(),
        }))
    }

    /// `exports` as a subpath map (an object whose keys start with `.`), if present.
    pub fn exports_map(&self) -> Option<&serde_json::Map<String, Value>> {
        let value = self.exports.as_ref()?;
        match value.as_object() {
            Some(object) if object.keys().any(|key| key.starts_with('.')) => Some(object),
            _ => None,
        }
    }
}
