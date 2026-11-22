//! The acceptance test for the whole feature: build an app, delete its sources, run the binary.
//!
//! `ondec` is driven exactly as a user drives it — the real binary, a real project directory, a
//! real `cc` — and the result is executed after the project **and** the SDK copy it was built
//! against are gone. That is the promise of a standalone build: the executable does not need the
//! source tree, the SDK, or the build tool at run time.
//!
//! The SDK has to come from somewhere, and building a static archive from inside a test would
//! mean invoking cargo recursively. So the test stages an SDK from a prebuilt archive:
//!
//! ```console
//! cargo build --release -p ln-embed
//! cargo test -p ondec --test e2e          # finds target/release/libonde.a
//! # or point it at one:
//! ONDE_E2E_ARCHIVE=/path/to/libonde.a cargo test -p ondec --test e2e
//! ```
//!
//! Without an archive the tests skip (with a message), so a plain `cargo test` stays fast.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use ondec::target::Target;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the workspace root")
}

/// The prebuilt static archive to stage an SDK from.
fn archive() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("ONDE_E2E_ARCHIVE") {
        let path = PathBuf::from(path);
        return path.is_file().then_some(path);
    }
    let path = repo_root().join("target/release/libonde.a");
    path.is_file().then_some(path)
}

/// A staged SDK: a temporary directory with `onde.h` and `libonde-<host>.a`.
struct Sdk {
    dir: tempfile::TempDir,
}

impl Sdk {
    fn stage() -> Option<Sdk> {
        let archive = match archive() {
            Some(archive) => archive,
            None => {
                eprintln!(
                    "skipping: no static archive; run `cargo build --release -p ln-embed` first \
                     or set ONDE_E2E_ARCHIVE"
                );
                return None;
            }
        };
        let host = Target::host().expect("a supported host");
        let dir = tempfile::tempdir().expect("tempdir");
        fs::copy(
            repo_root().join("crates/ln-embed/include/onde.h"),
            dir.path().join("onde.h"),
        )
        .expect("copy onde.h");
        fs::copy(&archive, dir.path().join(host.archive_name())).expect("copy the archive");
        Some(Sdk { dir })
    }

    fn path(&self) -> &Path {
        self.dir.path()
    }
}

fn project(files: &[(&str, &str)]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("tempdir");
    for (path, contents) in files {
        let full = dir.path().join(path);
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent).expect("create dir");
        }
        fs::write(full, contents).expect("write fixture");
    }
    dir
}

fn ondec() -> Command {
    Command::new(env!("CARGO_BIN_EXE_ondec"))
}

fn build(sdk: &Sdk, project: &Path, entry: &str, output: &Path, extra: &[&str]) -> Output {
    let mut command = ondec();
    command
        .arg("build")
        .arg(project.join(entry))
        .args(["--sdk", &sdk.path().display().to_string()])
        .args(["-o", &output.display().to_string()])
        .args(extra);
    command.output().expect("run ondec")
}

fn assert_success(output: &Output, what: &str) {
    assert!(
        output.status.success(),
        "{what} failed\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn run(binary: &Path, args: &[&str]) -> Output {
    Command::new(binary)
        .args(args)
        .output()
        .expect("run the built app")
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).replace("\r\n", "\n")
}

