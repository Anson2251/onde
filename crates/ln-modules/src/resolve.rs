//! The resolver: Node's CJS `require` and ESM resolution algorithms over one filesystem view.
//!
//! Types are intentionally small: a resolution is either a builtin name or a file plus the format
//! the loader must use. The format is part of the result because `require()` of a file that
//! resolves to ESM must fail with `ERR_REQUIRE_ESM` *before* the file is read, and because ESM
//! import of a `.json` file goes through a different loader path than `.js`.

use std::cell::RefCell;
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::rc::Rc;

use serde_json::{Map, Value};

use crate::package::{PackageJson, PackageType};
use crate::url;
use crate::{builtin, ResolveFailure, ResolveResult};

/// Which resolution algorithm to run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// `require()`: extension search, directory `index`, `exports` conditions `node|require|default`.
    Require,
    /// `import`: no extension search, directories are errors, conditions `node|import|default`.
    Import,
}

impl Kind {
    fn conditions(self) -> &'static [&'static str] {
        match self {
            Kind::Require => &["node", "require", "default"],
            Kind::Import => &["node", "import", "default"],
        }
    }

    fn is_require(self) -> bool {
        matches!(self, Kind::Require)
    }
}

/// How the loader must treat a resolved file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    /// Classic CommonJS wrapper: `exports`, `require`, `module`, `__filename`, `__dirname`.
    CommonJs,
    /// Native QuickJS module.
    Module,
    /// JSON module: parsed once, `default` export.
    Json,
    /// Native addon (`.node`): always a clear error in onde.
    Native,
}

impl Format {
    pub fn as_str(self) -> &'static str {
        match self {
            Format::CommonJs => "commonjs",
            Format::Module => "module",
            Format::Json => "json",
            Format::Native => "addon",
        }
    }
}

/// A successful resolution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    /// A builtin module, canonical name without the `node:` prefix.
    Builtin(&'static str),
    /// A file on disk.
    File { path: PathBuf, format: Format },
}

impl Resolution {
    pub fn path(&self) -> Option<&Path> {
        match self {
            Resolution::File { path, .. } => Some(path),
            Resolution::Builtin(_) => None,
        }
    }

    pub fn format(&self) -> Option<Format> {
        match self {
            Resolution::File { format, .. } => Some(*format),
            Resolution::Builtin(_) => None,
        }
    }
}

/// One resolver per isolate. Cheap to clone? No: it owns a cache, so it is shared behind `Rc`.
pub struct Resolver {
    cwd: PathBuf,
    packages: RefCell<HashMap<PathBuf, ResolveResult<Option<Rc<PackageJson>>>>>,
}

impl std::fmt::Debug for Resolver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Resolver")
            .field("cwd", &self.cwd)
            .finish_non_exhaustive()
    }
}

