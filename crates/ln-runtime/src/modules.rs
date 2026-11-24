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
/// Include one bundled JS file: the minified artifact `build.rs` wrote to `OUT_DIR/js`.
macro_rules! bundled_js {
    ($path:literal) => {
        include_str!(concat!(env!("OUT_DIR"), "/js/", $path))
    };
}

pub(crate) fn builtin_source(name: &str) -> Option<&'static str> {
    let source = match name {
        "path" => bundled_js!("lib/path.js"),
        "path/posix" => "module.exports = require(\"path\").posix;",
        "path/win32" => "module.exports = require(\"path\").win32;",
        "url" => bundled_js!("lib/url.js"),
        "punycode" => bundled_js!("lib/punycode.js"),
        "querystring" => bundled_js!("lib/querystring.js"),
        "util" => bundled_js!("lib/util.js"),
        "assert" => bundled_js!("lib/assert.js"),
        "assert/strict" => "module.exports = require(\"assert\").strict;",
        "async_hooks" => bundled_js!("lib/async_hooks.js"),
        "events" => bundled_js!("lib/events.js"),
        "fs" => bundled_js!("lib/fs.js"),
        "fs/promises" => bundled_js!("lib/fs-promises.js"),
        "readline" => bundled_js!("lib/readline.js"),
        "readline/promises" => bundled_js!("lib/readline-promises.js"),
        "stream" => bundled_js!("lib/stream.js"),
        "stream/promises" => bundled_js!("lib/stream-promises.js"),
        "tty" => bundled_js!("lib/tty.js"),
        "perf_hooks" => bundled_js!("lib/perf_hooks.js"),
        "string_decoder" => bundled_js!("lib/string_decoder.js"),
        "test" => bundled_js!("lib/test.js"),
        "buffer" => bundled_js!("lib/buffer.js"),
        "constants" => bundled_js!("lib/constants.js"),
        "crypto" => bundled_js!("lib/crypto.js"),
        "dns" => bundled_js!("lib/dns.js"),
        "os" => bundled_js!("lib/os.js"),
        "console" => bundled_js!("lib/console.js"),
        "module" => bundled_js!("lib/module.js"),
        "http" => bundled_js!("lib/http.js"),
        "https" => bundled_js!("lib/https.js"),
        "tls" => bundled_js!("lib/tls.js"),
        "net" => bundled_js!("lib/net.js"),
        "worker_threads" => bundled_js!("lib/worker_threads.js"),
        "child_process" => bundled_js!("lib/child_process.js"),
        "zlib" => bundled_js!("lib/zlib.js"),
        "internal/loader" | "loader" => bundled_js!("lib/loader.js"),
        "internal/errors" => bundled_js!("lib/internal/errors.js"),
        "internal/bytes" => bundled_js!("lib/internal/bytes.js"),
        "internal/fs" => bundled_js!("lib/internal/fs.js"),
        "internal/http" => bundled_js!("lib/internal/http.js"),
        "internal/net" => bundled_js!("lib/internal/net.js"),
        "internal/worker" => bundled_js!("lib/internal/worker.js"),
        "internal/pipe" => bundled_js!("lib/internal/pipe.js"),
        "internal/process" | "process" => bundled_js!("lib/process.js"),
        "internal/globals" | "globals" => bundled_js!("lib/globals.js"),
        "internal/textcodec" | "textcodec" => bundled_js!("lib/textcodec.js"),
        _ => return None,
    };
    Some(source)
}

/// Per-isolate module state shared by the resolver and loader callbacks.
pub(crate) struct ModuleRuntime {
    pub resolver: Resolver,
    /// Canonical module name -> how to load it. Filled by the resolver callback.
    resolved: RefCell<HashMap<String, Resolution>>,
    /// Set when the process was linked with a payload: modules come from here, never from disk.
    payload: RefCell<Option<Rc<PayloadImage>>>,
}

/// A payload, parsed and checked against the linked engine.
pub(crate) struct PayloadImage {
    pub(crate) payload: ln_payload::Payload<'static>,
}

/// Why a payload cannot be run by this runtime.
pub(crate) enum PayloadFailure {
    /// Built for a different engine: its bytecode must not be read (exit 78).
    Abi(String),
    /// Truncated, corrupt, or a format this runtime does not read.
    Corrupt(String),
}

impl ModuleRuntime {
    pub fn new(cwd: impl Into<PathBuf>) -> Rc<Self> {
        Rc::new(ModuleRuntime {
            resolver: Resolver::new(cwd),
            resolved: RefCell::new(HashMap::new()),
            payload: RefCell::new(None),
        })
    }