#[test]
fn builds_a_runnable_esm_app() {
    let Some(sdk) = Sdk::stage() else { return };
    let project = project(&[
        ("package.json", r#"{"name":"app","type":"module"}"#),
        (
            "src/main.js",
            "import { greet } from './lib/greet.js';\n\
             import { join } from 'node:path';\n\
             console.log(greet(join('payload', 'standalone')));\n\
             console.log(JSON.stringify(process.argv));\n\
             process.exitCode = process.argv.length - 2;\n",
        ),
        (
            "src/lib/greet.js",
            "export const greet = (where) => `hello from ${where}`;\n",
        ),
    ]);
    let out = tempfile::tempdir().expect("tempdir");
    let binary = out.path().join("app");
    let built = build(&sdk, project.path(), "src/main.js", &binary, &["-v"]);
    assert_success(&built, "ondec build");

    // Delete the project and the SDK: the executable must not need either.
    drop(project);
    drop(sdk);

    let output = run(&binary, &["one", "two"]);
    assert_eq!(
        output.status.code(),
        Some(2),
        "exit code is argv.length - 2"
    );
    let text = stdout(&output);
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines[0], "hello from payload/standalone");
    assert_eq!(
        lines[1],
        format!(
            r#"["{}","{}","one","two"]"#,
            binary.display(),
            binary.display()
        ),
        "Node's single-executable argv shape: exec, exec, then user arguments"
    );
}

#[test]
fn builds_a_runnable_commonjs_app() {
    let Some(sdk) = Sdk::stage() else { return };
    let project = project(&[
        ("package.json", r#"{"name":"app","type":"commonjs"}"#),
        (
            "main.cjs",
            "const { greet } = require('./greet.cjs');\n\
             function main() {\n\
                 console.log(greet(__dirname));\n\
                 console.log(greet(__filename));\n\
             }\n\
             if (require.main === module) main();\n",
        ),
        (
            "greet.cjs",
            "exports.greet = (where) => 'cjs sees ' + where;\n",
        ),
    ]);
    let out = tempfile::tempdir().expect("tempdir");
    let binary = out.path().join("app");
    let built = build(&sdk, project.path(), "main.cjs", &binary, &[]);
    assert_success(&built, "ondec build");

    let output = run(&binary, &[]);
    assert_eq!(
        stdout(&output),
        "cjs sees .\ncjs sees main.js\n",
        "ambient paths come from the payload keys"
    );
}

#[test]
fn section_embedding_and_compression_still_run() {
    let Some(sdk) = Sdk::stage() else { return };
    let project = project(&[
        ("package.json", r#"{"name":"app","type":"module"}"#),
        ("main.js", "console.log('variants ok');\n"),
    ]);

    let out = tempfile::tempdir().expect("tempdir");
    for (name, extra) in [
        ("section", vec!["--embed", "section"]),
        ("compressed", vec!["--compress"]),
        ("source", vec!["--no-bytecode"]),
        ("stripped", vec!["--strip-source"]),
    ] {
        let binary = out.path().join(name);
        let built = build(&sdk, project.path(), "main.js", &binary, &extra);
        assert_success(&built, name);
        let output = run(&binary, &[]);
        assert_eq!(stdout(&output), "variants ok\n", "{name}");
    }
}

#[test]
fn a_missing_source_module_fails_the_build_before_writing_anything() {
    let Some(sdk) = Sdk::stage() else { return };
    let project = project(&[
        ("package.json", r#"{"name":"app","type":"module"}"#),
        ("main.js", "import './nope.js';\n"),
    ]);
    let out = tempfile::tempdir().expect("tempdir");
    let binary = out.path().join("app");
    let built = build(&sdk, project.path(), "main.js", &binary, &[]);
    assert!(!built.status.success(), "the bundler must reject it");
    assert!(!binary.exists(), "nothing may be written on a failed build");
}

#[test]
fn print_command_describes_the_link_without_running_it() {
    let Some(sdk) = Sdk::stage() else { return };
    let project = project(&[
        ("package.json", r#"{"name":"app","type":"module"}"#),
        ("main.js", "export {};\n"),
    ]);
    let out = tempfile::tempdir().expect("tempdir");
    let binary = out.path().join("app");
    let built = build(
        &sdk,
        project.path(),
        "main.js",
        &binary,
        &["--print-command"],
    );
    assert_success(&built, "--print-command");

    let text = stdout(&built);
    assert!(text.contains("app.c"), "{text}");
    assert!(
        text.contains(&Target::host().unwrap().archive_name()),
        "{text}"
    );
    assert!(!binary.exists(), "--print-command must not link");
}