impl Resolver {
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Resolver {
            cwd: cwd.into(),
            packages: RefCell::new(HashMap::new()),
        }
    }

    pub fn cwd(&self) -> &Path {
        &self.cwd
    }

    /// Resolve `specifier` as if it appeared in `from_file`.
    ///
    /// `from_file` need not exist; only its directory matters. A relative path with no parent
    /// (for example `[eval]`) resolves against the process working directory.
    pub fn resolve(
        &self,
        specifier: &str,
        from_file: &Path,
        kind: Kind,
    ) -> ResolveResult<Resolution> {
        if specifier.is_empty() {
            return Err(ResolveFailure::new(
                "ERR_INVALID_MODULE_SPECIFIER",
                "The specifier is empty",
                specifier,
            ));
        }

        if builtin::is_node_prefixed(specifier) {
            return match builtin::lookup(specifier) {
                Some(name) => Ok(Resolution::Builtin(name)),
                None => Err(ResolveFailure::new(
                    "ERR_UNKNOWN_BUILTIN_MODULE",
                    format!("No such built-in module: {specifier}"),
                    specifier,
                )),
            };
        }

        // Builtins win over node_modules entries of the same name (Node does the same).
        if let Some(name) = builtin::lookup(specifier) {
            return Ok(Resolution::Builtin(name));
        }

        if specifier.starts_with("file:") {
            if kind.is_require() {
                return Err(module_not_found(specifier, from_file, kind));
            }
            let path = url::file_url_to_path(specifier).map_err(|message| {
                ResolveFailure::new("ERR_INVALID_FILE_URL_PATH", message, specifier)
                    .from_path(from_file)
            })?;
            return self.resolve_absolute_path(&path, from_file, kind, specifier);
        }

        // A module name for a file can arrive as `file://` URL (ESM canonical names) or as a
        // plain path (the CJS loader). Both resolve relative to the file's directory.
        let from_path = from_file_path(from_file);
        let base = base_dir(&from_path, &self.cwd);

        if is_relative_specifier(specifier) || Path::new(specifier).is_absolute() {
            let target = if Path::new(specifier).is_absolute() {
                normalize_path(Path::new(specifier))
            } else {
                normalize_path(&base.join(specifier))
            };
            return self.resolve_path(&target, from_file, kind, specifier);
        }

        if specifier.starts_with('#') {
            return self.resolve_imports(specifier, &from_path, kind);
        }

        if specifier.starts_with('\\') {
            return Err(ResolveFailure::new(
                "ERR_INVALID_MODULE_SPECIFIER",
                format!("Invalid module specifier '{specifier}'"),
                specifier,
            )
            .from_path(from_file));
        }

        self.resolve_bare(specifier, &from_path, kind)
    }

    /// Resolve a CLI entry point to an absolute path and format.
    ///
    /// Missing files return `MODULE_NOT_FOUND`; the CLI turns that into the familiar
    /// `Cannot find module` line instead of a stack trace.
    pub fn resolve_entry(&self, path: &Path) -> ResolveResult<(PathBuf, Format)> {
        let absolute = if path.is_absolute() {
            normalize_path(path)
        } else {
            normalize_path(&self.cwd.join(path))
        };
        if !absolute.is_file() {
            return Err(ResolveFailure::new(
                "MODULE_NOT_FOUND",
                format!("Cannot find module '{}'", path.display()),
                path.display().to_string(),
            )
            .from_path(&absolute));
        }
        let canonical = canonicalize(&absolute);
        let format = self.format_for(&canonical, Kind::Import)?;
        Ok((canonical, format))
    }

    /// `package.json` type for `.js` files, used by the loader for cache decisions.
    pub fn package_type(&self, file: &Path) -> PackageType {
        self.package_type_for(file)
    }

    // --- path-based resolution -----------------------------------------------------------------

    fn resolve_absolute_path(
        &self,
        path: &Path,
        from_file: &Path,
        kind: Kind,
        specifier: &str,
    ) -> ResolveResult<Resolution> {
        self.resolve_path(&normalize_path(path), from_file, kind, specifier)
    }

    fn resolve_path(
        &self,
        path: &Path,
        from_file: &Path,
        kind: Kind,
        specifier: &str,
    ) -> ResolveResult<Resolution> {
        if kind.is_require() {
            if let Some(resolution) = self.load_as_file(path) {
                return Ok(resolution);
            }
            if let Some(resolution) = self.load_as_directory(path) {
                return Ok(resolution);
            }
            return Err(module_not_found(specifier, from_file, kind));
        }

        // ESM: exact file only. A directory import is its own error, not "not found".
        if path.is_dir() {
            return Err(ResolveFailure::new(
                "ERR_UNSUPPORTED_DIR_IMPORT",
                format!(
                    "Directory import '{}' is not supported resolving ES modules imported from {}",
                    path.display(),
                    from_file.display()
                ),
                specifier,
            )
            .from_path(from_file));
        }
        if !path.is_file() {
            return Err(module_not_found(specifier, from_file, kind));
        }
        let format = self.format_for(path, kind)?;
        Ok(Resolution::File {
            path: canonicalize(path),
            format,
        })
    }

    /// Try `path` as a file, then with Node's CJS extension list appended.
    fn load_as_file(&self, path: &Path) -> Option<Resolution> {
        if path.is_file() {
            return self.file_resolution(path, Kind::Require).ok();
        }
        for extension in ["js", "json", "cjs", "mjs", "node"] {
            let candidate = append_extension(path, extension);
            if candidate.is_file() {
                return self.file_resolution(&candidate, Kind::Require).ok();
            }
        }
        None
    }

    fn file_resolution(&self, path: &Path, kind: Kind) -> ResolveResult<Resolution> {
        let format = self.format_for(path, kind)?;
        Ok(Resolution::File {
            path: canonicalize(path),
            format,
        })
    }

    /// CJS directory resolution: `package.json#main`, then `index.*`.
    fn load_as_directory(&self, dir: &Path) -> Option<Resolution> {
        if !dir.is_dir() {
            return None;
        }
        if let Ok(Some(package)) = self.package_for_dir(dir) {
            if let Some(main) = package.main.as_deref() {
                let candidate = normalize_path(&dir.join(main));
                if let Some(resolution) = self.load_as_file(&candidate) {
                    return Some(resolution);
                }
                if let Some(resolution) = self.load_as_directory(&candidate) {
                    return Some(resolution);
                }
            }
        }
        self.load_index(dir)
    }

    fn load_index(&self, dir: &Path) -> Option<Resolution> {
        for name in [
            "index.js",
            "index.json",
            "index.cjs",
            "index.mjs",
            "index.node",
        ] {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return self.file_resolution(&candidate, Kind::Require).ok();
            }
        }
        None
    }

    // --- bare specifiers -----------------------------------------------------------------------

    fn resolve_bare(
        &self,
        specifier: &str,
        from_file: &Path,
        kind: Kind,
    ) -> ResolveResult<Resolution> {
        let bare = parse_bare_specifier(specifier)?;
        let start = base_dir(from_file, &self.cwd);

        for node_modules in node_modules_paths(&start) {
            let package_dir = node_modules.join(&bare.name);
            if !package_dir.is_dir() {
                continue;
            }
            let package = self.package_for_dir(&package_dir)?;
            return self.resolve_package(
                &package_dir,
                package,
                &bare.subpath,
                from_file,
                kind,
                specifier,
            );
        }

        Err(module_not_found(specifier, from_file, kind))
    }

    fn resolve_package(
        &self,
        package_dir: &Path,
        package: Option<Rc<PackageJson>>,
        subpath: &str,
        from_file: &Path,
        kind: Kind,
        specifier: &str,
    ) -> ResolveResult<Resolution> {
        let package_path = package
            .as_ref()
            .map(|package| package.path.clone())
            .unwrap_or_else(|| package_dir.join("package.json"));

        // `exports` takes over the whole package namespace: when it exists, subpath file access
        // is not an alternative, and a missing subpath is an error even if the file exists.
        if let Some(package) = package.as_ref() {
            // `"exports": null` is the JSON spelling of "no exports map"; only an object,
            // string, or array takes over the package namespace.
            if let Some(exports) = package
                .exports
                .as_ref()
                .filter(|exports| !exports.is_null())
            {
                let target = resolve_exports_map(
                    exports,
                    subpath,
                    kind.conditions(),
                    package_dir,
                    &package_path,
                )?;
                return match target {
                    Some(target) => self.map_target_to_resolution(
                        target,
                        package_dir,
                        kind,
                        from_file,
                        specifier,
                    ),
                    None => Err(package_path_not_exported(subpath, &package_path, from_file)),
                };
            }
        }

        if subpath == "." {
            if let Some(package) = package.as_ref() {
                if let Some(main) = package.main.as_deref() {
                    let candidate = normalize_path(&package_dir.join(main));
                    if let Some(resolution) = self.load_as_file(&candidate) {
                        return Ok(resolution);
                    }
                    if let Some(resolution) = self.load_as_directory(&candidate) {
                        return Ok(resolution);
                    }
                }
            }
            if let Some(resolution) = self.load_index(package_dir) {
                return Ok(resolution);
            }
            return Err(module_not_found(specifier, from_file, kind));
        }

        let relative = subpath.strip_prefix("./").unwrap_or(subpath);
        let target = normalize_path(&package_dir.join(relative));
        if !target.starts_with(package_dir) {
            return Err(ResolveFailure::new(
                "ERR_INVALID_MODULE_SPECIFIER",
                format!("Invalid module specifier '{specifier}'"),
                specifier,
            )
            .from_path(from_file));
        }

        if kind.is_require() {
            if let Some(resolution) = self.load_as_file(&target) {
                return Ok(resolution);
            }
            if let Some(resolution) = self.load_as_directory(&target) {
                return Ok(resolution);
            }
            return Err(module_not_found(specifier, from_file, kind));
        }

        // ESM subpath without `exports`: exact file, extension required, no directory imports.
        if target.is_dir() {
            return Err(ResolveFailure::new(
                "ERR_UNSUPPORTED_DIR_IMPORT",
                format!(
                    "Directory import '{}' is not supported resolving ES modules imported from {}",
                    target.display(),
                    from_file.display()
                ),
                specifier,
            )
            .from_path(from_file));
        }
        if !target.is_file() {
            return Err(module_not_found(specifier, from_file, kind));
        }
        self.file_resolution(&target, kind)
    }

    // --- package imports (`#`) -----------------------------------------------------------------

    fn resolve_imports(
        &self,
        specifier: &str,
        from_file: &Path,
        kind: Kind,
    ) -> ResolveResult<Resolution> {
        let start = base_dir(from_file, &self.cwd);
        let (package_dir, package) = self.find_enclosing_package(&start).ok_or_else(|| {
            ResolveFailure::new(
                "ERR_PACKAGE_IMPORT_NOT_DEFINED",
                format!(
                    "Package import specifier \"{specifier}\" is not defined in any package.json \
                     in scope of {}",
                    from_file.display()
                ),
                specifier,
            )
            .from_path(from_file)
        })?;

        let imports = package.imports.as_ref().ok_or_else(|| {
            ResolveFailure::new(
                "ERR_PACKAGE_IMPORT_NOT_DEFINED",
                format!(
                    "Package import specifier \"{specifier}\" is not defined in {}",
                    package.path.display()
                ),
                specifier,
            )
            .from_path(from_file)
        })?;

        let map = imports.as_object().ok_or_else(|| {
            ResolveFailure::new(
                "ERR_INVALID_PACKAGE_CONFIG",
                format!(
                    "\"imports\" must be an object in {}",
                    package.path.display()
                ),
                specifier,
            )
            .from_path(from_file)
        })?;

        let target = match_map(
            map,
            specifier,
            kind.conditions(),
            &package_dir,
            &package.path,
            true,
        )?;
        let Some(target) = target else {
            return Err(ResolveFailure::new(
                "ERR_PACKAGE_IMPORT_NOT_DEFINED",
                format!(
                    "Package import specifier \"{specifier}\" is not defined in {}",
                    package.path.display()
                ),
                specifier,
            )
            .from_path(from_file));
        };

        self.map_target_to_resolution(target, &package_dir, kind, from_file, specifier)
    }

    fn map_target_to_resolution(
        &self,
        target: MapTarget,
        package_dir: &Path,
        kind: Kind,
        from_file: &Path,
        specifier: &str,
    ) -> ResolveResult<Resolution> {
        match target {
            MapTarget::Blocked => Err(package_path_not_exported(
                specifier,
                &package_dir.join("package.json"),
                from_file,
            )),
            MapTarget::Specifier(specifier_target) => {
                // An `imports` target may name another package or a `#` specifier. Resolve it
                // as if it appeared in the package's own package.json.
                if specifier_target.starts_with('#') {
                    return self.resolve_imports(&specifier_target, from_file, kind);
                }
                self.resolve(&specifier_target, &package_dir.join("package.json"), kind)
            }
            MapTarget::Path(path) => {
                if kind.is_require() {
                    if let Some(resolution) = self.load_as_file(&path) {
                        return Ok(resolution);
                    }
                    return Err(module_not_found(specifier, from_file, kind));
                }
                if path.is_dir() {
                    return Err(ResolveFailure::new(
                        "ERR_UNSUPPORTED_DIR_IMPORT",
                        format!(
                            "Directory import '{}' is not supported resolving ES modules imported from {}",
                            path.display(),
                            from_file.display()
                        ),
                        specifier,
                    )
                    .from_path(from_file));
                }
                if !path.is_file() {
                    return Err(module_not_found(specifier, from_file, kind));
                }
                self.file_resolution(&path, kind)
            }
        }
    }

    // --- package metadata ----------------------------------------------------------------------

    fn package_for_dir(&self, dir: &Path) -> ResolveResult<Option<Rc<PackageJson>>> {
        if let Some(cached) = self.packages.borrow().get(dir) {
            return cached.clone();
        }
        let loaded = PackageJson::load(dir).map(|package| package.map(Rc::new));
        self.packages
            .borrow_mut()
            .insert(dir.to_path_buf(), loaded.clone());
        loaded
    }

    fn package_type_for(&self, file: &Path) -> PackageType {
        let mut current = file.parent();
        while let Some(dir) = current {
            // A broken package.json must not make `type` lookup throw: the ESM resolver reports
            // the config error when it actually consults `exports`. Falling back to CommonJS
            // keeps unrelated files loading.
            if let Ok(Some(package)) = self.package_for_dir(dir) {
                return package.package_type;
            }
            current = dir.parent();
        }
        PackageType::CommonJs
    }

    fn find_enclosing_package(&self, start: &Path) -> Option<(PathBuf, Rc<PackageJson>)> {
        for dir in start.ancestors() {
            if let Ok(Some(package)) = self.package_for_dir(dir) {
                return Some((dir.to_path_buf(), package));
            }
        }
        None
    }

    fn format_for(&self, path: &Path, kind: Kind) -> ResolveResult<Format> {
        let extension = path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("");
        let format = match extension {
            "mjs" => Format::Module,
            "cjs" => Format::CommonJs,
            "json" => Format::Json,
            "node" => Format::Native,
            "js" => match self.package_type_for(path) {
                PackageType::Module => Format::Module,
                PackageType::CommonJs => Format::CommonJs,
            },
            other => {
                if kind == Kind::Import {
                    return Err(ResolveFailure::new(
                        "ERR_UNKNOWN_FILE_EXTENSION",
                        format!("Unknown file extension \"{other}\" for {}", path.display()),
                        path.display().to_string(),
                    )
                    .from_path(path));
                }
                // CJS loads unknown extensions as JavaScript, like Node's default loader.
                Format::CommonJs
            }
        };
        Ok(format)
    }
}