    /// Switch this runtime into compiled mode: modules come from `bytes`, never from disk.
    ///
    /// The identity check happens **before** the first `JS_ReadObject`, because the engine's
    /// bytecode reader is not a defensive parser: bytecode from another build is undefined
    /// behaviour, not an error it can report. A compressed payload is inflated here, once, and
    /// leaked: QuickJS reads module bytecode in place, so it must outlive every module object.
    pub fn set_payload(self: &Rc<Self>, bytes: &'static [u8]) -> Result<(), PayloadFailure> {
        let image: &'static [u8] = match ln_payload::Payload::parse(bytes) {
            Ok(ln_payload::Parsed::Image(_)) => bytes,
            Ok(ln_payload::Parsed::Compressed {
                total_len,
                codec,
                stream,
            }) => {
                // The stream covers everything after the header, and the runtime needs the whole
                // image back (the parser reads the header too), so rebuild it with the compressed
                // bit cleared.
                let body_len = total_len
                    .checked_sub(ln_payload::HEADER_LEN)
                    .ok_or_else(|| {
                        PayloadFailure::Corrupt(format!(
                            "payload header claims {total_len} bytes, less than the header"
                        ))
                    })?;
                // The image is built once: header first, then the body decoded straight into the
                // same allocation. No second buffer, no copy.
                let mut image = Vec::with_capacity(total_len);
                image.extend_from_slice(&bytes[..ln_payload::HEADER_LEN]);
                match codec {
                    ln_payload::Codec::Zlib => {
                        ln_zlib::decompress_into(
                            ln_zlib::Format::Zlib,
                            stream,
                            &mut image,
                            body_len,
                        )
                        .map_err(|error| {
                            PayloadFailure::Corrupt(format!("cannot inflate zlib payload: {error}"))
                        })?;
                    }
                    ln_payload::Codec::Zstd => decompress_zstd_into(stream, &mut image, body_len)?,
                }
                if image.len() != total_len {
                    return Err(PayloadFailure::Corrupt(format!(
                        "payload inflated to {} bytes, expected {total_len}",
                        image.len()
                    )));
                }
                image[10] &= !(ln_payload::FLAG_COMPRESSED as u8);
                &*Box::leak(image.into_boxed_slice())
            }
            Err(error) => return Err(PayloadFailure::Corrupt(error.to_string())),
        };

        let payload = match ln_payload::Payload::parse(image) {
            Ok(ln_payload::Parsed::Image(payload)) => payload,
            Ok(ln_payload::Parsed::Compressed { .. }) => {
                return Err(PayloadFailure::Corrupt(
                    "a decompressed payload still says it is compressed".to_owned(),
                ))
            }
            Err(error) => return Err(PayloadFailure::Corrupt(error.to_string())),
        };

        payload
            .check_engine(&ln_engine::engine_stamp_parsed())
            .map_err(|error| PayloadFailure::Abi(error.to_string()))?;

        *self.payload.borrow_mut() = Some(Rc::new(PayloadImage { payload }));
        Ok(())
    }

    /// The payload, when this process was compiled.
    pub fn payload(&self) -> Option<Rc<PayloadImage>> {
        self.payload.borrow().clone()
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
        if let Some(payload) = self.state.payload() {
            return resolve_in_payload(ctx, &payload, base, name);
        }

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
        if let Some(payload) = self.state.payload() {
            return load_from_payload(ctx, &payload, name);
        }

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

/// Compiled mode: resolve a specifier against the payload's key table.
///
/// There is no disk and no `node_modules`. Builtins resolve to `node:` names; relative and
/// absolute specifiers resolve inside the table; everything else is `ERR_MODULE_NOT_FOUND` with
/// both the importer and the key that was tried, because a compiled app's most common failure is
/// a dependency the bundler left unresolved.
fn resolve_in_payload<'js>(
    ctx: &js::Ctx<'js>,
    image: &PayloadImage,
    base: &str,
    specifier: &str,
) -> js::Result<String> {
    if let Some(builtin) = ln_modules::builtin::lookup(specifier) {
        return Ok(format!("node:{builtin}"));
    }
    if let Some(name) = ln_modules::builtin::strip_prefix(specifier) {
        return Err(throw_node_error(
            ctx,
            "ERR_UNKNOWN_BUILTIN_MODULE",
            &format!("No such built-in module: node:{name}"),
        ));
    }

    let base_key = payload_key(base);
    let Some(key) = ln_payload::resolve_key(base_key, specifier) else {
        return Err(missing_payload_module(ctx, specifier, base_key, None));
    };
    if image.payload.contains(&key) {
        Ok(payload_url(&key))
    } else {
        Err(missing_payload_module(ctx, specifier, base_key, Some(&key)))
    }
}

fn missing_payload_module<'js>(
    ctx: &js::Ctx<'js>,
    specifier: &str,
    importer: &str,
    key: Option<&str>,
) -> js::Error {
    let mut message = format!("Cannot find module '{specifier}' imported from {importer}");
    match key {
        Some(key) => {
            message.push_str(&format!("\n  the payload has no module with key '{key}'"));
        }
        None => message.push_str(
            "\n  a compiled app has no node_modules: only builtins and payload keys resolve",
        ),
    }
    throw_node_error(ctx, "ERR_MODULE_NOT_FOUND", &message)
}

