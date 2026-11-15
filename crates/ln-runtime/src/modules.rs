//! ESM loading and the embedded stdlib registry.
//!
//! QuickJS resolves and loads modules through the callbacks installed here. Resolution is
//! delegated to `ln-modules`; this file only maps the resolver's result onto the engine's
//! canonical module names (`file:` URLs for disk, `node:` names for builtins), reads sources,
//! and generates the ESM facades used for CJS and builtin interop.
//!
//! Facades are source strings, not native modules, because QuickJS does not expose a way to
//! attach a Rust-created namespace to a module. They are tiny and evaluated by the same module
//! machinery, so live-binding rules (module scope, cycles) are the engine's, not ours.

use std::cell::RefCell;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use ln_engine::{js, Engine};
use ln_modules::url as file_url;
use ln_modules::{Format, Kind, Resolution, Resolver};

use crate::host_error::throw_node_error;

/// The embedded JavaScript sources.
///
/// `path/posix`, `path/win32` and `assert/strict` are one-line facades so their public object is
/// the same object the parent module exposes (`path.posix`), not a copy.
pub(crate) fn builtin_source(name: &str) -> Option<&'static str> {
    let source = match name {
        "path" => include_str!("../../../js/lib/path.js"),
        "path/posix" => "module.exports = require(\"path\").posix;",
        "path/win32" => "module.exports = require(\"path\").win32;",
        "url" => include_str!("../../../js/lib/url.js"),
        "punycode" => include_str!("../../../js/lib/punycode.js"),
        "querystring" => include_str!("../../../js/lib/querystring.js"),
        "util" => include_str!("../../../js/lib/util.js"),
        "assert" => include_str!("../../../js/lib/assert.js"),
        "assert/strict" => "module.exports = require(\"assert\").strict;",
        "events" => include_str!("../../../js/lib/events.js"),
        "fs" => include_str!("../../../js/lib/fs.js"),
        "fs/promises" => include_str!("../../../js/lib/fs-promises.js"),
        "stream" => include_str!("../../../js/lib/stream.js"),
        "stream/promises" => include_str!("../../../js/lib/stream-promises.js"),
        "tty" => include_str!("../../../js/lib/tty.js"),
        "perf_hooks" => include_str!("../../../js/lib/perf_hooks.js"),
        "string_decoder" => include_str!("../../../js/lib/string_decoder.js"),
        "buffer" => include_str!("../../../js/lib/buffer.js"),
        "constants" => include_str!("../../../js/lib/constants.js"),
        "crypto" => include_str!("../../../js/lib/crypto.js"),
        "dns" => include_str!("../../../js/lib/dns.js"),
        "os" => include_str!("../../../js/lib/os.js"),
        "console" => include_str!("../../../js/lib/console.js"),
        "module" => include_str!("../../../js/lib/module.js"),
        "http" => include_str!("../../../js/lib/http.js"),
        "https" => include_str!("../../../js/lib/https.js"),
        "tls" => include_str!("../../../js/lib/tls.js"),
        "net" => include_str!("../../../js/lib/net.js"),
        "zlib" => include_str!("../../../js/lib/zlib.js"),
        "internal/loader" | "loader" => include_str!("../../../js/lib/loader.js"),
        "internal/fs" => include_str!("../../../js/lib/internal/fs.js"),
        "internal/http" => include_str!("../../../js/lib/internal/http.js"),
        "internal/net" => include_str!("../../../js/lib/internal/net.js"),
        "internal/process" | "process" => include_str!("../../../js/lib/process.js"),
        "internal/globals" | "globals" => include_str!("../../../js/lib/globals.js"),
        "internal/textcodec" | "textcodec" => include_str!("../../../js/lib/textcodec.js"),
        _ => return None,
    };
    Some(source)
}

/// Per-isolate module state shared by the resolver and loader callbacks.
pub(crate) struct ModuleRuntime {
    pub resolver: Resolver,
    /// Canonical module name -> how to load it. Filled by the resolver callback.
    resolved: RefCell<HashMap<String, Resolution>>,
}

impl ModuleRuntime {
    pub fn new(cwd: impl Into<PathBuf>) -> Rc<Self> {
        Rc::new(ModuleRuntime {
            resolver: Resolver::new(cwd),
            resolved: RefCell::new(HashMap::new()),
        })
    }