// --- exports / imports maps -----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
enum MapTarget {
    /// A package-relative file.
    Path(PathBuf),
    /// Another specifier (bare package, `#` import, or `node:` builtin).
    Specifier(String),
    /// `null` in the map: the subpath is explicitly not exported.
    Blocked,
}

/// Resolve the `exports` field for `subpath` (`"."` for the package root).
fn resolve_exports_map(
    exports: &Value,
    subpath: &str,
    conditions: &[&str],
    package_dir: &Path,
    package_path: &Path,
) -> ResolveResult<Option<MapTarget>> {
    match exports {
        Value::Null => Ok(None),
        Value::Object(map) => {
            let has_subpath_keys = map.keys().any(|key| key.starts_with('.'));
            let has_other_keys = map.keys().any(|key| !key.starts_with('.'));
            if has_subpath_keys && has_other_keys {
                return Err(invalid_package_config(
                    package_path,
                    "\"exports\" cannot contain some keys starting with '.' and some not",
                ));
            }
            if has_subpath_keys {
                match_map(map, subpath, conditions, package_dir, package_path, false)
            } else if subpath == "." {
                resolve_target(exports, None, conditions, package_dir, package_path, false)
            } else {
                Ok(None)
            }
        }
        Value::String(_) | Value::Array(_) => {
            if subpath == "." {
                resolve_target(exports, None, conditions, package_dir, package_path, false)
            } else {
                Ok(None)
            }
        }
        _ => Err(invalid_package_target(exports, package_path)),
    }
}

