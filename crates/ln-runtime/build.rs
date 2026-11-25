//! Bundles the JavaScript stdlib into the binary, minified.
//!
//! `js/` is the source of truth and stays readable and directly runnable (`test/js/run.sh` runs
//! these files under node and onde). At build time every file is parsed, compressed and re-emitted
//! with oxc, then written to `OUT_DIR/js/`; `modules.rs` and `lib.rs` include those artifacts.
//!
//! # No renaming
//!
//! Mangling is deliberately off. The stdlib exposes class and function names to users
//! (`EventEmitter`, `Stats`, `Socket`, `Worker`, `once`, `readFile`, …), QuickJS prints them in
//! stack traces, and `util.inspect` shows them. `test/js/lib/surface.test.js` pins the observable
//! names after compression. The
//! whitespace/comment/compression pass is the part that is safe to do silently. A consequence is
//! that a stack frame pointing into the stdlib refers to the minified text; user frames are
//! untouched.
//!
//! Escape hatches:
//!   * `ONDE_NO_MINIFY=1` bundles the sources verbatim (debugging a minifier miscompile);
//!   * `ONDE_MINIFY_VERBOSE=1` prints the byte counts as a cargo warning.
//!
//! A parse or minify error fails the build with the file path and the diagnostics; silently
//! falling back to unminified source would hide a broken input.

use std::fs;
use std::path::{Path, PathBuf};

use oxc_allocator::Allocator;
use oxc_codegen::{Codegen, CodegenOptions};
use oxc_minifier::{CompressOptions, Minifier, MinifierOptions};
use oxc_parser::Parser;
use oxc_span::SourceType;

fn main() {
    let manifest = PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by cargo"),
    );
    let js_root = manifest.join("../../js");
    let out_root =
        PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR is set by cargo")).join("js");

    println!("cargo:rerun-if-changed={}", js_root.display());
    println!("cargo:rerun-if-env-changed=ONDE_NO_MINIFY");
    println!("cargo:rerun-if-env-changed=ONDE_MINIFY_VERBOSE");
    println!("cargo:rerun-if-env-changed=ONDE_SNAPSHOT_VERBOSE");

    let minify = std::env::var_os("ONDE_NO_MINIFY").is_none();
    let verbose = std::env::var_os("ONDE_MINIFY_VERBOSE").is_some();

    let mut sources = Vec::new();
    collect(&js_root, &mut sources);
    sources.sort();

    let mut before = 0usize;
    let mut after = 0usize;
    for source_path in &sources {
        println!("cargo:rerun-if-changed={}", source_path.display());
        let relative = source_path
            .strip_prefix(&js_root)
            .expect("collected file is under js/");
        let source = fs::read_to_string(source_path)
            .unwrap_or_else(|error| panic!("read {}: {error}", source_path.display()));

        let bundled = if minify {
            minify_file(source_path, &source)
        } else {
            source.clone()
        };
        before += source.len();
        after += bundled.len();

        let target = out_root.join(relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .unwrap_or_else(|error| panic!("create {}: {error}", parent.display()));
        }
        fs::write(&target, bundled)
            .unwrap_or_else(|error| panic!("write {}: {error}", target.display()));
    }

    if minify && verbose {
        println!(
            "cargo:warning=minified {} JS files: {} -> {} bytes ({}%)",
            sources.len(),
            before,
            after,
            after.saturating_mul(100) / before.max(1)
        );
    }

    // WP2: the bootstrap snapshot (docs/m7-plan.md §3.1, §4.3). The minified `bootstrap.js` was
    // just written next to this one; compiling it here means the release binary can skip its parse
    // at boot. The bytecode is only valid for the engine that produced it, so the envelope records
    // `BC_VERSION`, byte order and the atom table, and the runtime refuses anything else before
    // `JS_ReadObject` sees a byte.
    write_bootstrap_snapshot(&out_root);
}