/// Compiled mode: load one payload module by its canonical name.
fn load_from_payload<'js>(
    ctx: &js::Ctx<'js>,
    image: &PayloadImage,
    name: &str,
) -> js::Result<js::Module<'js, js::module::Declared>> {
    // QuickJS asks for `node:` names directly (import statements in bytecode are not re-resolved
    // through the resolver), so the builtin path has to exist here too.
    if let Some(builtin) = name.strip_prefix("node:") {
        return load_builtin(ctx, name, builtin);
    }

    let key = payload_key(name);
    let entry = image
        .payload
        .get(key)
        .ok_or_else(|| missing_payload_module(ctx, name, name, Some(key)))?;

    match entry.kind {
        ln_payload::Kind::Bytecode => {
            // SAFETY: `entry.body` is module bytecode from a payload whose engine identity was
            // checked in `set_payload`, and whose structural invariants were checked by
            // `ln_payload`. QuickJS reads it in place (`JS_READ_OBJ_ROM_DATA`), which is why the
            // payload is `'static`.
            let module = unsafe { js::Module::load(ctx.clone(), entry.body) }?;
            match module.name::<String>() {
                Ok(actual) if actual != name => {
                    return Err(throw_node_error(
                        ctx,
                        "ERR_INVALID_MODULE_SPECIFIER",
                        &format!(
                            "payload module '{key}' is named '{actual}' in its bytecode, but the \
                             table looks it up as '{name}'"
                        ),
                    ))
                }
                Ok(_) => {}
                Err(error) => return Err(error),
            }
            meta_payload(ctx, &module, name, key)?;
            Ok(module)
        }
        ln_payload::Kind::Source => {
            let source = std::str::from_utf8(entry.body).map_err(|_| {
                throw_node_error(
                    ctx,
                    "ERR_INVALID_MODULE_SPECIFIER",
                    &format!("payload module '{key}' is not UTF-8"),
                )
            })?;
            let module = js::Module::declare(ctx.clone(), name, source)?;
            meta_payload(ctx, &module, name, key)?;
            Ok(module)
        }
    }
}

/// `import.meta` for a payload module: names from the key table, not filesystem paths.
fn meta_payload<'js>(
    ctx: &js::Ctx<'js>,
    module: &js::Module<'js, js::module::Declared>,
    url: &str,
    key: &str,
) -> js::Result<()> {
    let meta = module.meta()?;
    meta.set("url", url)?;
    meta.set("filename", key)?;
    meta.set("dirname", ln_payload::dirname(key))?;
    meta.set("main", false)?;
    meta.set("resolve", ln_engine::meta_resolve_function(ctx, url)?)?;
    Ok(())
}

/// Decode a zstd payload body.
///
/// Feature-gated: zstd is the one decoder that is not already in the image, so a runtime built
/// without it must say so rather than fail halfway through `JS_ReadObject`.
#[cfg(feature = "zstd")]
fn decompress_zstd_into(
    stream: &[u8],
    out: &mut Vec<u8>,
    body_len: usize,
) -> Result<(), PayloadFailure> {
    use std::io::Read as _;

    let decoder = zstd::stream::read::Decoder::new(stream).map_err(|error| {
        PayloadFailure::Corrupt(format!("cannot start the zstd decoder: {error}"))
    })?;
    // One byte past the promised length, so an over-long stream is detected rather than truncated.
    decoder
        .take(body_len as u64 + 1)
        .read_to_end(out)
        .map_err(|error| {
            PayloadFailure::Corrupt(format!("cannot inflate zstd payload: {error}"))
        })?;
    Ok(())
}

#[cfg(not(feature = "zstd"))]
fn decompress_zstd_into(
    _stream: &[u8],
    _out: &mut Vec<u8>,
    _body_len: usize,
) -> Result<(), PayloadFailure> {
    Err(PayloadFailure::Corrupt(
        "this payload is zstd-compressed, but this runtime was built without the zstd decoder; \
         rebuild the app with `--compress zlib` or link a runtime that has it"
            .to_owned(),
    ))
}

/// The `file:///<key>` form of a payload key.
fn payload_url(key: &str) -> String {
    format!("file:///{key}")
}

/// The key a canonical module name refers to.
fn payload_key(name: &str) -> &str {
    name.strip_prefix("file:///").unwrap_or(name)
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

    /// `internal/errors` is the shared JS error vocabulary: embedded and reachable from the
    /// virtual tree, but not part of the public builtin namespace.
    #[test]
    fn internal_errors_is_reachable_without_being_public() {
        assert!(builtin_source("internal/errors").is_some());
        assert_eq!(ln_modules::lookup_builtin("internal/errors"), None);
    }

    #[test]
    fn internal_bytes_is_reachable_without_being_public() {
        assert!(builtin_source("internal/bytes").is_some());
        assert_eq!(ln_modules::lookup_builtin("internal/bytes"), None);
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
