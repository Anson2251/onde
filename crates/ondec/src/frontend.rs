//! The bundler frontend: from a JavaScript entry to a set of ES modules.
//!
//! `rolldown` runs in-process. It is the same family of tooling the bundler ecosystem uses
//! (Rollup-compatible semantics, oxc's parser/transformer, Node resolution), so a compiled app
//! sees what an `esbuild`/Vite user would expect: TypeScript and JSX loaders, CommonJS converted
//! to ESM, `node:` builtins left external, and dynamic imports either inlined or emitted as
//! chunks.
//!
//! # Output is always ESM
//!
//! The payload has exactly two module kinds, both ES modules (`esm-bytecode` and `esm-source`).
//! A CommonJS entry is therefore compiled to an ES module by the bundler, which is also where the
//! `__dirname`/`__filename` shims come from: for `platform: node` with ESM output, rolldown
//! rewrites a CJS module's ambient paths to `import.meta.dirname`/`import.meta.filename`, which
//! the compiled app sets from the payload key. That is why one runtime loader handles both module
//! systems.
//!
//! # Keys are names
//!
//! Every output file's name becomes a payload key, and the name is what `__filename`,
//! `import.meta.url` and stack traces show. Entry chunks are named after their path relative to
//! the project root (`src/main.js`), not after the project (`main.js`), so a bundle keeps the
//! shape a user recognises. Chunks go under `chunks/`.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use rolldown::{
    Bundler, BundlerOptions, CodeSplittingMode, InputItem, OutputFormat, Platform,
    RawMinifyOptions, SourceMapType,
};
use rolldown_common::Output;

/// One bundled ES module, before compilation.
#[derive(Debug, Clone)]
pub struct Chunk {
    /// The payload key: the output filename relative to the project root.
    pub key: String,
    /// The bundled source.
    pub code: String,
    /// Is this an entry point?
    pub is_entry: bool,
}

/// What the frontend produced.
#[derive(Debug)]
pub struct Bundle {
    /// Every module, in a deterministic order.
    pub chunks: Vec<Chunk>,
    /// The key of the main entry (the first `--entry`).
    pub entry: String,
    /// Source maps, when `--sourcemap` was given: `(key, JSON)`.
    pub maps: Vec<(String, String)>,
    /// Bundler warnings, already rendered.
    pub warnings: Vec<String>,
}

/// Frontend options, straight from the command line.
#[derive(Debug, Clone, Default)]
pub struct Options {
    /// Entry points; the first is the app's entry.
    pub entries: Vec<PathBuf>,
    /// `--outbase`: the project root keys are relative to.
    pub outbase: Option<PathBuf>,
    /// `--externals`.
    pub externals: Vec<String>,
    /// `--splitting`: let dynamic imports become separate chunks.
    pub splitting: bool,
    /// `--minify`.
    pub minify: bool,
    /// `--sourcemap`.
    pub sourcemap: bool,
}