/// Compile the just-written `bootstrap.js` into `bootstrap.bc`, the snapshot the release build
/// embeds instead of the source.
///
/// This is the one place the build depends on the engine: the same vendored quickjs-ng compiles the
/// script here and reads it in the binary, so the stamp check only catches a stale `OUT_DIR`, never
/// a mismatch between two engines. It costs a second engine build in the host triple (m7-plan §9,
/// R12) and no runtime dependency.
fn write_bootstrap_snapshot(out_root: &Path) {
    let verbose = std::env::var_os("ONDE_SNAPSHOT_VERBOSE").is_some();
    let source_path = out_root.join("bootstrap.js");
    let source = fs::read_to_string(&source_path)
        .unwrap_or_else(|error| panic!("read {}: {error}", source_path.display()));
    let stamp = ln_engine::engine_stamp_parsed();
    let options = ln_engine::compile::Options {
        // The name is what stack frames inside the bootstrap show; `eval_global` used the same one,
        // so a snapshot and a source boot are indistinguishable in a trace.
        name: "<onde:bootstrap>".to_owned(),
        // Keep the source in the bytecode: an internal error with no line in `bootstrap.js` is not
        // a diagnostic, and the bootstrap is the one script users cannot read in their own tree.
        strip_source: false,
        endian: stamp.endian,
    };
    let bytecode = ln_engine::compile::script(&source, &options).unwrap_or_else(|error| {
        panic!(
            "cannot compile the bootstrap snapshot (js/bootstrap.js must be valid script):
{}",
            error.body()
        )
    });
    let blob = ln_payload::snapshot::encode(&bytecode, &stamp);
    let target = out_root.join("bootstrap.bc");
    fs::write(&target, &blob).unwrap_or_else(|error| panic!("write {}: {error}", target.display()));
    if verbose {
        println!(
            "cargo:warning=bootstrap snapshot: {} bytes of source -> {} bytes of bytecode ({} bytes with header)",
            source.len(),
            bytecode.len(),
            blob.len()
        );
    }
}

/// Recursively collect `.js` files, following no symlinks (the tree is ours).
fn collect(directory: &Path, files: &mut Vec<PathBuf>) {
    let entries = fs::read_dir(directory)
        .unwrap_or_else(|error| panic!("read {}: {error}", directory.display()));
    for entry in entries {
        let entry = entry.unwrap_or_else(|error| panic!("read entry: {error}"));
        let path = entry.path();
        let file_type = entry
            .file_type()
            .unwrap_or_else(|error| panic!("stat {}: {error}", path.display()));
        if file_type.is_dir() {
            collect(&path, files);
        } else if file_type.is_file() && path.extension().is_some_and(|extension| extension == "js")
        {
            files.push(path);
        }
    }
}

fn minify_file(path: &Path, source: &str) -> String {
    let allocator = Allocator::default();
    // The stdlib is CommonJS/classic script: `require`, `module.exports`, no import syntax.
    let source_type = SourceType::cjs();
    let parsed = Parser::new(&allocator, source, source_type).parse();
    if !parsed.errors.is_empty() {
        let diagnostics = parsed
            .errors
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        panic!(
            "cannot parse {} for bundling:\n{diagnostics}",
            path.display()
        );
    }

    let mut program = parsed.program;
    Minifier::new(MinifierOptions {
        // Names are part of the Node surface and of stack traces; see the module docs.
        mangle: None,
        compress: Some(CompressOptions {
            // `console.*` is user-visible output; never drop it.
            drop_console: false,
            ..CompressOptions::default()
        }),
    })
    .build(&allocator, &mut program);

    // `minify` is the printer's whitespace pass (comments are already dropped because the parser
    // does not preserve them). It is separate from `compress`, which rewrites the AST.
    Codegen::new()
        .with_options(CodegenOptions {
            minify: true,
            ..CodegenOptions::default()
        })
        .build(&program)
        .code
}