    /// Install the engine's module loader. Called once, before the bootstrap runs.
    pub fn install(self: &Rc<Self>, engine: &Engine) {
        engine.set_module_loader(
            EsmResolver {
                state: self.clone(),
            },
            EsmLoader {
                state: self.clone(),
            },
        );
    }
}

struct EsmResolver {
    state: Rc<ModuleRuntime>,
}

impl js::loader::Resolver for EsmResolver {
    fn resolve<'js>(
        &mut self,
        ctx: &js::Ctx<'js>,
        base: &str,
        name: &str,
        _attributes: Option<js::loader::ImportAttributes<'js>>,
    ) -> js::Result<String> {
        match self
            .state
            .resolver
            .resolve(name, Path::new(base), Kind::Import)
        {
            Ok(Resolution::Builtin(builtin)) => Ok(format!("node:{builtin}")),
            Ok(resolution @ Resolution::File { .. }) => {
                let path = resolution.path().expect("file resolution has a path");
                let canonical = file_url::path_to_file_url(path);
                self.state
                    .resolved
                    .borrow_mut()
                    .insert(canonical.clone(), resolution);
                Ok(canonical)
            }
            Err(failure) => Err(throw_node_error(ctx, failure.code, &failure.message)),
        }
    }
}

struct EsmLoader {
    state: Rc<ModuleRuntime>,
}

impl js::loader::Loader for EsmLoader {
    fn load<'js>(
        &mut self,
        ctx: &js::Ctx<'js>,
        name: &str,
        _attributes: Option<js::loader::ImportAttributes<'js>>,
    ) -> js::Result<js::Module<'js, js::module::Declared>> {
        let resolution = self.state.resolved.borrow().get(name).cloned();

        if let Some(resolution) = resolution {
            return match resolution {
                Resolution::Builtin(builtin) => load_builtin(ctx, name, builtin),
                Resolution::File { path, format } => match format {
                    Format::CommonJs => load_cjs_facade(ctx, name, &path),
                    Format::Json => load_json_module(ctx, name, &path),
                    Format::Module => load_esm_module(ctx, name, &path),
                    Format::Native => Err(throw_node_error(
                        ctx,
                        "ERR_DLOPEN_FAILED",
                        &format!(
                            "Cannot load native addon '{}': onde does not support N-API modules",
                            path.display()
                        ),
                    )),
                },
            };
        }

        // A name can reach the loader without passing through our resolver: entry evaluation
        // uses `Module::declare`, and QuickJS may ask for `node:` names directly. Both cases are
        // handled here from the name alone.
        if let Some(builtin) = name.strip_prefix("node:") {
            return load_builtin(ctx, name, builtin);
        }
        let path = file_url::file_url_to_path(name)
            .map_err(|message| throw_node_error(ctx, "ERR_INVALID_FILE_URL_PATH", &message))?;
        load_esm_module(ctx, name, &path)
    }
}

fn load_builtin<'js>(
    ctx: &js::Ctx<'js>,
    canonical: &str,
    builtin: &str,
) -> js::Result<js::Module<'js, js::module::Declared>> {
    if builtin_source(builtin).is_none() && builtin != "process" {
        return Err(throw_node_error(
            ctx,
            "ERR_UNKNOWN_BUILTIN_MODULE",
            &format!("No such built-in module: {canonical}"),
        ));
    }

    // Load the CJS implementation now so the facade can export its names. This runs during
    // linking, which is legal: the builtin sources are synchronous and side-effect free.
    let mut lines = String::new();
    let names: js::Array = call_global(
        ctx,
        "__ln_builtin_export_names",
        (format!("node:{builtin}"),),
    )?;
    for name in names.iter::<String>() {
        let name = name?;
        // Underscore-prefixed helpers are onde internals, not part of the builtin's API.
        if name == "default"
            || name == "__esModule"
            || name.starts_with('_')
            || !is_identifier(&name)
        {
            continue;
        }
        lines.push_str(&format!("export const {name} = ns.{name};\n"));
    }

    let source = format!(
        "const ns = __ln_builtin_exports({});\nexport default ns;\n{lines}",
        js_string_literal(&format!("node:{builtin}"))
    );
    let module = js::Module::declare(ctx.clone(), canonical, source)?;
    meta(ctx, &module, canonical, None)?;
    Ok(module)
}