fn match_map(
    map: &Map<String, Value>,
    key: &str,
    conditions: &[&str],
    package_dir: &Path,
    package_path: &Path,
    is_imports: bool,
) -> ResolveResult<Option<MapTarget>> {
    if let Some(target) = map.get(key) {
        return resolve_target(
            target,
            None,
            conditions,
            package_dir,
            package_path,
            is_imports,
        );
    }

    // Longest-prefix pattern match, as Node does for `./feature/*`.
    let mut best: Option<(usize, usize, &str, &Value)> = None;
    for (pattern, target) in map {
        let Some(star) = pattern.find('*') else {
            continue;
        };
        if pattern[star + 1..].contains('*') {
            continue;
        }
        let prefix = &pattern[..star];
        let suffix = &pattern[star + 1..];
        if !key.starts_with(prefix)
            || !key.ends_with(suffix)
            || key.len() < prefix.len() + suffix.len()
        {
            continue;
        }
        let score = (prefix.len(), pattern.len());
        if best
            .as_ref()
            .is_none_or(|(prefix_len, pattern_len, ..)| score > (*prefix_len, *pattern_len))
        {
            best = Some((prefix.len(), pattern.len(), pattern, target));
        }
    }

    let Some((_, _, pattern, target)) = best else {
        return Ok(None);
    };
    let star = pattern.find('*').expect("pattern has a star");
    let prefix = &pattern[..star];
    let suffix = &pattern[star + 1..];
    let matched = &key[prefix.len()..key.len() - suffix.len()];
    resolve_target(
        target,
        Some(matched),
        conditions,
        package_dir,
        package_path,
        is_imports,
    )
}

