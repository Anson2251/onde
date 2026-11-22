//! Compile ES modules to QuickJS bytecode, without evaluating them.
//!
//! This is what `ondec` calls for every asset in a bundle. It is deliberately separate from
//! [`crate::Engine`]:
//!
//! - it never installs a module loader or evaluates anything, so a malicious or broken bundle only
//!   ever reaches the parser;
//! - it runs in its own `Runtime`/`Context`, so the build tool's state cannot leak into the bytecode
//!   (no globals, no stdlib, no prototype mutations);
//! - the bytecode it writes is what the app's runtime will read, so `ondec` and the SDK must be the
//!   same engine. That is the ABI stamp's job ([`crate::engine_stamp`]), not this module's.
//!
//! # What the bytecode contains
//!
//! The serialized module keeps its **name** (QuickJS registers a module by name, and the payload's
//! loader looks modules up by canonical name), the compiled function, its imports as atoms, and —
//! unless [`Options::strip_source`] is set — the original source for stack traces and
//! `Function.prototype.toString`.
//!
//! A module that imports `./worker.js` compiles fine: the import is a specifier in the bytecode,
//! not a resolved path. Resolution happens at run time against the payload's key table.

use ln_abi::Endian;

use crate::js;
use crate::{caught_from_error, CaughtError};

/// How to compile one module.
#[derive(Debug, Clone)]
pub struct Options {
    /// The canonical module name. In a compiled app this is `file:///<payload key>`: it must be the
    /// same string the loader will look the module up by, because QuickJS stores it in the
    /// bytecode and in its module registry.
    pub name: String,
    /// Keep the original source in the bytecode (default). `false` drops stack locations as well
    /// as `toString`, so it is a size emergency switch, not a normal mode.
    pub strip_source: bool,
    /// Byte order of the bytecode. Every v1 cell is little-endian; the field exists so a
    /// cross-compile writes the target's order rather than the build machine's.
    pub endian: Endian,
}

impl Options {
    /// Options for one module, compiled for this machine's byte order.
    pub fn new(name: impl Into<String>) -> Options {
        Options {
            name: name.into(),
            strip_source: false,
            endian: if cfg!(target_endian = "big") {
                Endian::Big
            } else {
                Endian::Little
            },
        }
    }
}

/// Compile one ES module to bytecode.
///
/// The returned bytes are a QuickJS module object, ready for `Module::load`. They are tied to the
/// engine build that produced them: same `BC_VERSION`, same atom table, same byte order.
///
/// A parse error is returned as a [`CaughtError`] carrying the runtime's diagnostics (name,
/// message, `stack` with the source excerpt), so `ondec` can print a build error that looks like a
/// run-time error.
pub fn module(source: &str, options: &Options) -> Result<Vec<u8>, CaughtError> {
    let scratch = Scratch::new()?;

    // A leading `#!` is a shebang, which a module cannot have; the runtime strips it too, so a
    // bundle that carries one compiles to the same bytecode the runtime would have parsed.
    let source = crate::strip_source_prefix(source);

    scratch.context.with(|ctx| {
        let declared = js::Module::declare(ctx.clone(), options.name.clone(), source)
            .map_err(|error| caught_from_error(&ctx, error))?;

        let write = js::WriteOptions {
            endianness: match options.endian {
                Endian::Little => js::WriteOptionsEndianness::Little,
                Endian::Big => js::WriteOptionsEndianness::Big,
            },
            strip_source: options.strip_source,
            ..Default::default()
        };
        declared
            .write(write)
            .map_err(|error| caught_from_error(&ctx, error))
    })
}

/// The name baked into a bytecode module.
///
/// The loader compares it with the payload key before evaluating, because a mismatch would create
/// a module under one name and look it up under another.
pub fn module_name(bytes: &[u8]) -> Result<String, CaughtError> {
    let scratch = Scratch::new()?;
    scratch.context.with(|ctx| {
        // SAFETY: the caller passes bytes this crate produced (`module`). Reading a malformed
        // stream is the one thing a caller must not do; the runtime's equivalents check the
        // payload's engine identity and structure first.
        let declared = unsafe { js::Module::load(ctx.clone(), bytes) }
            .map_err(|error| caught_from_error(&ctx, error))?;
        declared
            .name::<String>()
            .map_err(|error| caught_from_error(&ctx, error))
    })
}

/// A throwaway engine for compilation: one runtime, one context, stubs for imports.
///
/// Field order is drop order: the context goes first, then the runtime that owns it.
struct Scratch {
    context: js::Context,
    #[allow(
        dead_code,
        reason = "kept alive for the context; dropping it frees the engine"
    )]
    runtime: js::Runtime,
}

impl Scratch {
    fn new() -> Result<Scratch, CaughtError> {
        let runtime = js::Runtime::new().map_err(|error| {
            engine_error(format!("cannot create a compile-time engine: {error}"))
        })?;
        // QuickJS resolves every import while compiling *and while reading* a module, even under
        // `JS_EVAL_FLAG_COMPILE_ONLY` (see the "Could add a flag to avoid resolution" comment in
        // `js_eval_internal`). A bundle has already resolved the graph, so the compile engine
        // answers every specifier with an empty stub: the specifiers are what travel in the
        // bytecode, and the app's loader resolves them again against the payload.
        runtime.set_loader(StubResolver, StubLoader);
        let context = js::Context::full(&runtime).map_err(|error| {
            engine_error(format!("cannot create a compile-time context: {error}"))
        })?;
        Ok(Scratch { context, runtime })
    }
}

/// Identity resolver: the specifier is its own canonical name.
///
/// Nothing is read from disk, and no specifier is rewritten. Two modules importing the same
/// specifier share one stub, which is harmless: stubs are never linked, so their (empty) exports
/// are never consulted.
struct StubResolver;

impl js::loader::Resolver for StubResolver {
    fn resolve<'js>(
        &mut self,
        _ctx: &js::Ctx<'js>,
        _base: &str,
        name: &str,
        _attributes: Option<js::loader::ImportAttributes<'js>>,
    ) -> js::Result<String> {
        Ok(name.to_owned())
    }
}

/// The loader QuickJS insists on having: one empty module per specifier.
///
/// `js_resolve_module` runs during compilation, not just at link time, so the compile engine must
/// be able to hand back *something* for `node:path` or `./chunk.js`. It never needs the real
/// module: `js_link_module` is what reads exports, and compilation stops before it. Declaring the
/// stub from source (rather than a C module) keeps it to two lines and gives it no exports to
/// disagree with the real module later.
struct StubLoader;

impl js::loader::Loader for StubLoader {
    fn load<'js>(
        &mut self,
        ctx: &js::Ctx<'js>,
        name: &str,
        _attributes: Option<js::loader::ImportAttributes<'js>>,
    ) -> js::Result<js::Module<'js, js::module::Declared>> {
        js::Module::declare(ctx.clone(), name, "export {};")
    }
}

fn engine_error(message: String) -> CaughtError {
    CaughtError {
        name: "InternalError".to_owned(),
        display: message.clone(),
        message,
        stack: None,
        is_error: false,
        code: None,
    }
}
