//! Integration tests for the resolver against real files in a temporary tree.
//!
//! The fixtures are built at test time (rather than committed) so each test states its package
//! layout inline and cannot be affected by another test. `CARGO_TARGET_TMPDIR` keeps them inside
//! the workspace, which matters for sandboxes that only allow workspace writes.

use std::fs;
use std::path::{Path, PathBuf};

use ln_modules::{Format, Kind, Resolution, Resolver};

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let root = Path::new(env!("CARGO_TARGET_TMPDIR"))
            .join("ln-modules")
            .join(name);
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create fixture root");
        Fixture { root }
    }

    fn file(&self, relative: &str, contents: &str) -> PathBuf {
        let path = self.root.join(relative);
        fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
        fs::write(&path, contents).expect("write fixture");
        path
    }

    fn dir(&self, relative: &str) -> PathBuf {
        let path = self.root.join(relative);
        fs::create_dir_all(&path).expect("create dir");
        path
    }

    fn path(&self, relative: &str) -> PathBuf {
        self.root.join(relative)
    }

    fn resolver(&self) -> Resolver {
        Resolver::new(&self.root)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn canonical(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

#[track_caller]
fn assert_file(resolution: Resolution, expected: &Path, format: Format) {
    match resolution {
        Resolution::File {
            path,
            format: actual,
        } => {
            assert_eq!(canonical(&path), canonical(expected), "resolved path");
            assert_eq!(actual, format, "format");
        }
        Resolution::Builtin(name) => panic!("expected a file, got builtin {name}"),
    }
}

#[track_caller]
fn assert_builtin(resolution: Resolution, expected: &str) {
    match resolution {
        Resolution::Builtin(name) => assert_eq!(name, expected),
        Resolution::File { path, .. } => {
            panic!("expected builtin {expected}, got {}", path.display())
        }
    }
}

#[track_caller]
fn assert_code<T: std::fmt::Debug>(result: Result<T, ln_modules::ResolveFailure>, code: &str) {
    let failure = result.expect_err("expected resolution to fail");
    assert_eq!(failure.code, code, "{}", failure.message);
}

// --- builtins ---------------------------------------------------------------------------------

#[test]
fn builtin_both_spellings() {
    let fixture = Fixture::new("builtin");
    let from = fixture.path("app.js");
    let resolver = fixture.resolver();
    assert_builtin(
        resolver.resolve("path", &from, Kind::Require).unwrap(),
        "path",
    );
    assert_builtin(
        resolver.resolve("node:path", &from, Kind::Require).unwrap(),
        "path",
    );
    assert_builtin(
        resolver.resolve("node:path", &from, Kind::Import).unwrap(),
        "path",
    );
}

#[test]
fn builtin_wins_over_node_modules() {
    let fixture = Fixture::new("builtin-shadow");
    fixture.file("node_modules/path/package.json", r#"{"main":"index.js"}"#);
    fixture.file("node_modules/path/index.js", "module.exports = 1;");
    let resolver = fixture.resolver();
    assert_builtin(
        resolver
            .resolve("path", &fixture.path("app.js"), Kind::Require)
            .unwrap(),
        "path",
    );
}

#[test]
fn unknown_node_prefixed_builtin() {
    let fixture = Fixture::new("unknown-builtin");
    let resolver = fixture.resolver();
    assert_code(
        resolver.resolve("node:not-real", &fixture.path("app.js"), Kind::Require),
        "ERR_UNKNOWN_BUILTIN_MODULE",
    );
}

// --- CommonJS paths ---------------------------------------------------------------------------

#[test]
fn require_relative_without_extension() {
    let fixture = Fixture::new("cjs-extension");
    let entry = fixture.file("app.js", "");
    fixture.file("lib/util.js", "module.exports = 1;");
    let resolver = fixture.resolver();
    assert_file(
        resolver
            .resolve("./lib/util", &entry, Kind::Require)
            .unwrap(),
        &fixture.path("lib/util.js"),
        Format::CommonJs,
    );
}

#[test]
fn require_json_and_cjs() {
    let fixture = Fixture::new("cjs-formats");
    let entry = fixture.file("app.js", "");
    fixture.file("data.json", "{}");
    fixture.file("legacy.cjs", "module.exports = 1;");
    let resolver = fixture.resolver();
    assert_file(
        resolver
            .resolve("./data.json", &entry, Kind::Require)
            .unwrap(),
        &fixture.path("data.json"),
        Format::Json,
    );
    assert_file(
        resolver.resolve("./legacy", &entry, Kind::Require).unwrap(),
        &fixture.path("legacy.cjs"),
        Format::CommonJs,
    );
}

#[test]
fn require_directory_index() {
    let fixture = Fixture::new("cjs-index");
    let entry = fixture.file("app.js", "");
    fixture.file("lib/index.js", "module.exports = 1;");
    let resolver = fixture.resolver();
    assert_file(
        resolver.resolve("./lib", &entry, Kind::Require).unwrap(),
        &fixture.path("lib/index.js"),
        Format::CommonJs,
    );
}

#[test]
fn require_package_main_and_subpath() {
    let fixture = Fixture::new("cjs-package");
    let entry = fixture.file("app.js", "");
    fixture.file(
        "node_modules/plain/package.json",
        r#"{"name":"plain","main":"lib/entry.js"}"#,
    );
    fixture.file("node_modules/plain/lib/entry.js", "");
    fixture.file("node_modules/plain/lib/other.js", "");
    let resolver = fixture.resolver();
    assert_file(
        resolver.resolve("plain", &entry, Kind::Require).unwrap(),
        &fixture.path("node_modules/plain/lib/entry.js"),
        Format::CommonJs,
    );
    assert_file(
        resolver
            .resolve("plain/lib/other", &entry, Kind::Require)
            .unwrap(),
        &fixture.path("node_modules/plain/lib/other.js"),
        Format::CommonJs,
    );
}

#[test]
fn require_package_main_missing_falls_back_to_index() {
    let fixture = Fixture::new("cjs-main-missing");
    let entry = fixture.file("app.js", "");
    fixture.file(
        "node_modules/broken/package.json",
        r#"{"main":"missing.js"}"#,
    );
    fixture.file("node_modules/broken/index.js", "");
    let resolver = fixture.resolver();
    assert_file(
        resolver.resolve("broken", &entry, Kind::Require).unwrap(),
        &fixture.path("node_modules/broken/index.js"),
        Format::CommonJs,
    );
}

#[test]
fn require_walks_node_modules_upward() {
    let fixture = Fixture::new("cjs-walk");
    let entry = fixture.file("src/deep/app.js", "");
    fixture.file("node_modules/top/index.js", "");
    let resolver = fixture.resolver();
    assert_file(
        resolver.resolve("top", &entry, Kind::Require).unwrap(),
        &fixture.path("node_modules/top/index.js"),
        Format::CommonJs,
    );
}

#[test]
fn require_scoped_package() {
    let fixture = Fixture::new("cjs-scoped");
    let entry = fixture.file("app.js", "");
    fixture.file(
        "node_modules/@scope/pkg/package.json",
        r#"{"main":"main.js"}"#,
    );
    fixture.file("node_modules/@scope/pkg/main.js", "");
    let resolver = fixture.resolver();
    assert_file(
        resolver
            .resolve("@scope/pkg", &entry, Kind::Require)
            .unwrap(),
        &fixture.path("node_modules/@scope/pkg/main.js"),
        Format::CommonJs,
    );
}

#[test]
fn require_missing_module() {
    let fixture = Fixture::new("cjs-missing");
    let entry = fixture.file("app.js", "");
    let resolver = fixture.resolver();
    assert_code(
        resolver.resolve("./nope", &entry, Kind::Require),
        "MODULE_NOT_FOUND",
    );
    assert_code(
        resolver.resolve("nope", &entry, Kind::Require),
        "MODULE_NOT_FOUND",
    );
}

// --- exports maps -----------------------------------------------------------------------------

#[test]
fn exports_string_sugar() {
    let fixture = Fixture::new("exports-sugar");
    let entry = fixture.file("app.js", "");
    fixture.file(
        "node_modules/sugar/package.json",
        r#"{"exports":"./only.js"}"#,
    );
    fixture.file("node_modules/sugar/only.js", "");
    let resolver = fixture.resolver();
    assert_file(
        resolver.resolve("sugar", &entry, Kind::Require).unwrap(),
        &fixture.path("node_modules/sugar/only.js"),
        Format::CommonJs,
    );
}

#[test]
fn exports_subpath_map() {
    let fixture = Fixture::new("exports-subpath");
    let entry = fixture.file("app.js", "");
    fixture.file(
        "node_modules/exp/package.json",
        r#"{"exports":{".":"./index.js","./feature":"./feature.js"}}"#,
    );
    fixture.file("node_modules/exp/index.js", "");
    fixture.file("node_modules/exp/feature.js", "");
    let resolver = fixture.resolver();
    assert_file(
        resolver
            .resolve("exp/feature", &entry, Kind::Require)
            .unwrap(),
        &fixture.path("node_modules/exp/feature.js"),
        Format::CommonJs,
    );
}

#[test]
fn exports_pattern_subpath() {
    let fixture = Fixture::new("exports-pattern");
    let entry = fixture.file("app.js", "");
    fixture.file(
        "node_modules/pat/package.json",
        r#"{"exports":{"./utils/*":"./lib/*.js"}}"#,
    );
    fixture.file("node_modules/pat/lib/math.js", "");
    let resolver = fixture.resolver();
    assert_file(
        resolver
            .resolve("pat/utils/math", &entry, Kind::Require)
            .unwrap(),
        &fixture.path("node_modules/pat/lib/math.js"),
        Format::CommonJs,
    );
}

#[test]
fn exports_conditions_differ_between_require_and_import() {
    let fixture = Fixture::new("exports-conditions");
    let entry = fixture.file("app.js", "");
    fixture.file(
        "node_modules/cond/package.json",
        r#"{"exports":{".":{"import":"./esm.mjs","require":"./cjs.js","default":"./fallback.js"}}}"#,
    );
    fixture.file("node_modules/cond/esm.mjs", "");
    fixture.file("node_modules/cond/cjs.js", "");
    fixture.file("node_modules/cond/fallback.js", "");
    let resolver = fixture.resolver();
    assert_file(
        resolver.resolve("cond", &entry, Kind::Require).unwrap(),
        &fixture.path("node_modules/cond/cjs.js"),
        Format::CommonJs,
    );
    assert_file(
        resolver.resolve("cond", &entry, Kind::Import).unwrap(),
        &fixture.path("node_modules/cond/esm.mjs"),
        Format::Module,
    );
}

#[test]
fn exports_nested_conditions() {
    let fixture = Fixture::new("exports-nested");
    let entry = fixture.file("app.js", "");
    fixture.file(
        "node_modules/nested/package.json",
        r#"{"exports":{".":{"node":{"import":"./node.mjs","require":"./node.cjs"},"default":"./fallback.js"}}}"#,
    );
    fixture.file("node_modules/nested/node.cjs", "");
    fixture.file("node_modules/nested/node.mjs", "");
    fixture.file("node_modules/nested/fallback.js", "");
    let resolver = fixture.resolver();
    assert_file(
        resolver.resolve("nested", &entry, Kind::Require).unwrap(),
        &fixture.path("node_modules/nested/node.cjs"),
        Format::CommonJs,
    );
    assert_file(
        resolver.resolve("nested", &entry, Kind::Import).unwrap(),
        &fixture.path("node_modules/nested/node.mjs"),
        Format::Module,
    );
}

#[test]
fn exports_blocked_and_not_exported() {
    let fixture = Fixture::new("exports-blocked");
    let entry = fixture.file("app.js", "");
    fixture.file(
        "node_modules/blocked/package.json",
        r#"{"exports":{".":"./index.js","./blocked":null}}"#,
    );
    fixture.file("node_modules/blocked/index.js", "");
    fixture.file("node_modules/blocked/secret.js", "");
    let resolver = fixture.resolver();
    assert_code(
        resolver.resolve("blocked/blocked", &entry, Kind::Require),
        "ERR_PACKAGE_PATH_NOT_EXPORTED",
    );
    // With an exports map, an unlisted file is not reachable even though it exists.
    assert_code(
        resolver.resolve("blocked/secret.js", &entry, Kind::Require),
        "ERR_PACKAGE_PATH_NOT_EXPORTED",
    );
}

#[test]
fn exports_invalid_target() {
    let fixture = Fixture::new("exports-invalid");
    let entry = fixture.file("app.js", "");
    fixture.file(
        "node_modules/badtarget/package.json",
        r#"{"exports":{".":"index.js"}}"#,
    );
    fixture.file("node_modules/badtarget/index.js", "");
    let resolver = fixture.resolver();
    assert_code(
        resolver.resolve("badtarget", &entry, Kind::Require),
        "ERR_INVALID_PACKAGE_TARGET",
    );
}

#[test]
fn exports_array_fallback_skips_null() {
    let fixture = Fixture::new("exports-array");
    let entry = fixture.file("app.js", "");
    fixture.file(
        "node_modules/arr/package.json",
        r#"{"exports":{".":[null,"./good.js"]}}"#,
    );
    fixture.file("node_modules/arr/good.js", "");
    let resolver = fixture.resolver();
    assert_file(
        resolver.resolve("arr", &entry, Kind::Require).unwrap(),
        &fixture.path("node_modules/arr/good.js"),
        Format::CommonJs,
    );
}

#[test]
fn exports_cannot_escape_package() {
    let fixture = Fixture::new("exports-escape");
    let entry = fixture.file("app.js", "");
    fixture.file(
        "node_modules/esc/package.json",
        r#"{"exports":{"./x":"./../escape.js"}}"#,
    );
    fixture.file("node_modules/escape.js", "");
    let resolver = fixture.resolver();
    assert_code(
        resolver.resolve("esc/x", &entry, Kind::Require),
        "ERR_INVALID_PACKAGE_TARGET",
    );
}

// --- package imports (`#`) --------------------------------------------------------------------

#[test]
fn imports_exact_and_pattern() {
    let fixture = Fixture::new("imports");
    let entry = fixture.file(
        "package.json",
        r##"{"name":"app","type":"module","imports":{"#internal":"./src/internal.js","#dep/*":"./src/dep/*.js"}}"##,
    );
    fixture.file("src/internal.js", "");
    fixture.file("src/dep/a.js", "");
    let resolver = fixture.resolver();
    assert_file(
        resolver.resolve("#internal", &entry, Kind::Import).unwrap(),
        &fixture.path("src/internal.js"),
        Format::Module,
    );
    assert_file(
        resolver.resolve("#dep/a", &entry, Kind::Import).unwrap(),
        &fixture.path("src/dep/a.js"),
        Format::Module,
    );
}

#[test]
fn imports_conditional_can_target_builtin() {
    let fixture = Fixture::new("imports-builtin");
    let entry = fixture.file(
        "package.json",
        r##"{"name":"app","imports":{"#path":{"node":"node:path","default":"./fallback.js"}}}"##,
    );
    fixture.file("app.js", "");
    fixture.file("fallback.js", "");
    let resolver = fixture.resolver();
    assert_builtin(
        resolver.resolve("#path", &entry, Kind::Import).unwrap(),
        "path",
    );
}

#[test]
fn imports_missing_is_an_error() {
    let fixture = Fixture::new("imports-missing");
    let entry = fixture.file(
        "package.json",
        r##"{"name":"app","imports":{"#known":"./known.js"}}"##,
    );
    let resolver = fixture.resolver();
    assert_code(
        resolver.resolve("#unknown", &entry, Kind::Import),
        "ERR_PACKAGE_IMPORT_NOT_DEFINED",
    );
}

#[test]
fn imports_pattern_can_target_package() {
    let fixture = Fixture::new("imports-package");
    let entry = fixture.file(
        "package.json",
        r##"{"name":"app","imports":{"#dep":"dep"}}"##,
    );
    fixture.file("node_modules/dep/package.json", r#"{"main":"index.js"}"#);
    fixture.file("node_modules/dep/index.js", "");
    let resolver = fixture.resolver();
    assert_file(
        resolver.resolve("#dep", &entry, Kind::Import).unwrap(),
        &fixture.path("node_modules/dep/index.js"),
        Format::CommonJs,
    );
}

// --- ESM rules --------------------------------------------------------------------------------

#[test]
fn esm_does_not_search_extensions() {
    let fixture = Fixture::new("esm-extension");
    let entry = fixture.file("app.mjs", "");
    fixture.file("lib/util.js", "");
    let resolver = fixture.resolver();
    assert_code(
        resolver.resolve("./lib/util", &entry, Kind::Import),
        "ERR_MODULE_NOT_FOUND",
    );
    assert_file(
        resolver
            .resolve("./lib/util.js", &entry, Kind::Import)
            .unwrap(),
        &fixture.path("lib/util.js"),
        Format::CommonJs,
    );
}

#[test]
fn esm_directory_import_is_its_own_error() {
    let fixture = Fixture::new("esm-directory");
    let entry = fixture.file("app.mjs", "");
    fixture.dir("lib");
    let resolver = fixture.resolver();
    assert_code(
        resolver.resolve("./lib", &entry, Kind::Import),
        "ERR_UNSUPPORTED_DIR_IMPORT",
    );
}

#[test]
fn esm_file_url() {
    let fixture = Fixture::new("esm-url");
    let entry = fixture.file("app.mjs", "");
    let target = fixture.file("lib.js", "");
    let url = ln_modules::url::path_to_file_url(&target);
    let resolver = fixture.resolver();
    assert_file(
        resolver.resolve(&url, &entry, Kind::Import).unwrap(),
        &target,
        Format::CommonJs,
    );
}

#[test]
fn package_type_module_makes_js_esm() {
    let fixture = Fixture::new("type-module");
    fixture.file("package.json", r#"{"type":"module"}"#);
    let entry = fixture.file("app.js", "");
    fixture.file("lib.js", "");
    let resolver = fixture.resolver();
    assert_file(
        resolver.resolve("./lib.js", &entry, Kind::Import).unwrap(),
        &fixture.path("lib.js"),
        Format::Module,
    );
    // `require()` still resolves it (the load phase produces ERR_REQUIRE_ESM), so the caller can
    // report the right code instead of a bare "not found".
    assert_file(
        resolver.resolve("./lib.js", &entry, Kind::Require).unwrap(),
        &fixture.path("lib.js"),
        Format::Module,
    );
    // `.cjs` is always CommonJS, even under "type": "module".
    fixture.file("legacy.cjs", "");
    assert_file(
        resolver
            .resolve("./legacy.cjs", &entry, Kind::Require)
            .unwrap(),
        &fixture.path("legacy.cjs"),
        Format::CommonJs,
    );
}

#[test]
fn esm_unknown_extension_is_an_error() {
    let fixture = Fixture::new("esm-unknown-ext");
    let entry = fixture.file("app.mjs", "");
    fixture.file("data.txt", "");
    let resolver = fixture.resolver();
    assert_code(
        resolver.resolve("./data.txt", &entry, Kind::Import),
        "ERR_UNKNOWN_FILE_EXTENSION",
    );
}

#[test]
fn esm_relative_import_from_file_url_base() {
    let fixture = Fixture::new("esm-url-base");
    let entry = fixture.file("src/app.mjs", "");
    fixture.file("src/dep.js", "");
    let resolver = fixture.resolver();
    let base = ln_modules::url::path_to_file_url(&entry);
    assert_file(
        resolver
            .resolve("./dep.js", Path::new(&base), Kind::Import)
            .unwrap(),
        &fixture.path("src/dep.js"),
        Format::CommonJs,
    );
}

// --- entries -----------------------------------------------------------------------------------

#[test]
fn resolve_entry_returns_absolute_canonical_path() {
    let fixture = Fixture::new("entry");
    fixture.file("main.js", "");
    let resolver = fixture.resolver();
    let (path, format) = resolver.resolve_entry(Path::new("main.js")).unwrap();
    assert_eq!(canonical(&path), canonical(&fixture.path("main.js")));
    assert_eq!(format, Format::CommonJs);
}

#[test]
fn resolve_entry_missing() {
    let fixture = Fixture::new("entry-missing");
    let resolver = fixture.resolver();
    assert_code(
        resolver.resolve_entry(Path::new("nope.js")),
        "MODULE_NOT_FOUND",
    );
}