/// Resolve one target value: string, conditional object, array, or `null`.
///
/// `Ok(None)` means "no condition matched, try the next candidate"; `Some(Blocked)` means the
/// map explicitly blocks the subpath.
fn resolve_target(
    target: &Value,
    pattern: Option<&str>,
    conditions: &[&str],
    package_dir: &Path,
    package_path: &Path,
    is_imports: bool,
) -> ResolveResult<Option<MapTarget>> {
    match target {
        Value::Null => Ok(Some(MapTarget::Blocked)),
        Value::String(text) => {
            let text = match pattern {
                Some(matched) => text.replace('*', matched),
                None => text.clone(),
            };
            if is_imports {
                resolve_imports_target(&text, package_dir, package_path)
            } else {
                resolve_exports_target(&text, package_dir, package_path).map(Some)
            }
        }
        Value::Object(object) => {
            if object.keys().any(|key| key.starts_with('.')) {
                return Err(invalid_package_target(target, package_path));
            }
            for (condition, value) in object {
                if condition == "default" || conditions.contains(&condition.as_str()) {
                    let resolved = resolve_target(
                        value,
                        pattern,
                        conditions,
                        package_dir,
                        package_path,
                        is_imports,
                    )?;
                    if resolved.is_some() {
                        return Ok(resolved);
                    }
                }
            }
            Ok(None)
        }
        Value::Array(items) => {
            for item in items {
                match resolve_target(
                    item,
                    pattern,
                    conditions,
                    package_dir,
                    package_path,
                    is_imports,
                )? {
                    Some(MapTarget::Blocked) | None => continue,
                    Some(target) => return Ok(Some(target)),
                }
            }
            Ok(None)
        }
        _ => Err(invalid_package_target(target, package_path)),
    }
}