fn load_cjs_facade<'js>(
    ctx: &js::Ctx<'js>,
    canonical: &str,
    path: &Path,
) -> js::Result<js::Module<'js, js::module::Declared>> {
    let source = read_source(ctx, path)?;
    let mut lines = String::new();
    for name in ln_modules::scan_named_exports(&source) {
        lines.push_str(&format!("export const {name} = ns.{name};\n"));
    }

    // `default` is the whole `module.exports`, exactly like Node's ESM↔CJS interop.
    let facade = format!(
        "const ns = __ln_cjs_namespace({});\nexport default ns;\n{lines}",
        js_string_literal(&path.display().to_string())
    );
    let module = js::Module::declare(ctx.clone(), canonical, facade)?;
    meta(ctx, &module, canonical, Some(path))?;
    Ok(module)
}

fn load_json_module<'js>(
    ctx: &js::Ctx<'js>,
    canonical: &str,
    path: &Path,
) -> js::Result<js::Module<'js, js::module::Declared>> {
    // Node's JSON loader tolerates a UTF-8 BOM; `JSON.parse` does not.
    let text = read_source(ctx, path)?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let literal = js_string_literal(text);
    let source = format!("const data = JSON.parse({literal});\nexport default data;\n");
    let module = js::Module::declare(ctx.clone(), canonical, source)?;
    meta(ctx, &module, canonical, Some(path))?;
    Ok(module)
}

fn load_esm_module<'js>(
    ctx: &js::Ctx<'js>,
    canonical: &str,
    path: &Path,
) -> js::Result<js::Module<'js, js::module::Declared>> {
    let source = read_source(ctx, path)?;
    let module = js::Module::declare(ctx.clone(), canonical, source)?;
    meta(ctx, &module, canonical, Some(path))?;
    Ok(module)
}

/// Set `import.meta` for a loaded module.
fn meta<'js>(
    ctx: &js::Ctx<'js>,
    module: &js::Module<'js, js::module::Declared>,
    url: &str,
    path: Option<&Path>,
) -> js::Result<()> {
    let meta = module.meta()?;
    meta.set("url", url)?;
    if let Some(path) = path {
        meta.set("filename", path.display().to_string())?;
        if let Some(parent) = path.parent() {
            meta.set("dirname", parent.display().to_string())?;
        }
    }
    meta.set("main", false)?;
    meta.set("resolve", ln_engine::meta_resolve_function(ctx, url)?)?;
    Ok(())
}

fn read_source<'js>(ctx: &js::Ctx<'js>, path: &Path) -> js::Result<String> {
    fs::read_to_string(path).map_err(|error| {
        let code = crate::host_error::io_error_code(&error);
        throw_node_error(
            ctx,
            code,
            &crate::host_error::io_error_message(code, "open", path, &error),
        )
    })
}

fn call_global<'js, A, R>(ctx: &js::Ctx<'js>, name: &str, args: A) -> js::Result<R>
where
    A: js::function::IntoArgs<'js>,
    R: js::FromJs<'js>,
{
    let function: js::Function = ctx.globals().get(name)?;
    function.call(args)
}

/// JSON.stringify a string, producing a JavaScript string literal with correct escaping.
fn js_string_literal(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_owned())
}

fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() || first == '_' || first == '$' => {}
        _ => return false,
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '$')
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The registry and the embedded sources must not drift: an entry in `BUILTINS` without an
    /// `include_str!` arm resolves as a builtin and then fails at load time.
    #[test]
    fn every_builtin_has_an_embedded_source() {
        for name in ln_modules::BUILTINS {
            assert!(
                builtin_source(name).is_some(),
                "BUILTINS lists {name} but modules::builtin_source has no arm for it"
            );
        }
    }

    #[test]
    fn internal_fs_is_reachable_without_being_public() {
        assert!(builtin_source("internal/fs").is_some());
        assert_eq!(ln_modules::lookup_builtin("internal/fs"), None);
        assert_eq!(ln_modules::lookup_builtin("fs"), Some("fs"));
        assert_eq!(
            ln_modules::lookup_builtin("node:fs/promises"),
            Some("fs/promises")
        );
    }
}
