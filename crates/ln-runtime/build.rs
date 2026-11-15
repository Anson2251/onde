//! Bundles the JavaScript stdlib into the binary, minified.
//!
//! `js/` is the source of truth and stays readable and directly runnable (`test/js/run.sh` runs
//! these files under node and lite). At build time every file is parsed, compressed and re-emitted
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