fn resolve_exports_target(
    text: &str,
    package_dir: &Path,
    package_path: &Path,
) -> ResolveResult<MapTarget> {
    if !text.starts_with("./") {
        return Err(invalid_package_target(
            &Value::String(text.to_owned()),
            package_path,
        ));
    }
    if text.contains('\\') || text.contains("%2F") || text.contains("%2f") {
        return Err(invalid_package_target(
            &Value::String(text.to_owned()),
            package_path,
        ));
    }
    let path = normalize_path(&package_dir.join(&text[2..]));
    if !path.starts_with(package_dir) || path == package_dir {
        return Err(invalid_package_target(
            &Value::String(text.to_owned()),
            package_path,
        ));
    }
    Ok(MapTarget::Path(path))
}

fn resolve_imports_target(
    text: &str,
    package_dir: &Path,
    package_path: &Path,
) -> ResolveResult<Option<MapTarget>> {
    if text.starts_with("./") {
        return resolve_exports_target(text, package_dir, package_path).map(Some);
    }
    if text.starts_with("../") || text.starts_with('/') || text.is_empty() {
        return Err(invalid_package_target(
            &Value::String(text.to_owned()),
            package_path,
        ));
    }
    Ok(Some(MapTarget::Specifier(text.to_owned())))
}