/// Bundle the entries.
pub fn bundle(options: &Options) -> Result<Bundle, String> {
    if options.entries.is_empty() {
        return Err("no entry: pass a JavaScript file".to_owned());
    }

    let outbase = project_root(options)?;
    let mut inputs = Vec::with_capacity(options.entries.len());
    let mut expected_entry = None;
    let mut seen_names = BTreeSet::new();

    for entry in &options.entries {
        let absolute = entry
            .canonicalize()
            .map_err(|error| format!("cannot read {}: {error}", entry.display()))?;
        let key = key_for(&absolute, &outbase)?;
        let name = strip_extension(&key);
        if !seen_names.insert(name.clone()) {
            return Err(format!(
                "two entries would both be named {name:?}; rename one or pass --outbase"
            ));
        }
        if expected_entry.is_none() {
            expected_entry = Some(format!("{name}.js"));
        }
        inputs.push(InputItem {
            name: Some(name),
            import: key,
        });
    }

    let mut bundler_options = BundlerOptions {
        input: Some(inputs),
        cwd: Some(outbase.clone()),
        // The output is virtual: only the returned filenames matter, and they are relative to this
        // directory.
        dir: Some("out".to_owned()),
        format: Some(OutputFormat::Esm),
        platform: Some(Platform::Node),
        entry_filenames: Some("[name].js".to_owned().into()),
        chunk_filenames: Some("chunks/[name]-[hash].js".to_owned().into()),
        // More than one entry *is* code splitting: rolldown refuses multiple inputs with it
        // disabled, and the chunks are exactly what the payload's key table is for.
        code_splitting: Some(CodeSplittingMode::Bool(
            options.splitting || options.entries.len() > 1,
        )),
        sourcemap: options.sourcemap.then_some(SourceMapType::File),
        minify: options.minify.then_some(RawMinifyOptions::Bool(true)),
        ..Default::default()
    };
    if !options.externals.is_empty() {
        bundler_options.external = Some(options.externals.clone().into());
    }

    let mut bundler = Bundler::new(bundler_options)
        .map_err(|error| format!("cannot configure the bundler: {error}"))?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("cannot start the bundler runtime: {error}"))?;
    let output = runtime
        .block_on(bundler.generate())
        .map_err(|errors| format!("bundling failed\n{errors}"))?;

    let mut warnings = output
        .warnings
        .iter()
        .map(|warning| warning.to_string())
        .collect::<Vec<_>>();

    let mut chunks = Vec::new();
    let mut maps = Vec::new();
    for asset in &output.assets {
        let filename = asset.filename();
        if filename.ends_with(".map") {
            maps.push((
                filename.to_owned(),
                String::from_utf8_lossy(asset.content_as_bytes()).into_owned(),
            ));
            continue;
        }
        let Output::Chunk(chunk) = asset else {
            return Err(format!(
                "the bundle emitted the non-JavaScript asset {filename:?}; a compiled app carries \
                 modules only (CSS, images and other assets are not embedded in v1)"
            ));
        };
        if !is_module_filename(filename) {
            return Err(format!(
                "the bundle emitted {filename:?}, which is not a JavaScript module"
            ));
        }
        let mut code = chunk.code.clone();
        let mut rewritten = false;
        if chunk.is_entry {
            let (rewritten_code, changed) = rewrite_cjs_main_guard(&code);
            code = rewritten_code;
            rewritten = changed;
        }
        if rewritten {
            warnings.push(format!(
                "{filename}: the CommonJS entry's `require.main === module` guard was made true: a bundled CJS entry is the main module, but converting it to ESM drops the `module` the guard compares against (Node running the same bundle skips main() too)."
            ));
        }
        chunks.push(Chunk {
            key: filename.to_owned(),
            code,
            is_entry: chunk.is_entry,
        });
    }

    chunks.sort_by(|left, right| left.key.cmp(&right.key));
    let entry = expected_entry.expect("at least one entry");
    if !chunks.iter().any(|chunk| chunk.key == entry) {
        return Err(format!(
            "the bundler did not produce the entry module {entry:?}; it produced: {}",
            chunks
                .iter()
                .map(|chunk| chunk.key.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    Ok(Bundle {
        chunks,
        entry,
        maps,
        warnings,
    })
}

/// Make a bundled CommonJS entry run.
///
/// A CJS program typically ends with `if (require.main === module) main()`. After bundling to ESM
/// there is no `module`, so that comparison is false and the program exits silently — verified
/// with Node running the same bundle, so this is the conversion, not onde. In a compiled app the
/// entry *is* the main module, so the honest answer is `true`; only the entry chunk is touched,
/// and only for the exact guard expression inside an `if`.
fn rewrite_cjs_main_guard(code: &str) -> (String, bool) {
    const GUARDS: [&str; 3] = [
        "__require.main === module",
        "require.main === module",
        "module === require.main",
    ];
    for guard in GUARDS {
        let needle = format!("if ({guard})");
        if let Some(index) = code.find(&needle) {
            let mut out = String::with_capacity(code.len());
            out.push_str(&code[..index]);
            out.push_str("if (true)");
            out.push_str(&code[index + needle.len()..]);
            return (out, true);
        }
    }
    (code.to_owned(), false)
}

fn is_module_filename(filename: &str) -> bool {
    [".js", ".mjs", ".cjs"]
        .iter()
        .any(|extension| filename.ends_with(extension))
}

/// The project root: `--outbase`, else the nearest directory with a `package.json`, else the
/// entry's directory.
fn project_root(options: &Options) -> Result<PathBuf, String> {
    if let Some(outbase) = &options.outbase {
        let canonical = outbase
            .canonicalize()
            .map_err(|error| format!("--outbase {}: {error}", outbase.display()))?;
        return Ok(canonical);
    }
    let first = options.entries[0]
        .canonicalize()
        .map_err(|error| format!("cannot read {}: {error}", options.entries[0].display()))?;
    let mut directory = first.parent().map(Path::to_path_buf);
    while let Some(current) = directory {
        if current.join("package.json").is_file() {
            return Ok(current);
        }
        directory = current.parent().map(Path::to_path_buf);
    }
    Ok(first
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from(".")))
}

/// The payload key for an absolute path: relative to `outbase`, POSIX separators, no `./`.
fn key_for(path: &Path, outbase: &Path) -> Result<String, String> {
    let relative = path.strip_prefix(outbase).map_err(|_| {
        format!(
            "{} is outside the project root {}; pass --outbase to choose the root",
            path.display(),
            outbase.display()
        )
    })?;
    let mut key = String::new();
    for component in relative.components() {
        let text = component.as_os_str().to_string_lossy();
        if text.is_empty() || text == "." {
            continue;
        }
        if !key.is_empty() {
            key.push('/');
        }
        key.push_str(&text);
    }
    if key.is_empty() {
        return Err(format!("{} has no file name", path.display()));
    }
    Ok(key)
}

fn strip_extension(key: &str) -> String {
    match key.rfind('.') {
        // Only strip an extension of the last segment, and never a dotfile's leading dot.
        Some(index) if index > key.rfind('/').map(|slash| slash + 1).unwrap_or(0) => {
            key[..index].to_owned()
        }
        _ => key.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        for (path, contents) in files {
            let full = dir.path().join(path);
            if let Some(parent) = full.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(full, contents).unwrap();
        }
        dir
    }

    #[test]
    fn bundles_esm_and_keeps_builtins_external() {
        let dir = fixture(&[
            ("package.json", r#"{"name":"app","type":"module"}"#),
            (
                "src/main.js",
                "import { greet } from './lib/greet.js';\nimport { join } from 'node:path';\nconsole.log(greet(join('a','b')));\n",
            ),
            ("src/lib/greet.js", "export const greet = (where) => `hi ${where}`;\n"),
        ]);
        let bundle = bundle(&Options {
            entries: vec![dir.path().join("src/main.js")],
            ..Default::default()
        })
        .expect("bundles");

        assert_eq!(bundle.entry, "src/main.js");
        assert_eq!(bundle.chunks.len(), 1, "one entry inlines its imports");
        let chunk = &bundle.chunks[0];
        assert_eq!(chunk.key, "src/main.js");
        assert!(chunk.is_entry);
        assert!(chunk.code.contains("node:path"), "builtins stay external");
        assert!(chunk.code.contains("hi "), "the helper was inlined");
    }

    #[test]
    fn converts_commonjs_and_shims_ambient_paths() {
        let dir = fixture(&[
            ("package.json", r#"{"name":"app","type":"commonjs"}"#),
            (
                "main.cjs",
                "const { greet } = require('./greet.cjs');\nconsole.log(greet(__dirname));\n",
            ),
            ("greet.cjs", "exports.greet = (where) => 'hi ' + where;\n"),
        ]);
        let bundle = bundle(&Options {
            entries: vec![dir.path().join("main.cjs")],
            ..Default::default()
        })
        .expect("bundles");

        assert_eq!(bundle.entry, "main.js");
        let chunk = &bundle.chunks[0];
        assert!(chunk.code.contains("import.meta.dirname"), "{}", chunk.code);
        assert!(!chunk.code.contains("require("), "{}", chunk.code);
    }

    #[test]
    fn a_commonjs_entry_keeps_its_main_guard_working() {
        let dir = fixture(&[
            ("package.json", r#"{"name":"cli","type":"commonjs"}"#),
            (
                "cli.cjs",
                "const { run } = require('./lib.cjs');\n\
                 if (require.main === module) run();\n",
            ),
            ("lib.cjs", "exports.run = () => console.log('ran');\n"),
        ]);
        let bundle = bundle(&Options {
            entries: vec![dir.path().join("cli.cjs")],
            ..Default::default()
        })
        .expect("bundles");
        let chunk = &bundle.chunks[0];
        assert!(
            chunk.code.contains("if (true)"),
            "the entry guard must be rewritten: {}",
            chunk.code
        );
        assert!(
            bundle.warnings.iter().any(|w| w.contains("require.main")),
            "the rewrite is reported: {:?}",
            bundle.warnings
        );
    }

    #[test]
    fn keys_are_relative_to_the_nearest_package_json() {
        let dir = fixture(&[
            ("package.json", r#"{"name":"app","type":"module"}"#),
            ("src/main.js", "export const x = 1;\n"),
        ]);
        let bundle = bundle(&Options {
            entries: vec![dir.path().join("src/main.js")],
            ..Default::default()
        })
        .unwrap();
        assert_eq!(bundle.entry, "src/main.js");
    }

    #[test]
    fn two_entries_keep_their_paths_and_the_first_is_the_app_entry() {
        let dir = fixture(&[
            ("package.json", r#"{"name":"app","type":"module"}"#),
            ("src/main.js", "import './worker.js';\n"),
            ("src/worker.js", "export const w = 1;\n"),
        ]);
        let bundle = bundle(&Options {
            entries: vec![
                dir.path().join("src/main.js"),
                dir.path().join("src/worker.js"),
            ],
            ..Default::default()
        })
        .unwrap();
        assert_eq!(bundle.entry, "src/main.js");
        let keys: Vec<&str> = bundle
            .chunks
            .iter()
            .map(|chunk| chunk.key.as_str())
            .collect();
        assert_eq!(keys, vec!["src/main.js", "src/worker.js"]);
    }

    #[test]
    fn a_generated_key_never_escapes_the_root() {
        let root = Path::new("/project");
        assert_eq!(
            key_for(Path::new("/project/src/a.js"), root).unwrap(),
            "src/a.js"
        );
        assert!(key_for(Path::new("/elsewhere/a.js"), root).is_err());
    }

    #[test]
    fn extension_stripping_leaves_dots_in_names_alone() {
        assert_eq!(strip_extension("src/main.js"), "src/main");
        assert_eq!(strip_extension("src/main.test.ts"), "src/main.test");
        assert_eq!(strip_extension("src/.hidden"), "src/.hidden");
        assert_eq!(strip_extension("main"), "main");
    }
}