// --- specifier parsing and path helpers ------------------------------------------------------

struct BareSpecifier {
    name: String,
    subpath: String,
}

fn parse_bare_specifier(specifier: &str) -> ResolveResult<BareSpecifier> {
    if specifier.starts_with('.')
        || specifier.starts_with('/')
        || specifier.starts_with('#')
        || specifier.starts_with('\\')
        || specifier.contains('\\')
        || specifier.contains('\0')
    {
        return Err(invalid_specifier(specifier));
    }

    let (name, rest) = if specifier.starts_with('@') {
        let mut parts = specifier.splitn(3, '/');
        let scope = parts.next().unwrap_or_default();
        let package = parts.next().ok_or_else(|| invalid_specifier(specifier))?;
        if scope.len() < 2 || package.is_empty() {
            return Err(invalid_specifier(specifier));
        }
        (format!("{scope}/{package}"), parts.next())
    } else {
        let mut parts = specifier.splitn(2, '/');
        let package = parts.next().unwrap_or_default();
        if package.is_empty() {
            return Err(invalid_specifier(specifier));
        }
        (package.to_owned(), parts.next())
    };

    if name == "." || name == ".." || name.contains('%') {
        return Err(invalid_specifier(specifier));
    }

    let subpath = match rest {
        None => ".".to_owned(),
        Some(rest) => {
            if rest.is_empty() {
                return Err(invalid_specifier(specifier));
            }
            for segment in rest.split('/') {
                if segment.is_empty()
                    || segment == "."
                    || segment == ".."
                    || segment.contains('%')
                    || segment.contains('\\')
                {
                    return Err(invalid_specifier(specifier));
                }
            }
            format!("./{rest}")
        }
    };

    Ok(BareSpecifier { name, subpath })
}

/// Canonicalise the caller's `from_file` to a filesystem path.
///
/// The ESM loader passes `file:///...` names; the CJS loader passes plain paths.
fn from_file_path(from_file: &Path) -> PathBuf {
    let text = from_file.to_string_lossy();
    if text.starts_with("file:") {
        if let Ok(path) = url::file_url_to_path(&text) {
            return path;
        }
    }
    from_file.to_path_buf()
}

fn base_dir(from_file: &Path, cwd: &Path) -> PathBuf {
    match from_file.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
        _ => cwd.to_path_buf(),
    }
}

fn is_relative_specifier(specifier: &str) -> bool {
    specifier == "."
        || specifier == ".."
        || specifier.starts_with("./")
        || specifier.starts_with("../")
}

/// Lexical path normalization (no filesystem access, no symlink resolution).
pub(crate) fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                let last_is_normal = out
                    .components()
                    .next_back()
                    .map(|last| matches!(last, Component::Normal(_)))
                    .unwrap_or(false);
                if last_is_normal {
                    out.pop();
                } else if !out.is_absolute() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn canonicalize(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn append_extension(path: &Path, extension: &str) -> PathBuf {
    let mut text = path.as_os_str().to_os_string();
    text.push(".");
    text.push(extension);
    PathBuf::from(text)
}

fn node_modules_paths(start: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for ancestor in start.ancestors() {
        if ancestor
            .file_name()
            .map(|name| name == "node_modules")
            .unwrap_or(false)
        {
            continue;
        }
        paths.push(ancestor.join("node_modules"));
    }
    paths
}

// --- errors ----------------------------------------------------------------------------------

fn module_not_found(specifier: &str, from_file: &Path, kind: Kind) -> ResolveFailure {
    let (code, message) = if kind.is_require() {
        (
            "MODULE_NOT_FOUND",
            format!(
                "Cannot find module '{specifier}'\nRequire stack:\n- {}",
                from_file.display()
            ),
        )
    } else {
        (
            "ERR_MODULE_NOT_FOUND",
            format!(
                "Cannot find module '{specifier}' imported from {}",
                from_file.display()
            ),
        )
    };
    ResolveFailure::new(code, message, specifier).from_path(from_file)
}

fn package_path_not_exported(
    subpath: &str,
    package_path: &Path,
    from_file: &Path,
) -> ResolveFailure {
    ResolveFailure::new(
        "ERR_PACKAGE_PATH_NOT_EXPORTED",
        format!(
            "Package subpath '{subpath}' is not defined by \"exports\" in {}",
            package_path.display()
        ),
        subpath,
    )
    .from_path(from_file)
}

fn invalid_package_target(target: &Value, package_path: &Path) -> ResolveFailure {
    ResolveFailure::new(
        "ERR_INVALID_PACKAGE_TARGET",
        format!(
            "Invalid \"exports\" target {} in the package config {}",
            serde_json::to_string(target).unwrap_or_else(|_| "<unprintable>".to_owned()),
            package_path.display()
        ),
        package_path.display().to_string(),
    )
}

fn invalid_package_config(package_path: &Path, detail: &str) -> ResolveFailure {
    ResolveFailure::new(
        "ERR_INVALID_PACKAGE_CONFIG",
        format!(
            "Invalid package config {}: {detail}",
            package_path.display()
        ),
        package_path.display().to_string(),
    )
}

fn invalid_specifier(specifier: &str) -> ResolveFailure {
    ResolveFailure::new(
        "ERR_INVALID_MODULE_SPECIFIER",
        format!("Invalid module specifier '{specifier}'"),
        specifier,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_lexically() {
        assert_eq!(
            normalize_path(Path::new("/a/./b/../c")),
            PathBuf::from("/a/c")
        );
        assert_eq!(normalize_path(Path::new("/a/../..")), PathBuf::from("/"));
        assert_eq!(
            normalize_path(Path::new("a/../../b")),
            PathBuf::from("../b")
        );
        assert_eq!(normalize_path(Path::new("/a/b/")), PathBuf::from("/a/b"));
    }

    #[test]
    fn parses_bare_specifiers() {
        let bare = parse_bare_specifier("pkg").unwrap();
        assert_eq!((bare.name.as_str(), bare.subpath.as_str()), ("pkg", "."));

        let bare = parse_bare_specifier("pkg/sub").unwrap();
        assert_eq!(
            (bare.name.as_str(), bare.subpath.as_str()),
            ("pkg", "./sub")
        );

        let bare = parse_bare_specifier("@scope/pkg/sub").unwrap();
        assert_eq!(
            (bare.name.as_str(), bare.subpath.as_str()),
            ("@scope/pkg", "./sub")
        );
    }

    #[test]
    fn rejects_invalid_bare_specifiers() {
        for specifier in [
            "", ".", "..", "/abs", "./rel", "../rel", "pkg/../x", "pkg//x", "@scope",
        ] {
            assert!(
                parse_bare_specifier(specifier).is_err(),
                "{specifier} should be invalid"
            );
        }
    }

    #[test]
    fn conditions_are_ordered_per_kind() {
        assert_eq!(Kind::Require.conditions()[1], "require");
        assert_eq!(Kind::Import.conditions()[1], "import");
        assert_eq!(Kind::Require.conditions()[2], "default");
    }
}
