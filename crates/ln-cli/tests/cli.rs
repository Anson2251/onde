//! End-to-end tests. These exercise the real `lite` binary, not the library.

use std::path::PathBuf;
use std::process::{Command, Output};

fn lite(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_lite"))
        .args(args)
        .output()
        .expect("spawn lite")
}

/// A temp script that removes itself (and its directory, when empty) on drop.
struct TempScript(PathBuf);

impl TempScript {
    fn new(name: &str, body: &str) -> Self {
        use std::sync::atomic::{AtomicU64, Ordering};

        static NEXT: AtomicU64 = AtomicU64::new(0);
        let unique = NEXT.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("lite-m0-{}-{unique}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join(name);
        std::fs::write(&path, body).expect("write script");
        Self(path)
    }
}

impl std::ops::Deref for TempScript {
    type Target = std::path::Path;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl Drop for TempScript {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        if let Some(dir) = self.0.parent() {
            let _ = std::fs::remove_dir(dir);
        }
    }
}

fn script(name: &str, body: &str) -> TempScript {
    TempScript::new(name, body)
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn code(output: &Output) -> i32 {
    output.status.code().expect("process exited via signal")
}

#[test]
fn eval_prints_the_completion_value() {
    let output = lite(&["-e", "1+1"]);
    assert_eq!(code(&output), 0);
    assert_eq!(stdout(&output), "2\n");
}

#[test]
fn eval_process_exit_does_not_print_the_value() {
    let output = lite(&["-e", "process.exit(3); 1+1"]);
    assert_eq!(code(&output), 3);
    assert_eq!(stdout(&output), "");
}

#[test]
fn eval_process_exit_from_a_microtask_does_not_print_the_value() {
    // C7: exit from a microtask drops the rest of the turn, so the completion value of the
    // script must not be printed after it.
    let output = lite(&["-e", "queueMicrotask(() => process.exit(3)); 1+1"]);
    assert_eq!(code(&output), 3);
    assert_eq!(stdout(&output), "");
}

#[test]
fn file_does_not_print_its_completion_value() {
    let path = script("value.js", "1 + 1;\n");
    let output = lite(&[path.to_str().expect("utf-8 path")]);
    assert_eq!(code(&output), 0);
    assert_eq!(stdout(&output), "");
}

#[test]
fn self_feeding_microtasks_trip_the_budget() {
    // The default budget is off, like Node; `--max-microtasks` is the embedder guard
    // (ADR-0002 I9, compat D9).
    let output = lite(&[
        "--max-microtasks",
        "10000",
        "-e",
        "queueMicrotask(function f(){ queueMicrotask(f); });",
    ]);
    assert_eq!(code(&output), 1);
    assert!(
        stderr(&output).contains("microtask budget exhausted"),
        "stderr: {}",
        stderr(&output)
    );
}

#[test]
fn microtask_timeout_interrupts_a_long_job() {
    let output = lite(&[
        "--microtask-timeout",
        "20",
        "--max-microtasks",
        "100",
        "-e",
        "queueMicrotask(() => { while (true) {} });",
    ]);
    assert_eq!(code(&output), 1);
    assert!(
        stderr(&output).contains("microtask timeout exceeded"),
        "stderr: {}",
        stderr(&output)
    );
}

#[test]
fn eval_prints_nothing_for_undefined() {
    let output = lite(&["-e", "undefined"]);
    assert_eq!(code(&output), 0);
    assert_eq!(stdout(&output), "");
}

#[test]
fn runs_a_classic_script() {
    let path = script("hello.js", "console.log('hello', 1, true);\n");
    let output = lite(&[path.to_str().expect("utf-8 path")]);
    assert_eq!(code(&output), 0);
    assert_eq!(stdout(&output), "hello 1 true\n");
}

/// Node hands the script everything after its path. A flag that lite also defines (`--check`) must
/// still reach the script, or a CLI like `tuckbox` cannot use its own options.
#[test]
fn script_arguments_win_over_lite_flags() {
    let path = script(
        "args.js",
        "console.log(JSON.stringify(process.argv.slice(2)));\n",
    );
    let path = path.to_str().expect("utf-8 path");

    let output = lite(&[path, "--check", "--prod", "-x"]);
    assert_eq!(code(&output), 0);
    assert_eq!(stdout(&output), "[\"--check\",\"--prod\",\"-x\"]\n");

    // The same holds when lite's own options come first.
    let output = lite(&["--io-threads", "2", path, "--max-microtasks", "1"]);
    assert_eq!(code(&output), 0);
    assert_eq!(stdout(&output), "[\"--max-microtasks\",\"1\"]\n");
}

#[test]
fn uncaught_error_has_a_node_shaped_header() {
    let path = script(
        "boom.js",
        "const a = 1;\nfunction f() {\n  throw new Error('boom');\n}\nf();\n",
    );
    let output = lite(&[path.to_str().expect("utf-8 path")]);
    let stderr = stderr(&output);
    let path = path.display().to_string();

    assert_eq!(code(&output), 1);
    assert_eq!(stdout(&output), "");
    assert!(stderr.contains(&format!("{path}:3")), "header: {stderr}");
    assert!(
        stderr.contains("throw new Error('boom');"),
        "source: {stderr}"
    );
    assert!(stderr.contains('^'), "caret: {stderr}");
    assert!(stderr.contains("Error: boom"), "message: {stderr}");
    assert!(stderr.contains("at f"), "stack: {stderr}");
}

#[test]
fn process_exit_sets_the_code_and_drops_remaining_microtasks() {
    let path = script(
        "exit.js",
        "queueMicrotask(() => { console.log('m1'); process.exit(7); });\n\
         queueMicrotask(() => console.log('m2'));\n",
    );
    let output = lite(&[path.to_str().expect("utf-8 path")]);

    assert_eq!(code(&output), 7);
    assert_eq!(stdout(&output), "m1\n");
}

#[test]
fn microtask_order_matches_node() {
    // Same program as test/conformance/microtasks/c12-shared-fifo.js.
    let path = script(
        "microtasks.js",
        "queueMicrotask(() => console.log('qm1'));\n\
         Promise.resolve().then(() => console.log('then1'));\n\
         Promise.resolve().then(() => { console.log('then2'); queueMicrotask(() => console.log('qm-from-then2')); });\n\
         queueMicrotask(() => console.log('qm2'));\n\
         console.log('sync');\n",
    );
    let output = lite(&[path.to_str().expect("utf-8 path")]);

    assert_eq!(code(&output), 0);
    assert_eq!(
        stdout(&output),
        "sync\nqm1\nthen1\nthen2\nqm2\nqm-from-then2\n"
    );
}

#[test]
fn throwing_microtask_is_fatal() {
    let path = script(
        "job-throw.js",
        "queueMicrotask(() => { throw new Error('in-job'); });\n",
    );
    let output = lite(&[path.to_str().expect("utf-8 path")]);
    let stderr = stderr(&output);

    assert_eq!(code(&output), 1);
    assert!(
        stderr.contains("Error: in-job"),
        "expected the job error, got: {stderr}"
    );
    assert!(
        stderr.contains(&path.display().to_string()),
        "expected the entry frame, got: {stderr}"
    );
}

#[test]
fn missing_file_is_a_clear_error_not_a_panic() {
    let path = std::env::temp_dir().join(format!(
        "lite-m0-{}-definitely-missing.js",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    let output = lite(&[path.to_str().expect("utf-8 path")]);
    let stderr = stderr(&output);

    assert_eq!(code(&output), 1);
    // M2 routes the entry through the module resolver, so the error is Node's message rather
    // than the M0 "cannot open" wording.
    assert!(
        stderr.contains("Cannot find module") || stderr.contains("cannot open"),
        "stderr: {stderr}"
    );
    assert!(stderr.contains("definitely-missing"), "stderr: {stderr}");
    assert!(!stderr.contains("panicked"), "stderr: {stderr}");
}

#[test]
fn syntax_error_is_reported_as_such() {
    let path = script("syntax.js", "function (\n");
    let output = lite(&[path.to_str().expect("utf-8 path")]);

    assert_eq!(code(&output), 1);
    assert!(
        stderr(&output).contains("SyntaxError"),
        "stderr: {}",
        stderr(&output)
    );
}

#[test]
fn extra_args_reach_process_argv() {
    let path = script(
        "argv.js",
        "console.log(process.argv[2], process.argv[3]);\n",
    );
    let output = lite(&[path.to_str().expect("utf-8 path"), "alpha", "beta"]);

    assert_eq!(code(&output), 0);
    assert_eq!(stdout(&output), "alpha beta\n");
}

#[test]
fn console_error_goes_to_stderr() {
    let path = script("streams.js", "console.log('out');\nconsole.error('err');\n");
    let output = lite(&[path.to_str().expect("utf-8 path")]);

    assert_eq!(stdout(&output), "out\n");
    assert_eq!(stderr(&output), "err\n");
}

#[test]
fn version_and_help() {
    let version = lite(&["--version"]);
    assert_eq!(code(&version), 0);
    assert!(
        stdout(&version).starts_with("lite v"),
        "{}",
        stdout(&version)
    );

    let help = lite(&["--help"]);
    assert_eq!(code(&help), 0);
    assert!(stdout(&help).contains("Usage:"), "{}", stdout(&help));
    assert!(stdout(&help).contains("--eval"), "{}", stdout(&help));
}

#[test]
fn unknown_option_is_a_usage_error() {
    let output = lite(&["--nope"]);
    assert_eq!(code(&output), 1);
    assert!(
        stderr(&output).contains("unknown option"),
        "{}",
        stderr(&output)
    );
}

#[test]
fn no_arguments_is_a_usage_error() {
    let output = lite(&[]);
    assert_eq!(code(&output), 1);
    assert!(
        stderr(&output).contains("expected a script"),
        "{}",
        stderr(&output)
    );
}

// --- M1: scheduler and tick model ------------------------------------------------------------

#[test]
fn timers_and_immediates_are_ordered_like_node() {
    let path = script(
        "timers.js",
        "setTimeout(() => console.log('t0'), 0);\n\
         setTimeout(() => console.log('tfuture'), 250);\n\
         setImmediate(() => console.log('imm'));\n\
         console.log('sync');\n",
    );
    let output = lite(&[path.to_str().expect("utf-8 path")]);

    assert_eq!(code(&output), 0);
    // A clamped 0 ms timer versus `setImmediate` at top level depends on how long the rest of
    // startup took (Node has the same nondeterminism); the corpus marks those cases `.nodiff`.
    // What is guaranteed here: synchronous code first, the future timer last. The future timer
    // is far enough out (250 ms) that the other 43 parallel tests cannot deschedule this process
    // past its deadline; the ordering, not the exact delay, is what the loop promises.
    let out = stdout(&output);
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines.first().copied(), Some("sync"), "{out}");
    assert_eq!(lines.last().copied(), Some("tfuture"), "{out}");
    assert!(lines.contains(&"t0"), "{out}");
    assert!(lines.contains(&"imm"), "{out}");
}

#[test]
fn clear_timeout_removes_the_timer_but_keeps_the_handle() {
    let path = script(
        "clear.js",
        "const t = setTimeout(() => console.log('nope'), 0);\n\
         clearTimeout(t);\n\
         console.log('cleared', t.hasRef());\n",
    );
    let output = lite(&[path.to_str().expect("utf-8 path")]);

    assert_eq!(code(&output), 0);
    assert_eq!(stdout(&output), "cleared true\n");
}

#[test]
fn set_interval_reschedules_and_can_be_cleared() {
    let path = script(
        "interval.js",
        "let n = 0;\n\
         const iv = setInterval(() => { console.log('iv', ++n); if (n === 3) clearInterval(iv); }, 1);\n",
    );
    let output = lite(&[path.to_str().expect("utf-8 path")]);

    assert_eq!(code(&output), 0);
    assert_eq!(stdout(&output), "iv 1\niv 2\niv 3\n");
}

#[test]
fn unrefed_timer_does_not_keep_the_loop_alive() {
    let path = script(
        "unref.js",
        "const t = setTimeout(() => console.log('nope'), 1000);\n\
         t.unref();\n\
         console.log('unref', t.hasRef());\n",
    );
    let output = lite(&[path.to_str().expect("utf-8 path")]);

    assert_eq!(code(&output), 0);
    assert_eq!(stdout(&output), "unref false\n");
}

#[test]
fn before_exit_runs_before_exit_and_can_be_revived() {
    let path = script(
        "before-exit.js",
        "let n = 0;\n\
         process.on('beforeExit', (c) => { console.log('beforeExit', c); if (n++ < 1) setTimeout(() => console.log('revived'), 0); });\n\
         process.on('exit', (c) => console.log('exit', c));\n",
    );
    let output = lite(&[path.to_str().expect("utf-8 path")]);

    assert_eq!(code(&output), 0);
    assert_eq!(
        stdout(&output),
        "beforeExit 0\nrevived\nbeforeExit 0\nexit 0\n"
    );
}

#[test]
fn exit_code_property_becomes_the_process_status() {
    let path = script(
        "exit-code.js",
        "process.on('exit', (c) => console.log('exit', c));\n\
         process.exitCode = 3;\n",
    );
    let output = lite(&[path.to_str().expect("utf-8 path")]);

    assert_eq!(code(&output), 3);
    assert_eq!(stdout(&output), "exit 3\n");
}

#[test]
fn unhandled_rejection_is_reported_after_the_microtasks_before_timers() {
    let path = script(
        "unhandled.js",
        "process.on('unhandledRejection', (r) => console.log('unhandled', r.message));\n\
         Promise.reject(new Error('r1'));\n\
         queueMicrotask(() => console.log('m1'));\n\
         process.nextTick(() => console.log('t1'));\n\
         setTimeout(() => console.log('timer'), 0);\n",
    );
    let output = lite(&[path.to_str().expect("utf-8 path")]);

    assert_eq!(code(&output), 0);
    assert_eq!(stdout(&output), "t1\nm1\nunhandled r1\ntimer\n");
}

#[test]
fn a_late_handler_emits_rejection_handled_after_the_catch() {
    let path = script(
        "late-handler.js",
        "process.on('unhandledRejection', (r) => console.log('unhandled', r.message));\n\
         process.on('rejectionHandled', () => console.log('rejectionHandled'));\n\
         const p = Promise.reject(new Error('r3'));\n\
         setTimeout(() => p.catch((e) => console.log('caught', e.message)), 0);\n",
    );
    let output = lite(&[path.to_str().expect("utf-8 path")]);

    assert_eq!(code(&output), 0);
    assert_eq!(
        stdout(&output),
        "unhandled r3\ncaught r3\nrejectionHandled\n"
    );
}

#[test]
fn an_uncaught_exception_handler_keeps_the_loop_alive() {
    let path = script(
        "uncaught-handler.js",
        "process.on('uncaughtException', (e) => console.log('handled', e.message));\n\
         setTimeout(() => { throw new Error('boom'); }, 0);\n\
         setTimeout(() => console.log('after'), 1);\n",
    );
    let output = lite(&[path.to_str().expect("utf-8 path")]);

    assert_eq!(code(&output), 0);
    assert_eq!(stdout(&output), "handled boom\nafter\n");
}

#[test]
fn timer_callbacks_receive_args_and_a_timeout_this() {
    let path = script(
        "timer-args.js",
        "setTimeout(function (a, b) { console.log('args', a, b, typeof this.hasRef); }, 0, 'x', 'y');\n",
    );
    let output = lite(&[path.to_str().expect("utf-8 path")]);

    assert_eq!(code(&output), 0);
    assert_eq!(stdout(&output), "args x y function\n");
}

#[test]
fn non_positive_and_nan_delays_clamp_to_one_millisecond() {
    let path = script(
        "clamp.js",
        "setTimeout(() => console.log('a'), -10);\n\
         setTimeout(() => console.log('b'), NaN);\n\
         setTimeout(() => console.log('c'), 0);\n",
    );
    let output = lite(&[path.to_str().expect("utf-8 path")]);

    assert_eq!(code(&output), 0);
    assert_eq!(stdout(&output), "a\nb\nc\n");
}

#[test]
fn ten_thousand_timers_can_be_created_and_cleared() {
    let path = script(
        "many-timers.js",
        "for (let i = 0; i < 10000; i++) clearTimeout(setTimeout(() => {}, 1000));\n\
         setTimeout(() => console.log('done'), 0);\n",
    );
    let output = lite(&[path.to_str().expect("utf-8 path")]);

    assert_eq!(code(&output), 0);
    assert_eq!(stdout(&output), "done\n");
}

#[test]
fn process_exit_from_a_timer_drops_later_timers() {
    let path = script(
        "exit-timer.js",
        "process.on('exit', (c) => console.log('exit', c));\n\
         setTimeout(() => { console.log('t1'); process.exit(2); }, 0);\n\
         setTimeout(() => console.log('nope'), 5);\n",
    );
    let output = lite(&[path.to_str().expect("utf-8 path")]);

    assert_eq!(code(&output), 2);
    assert_eq!(stdout(&output), "t1\nexit 2\n");
}

#[test]
fn unhandled_rejection_with_no_listener_exits_one() {
    let path = script("unhandled-default.js", "Promise.reject(new Error('r1'));\n");
    let output = lite(&[path.to_str().expect("utf-8 path")]);

    assert_eq!(code(&output), 1);
    assert_eq!(stdout(&output), "");
    assert!(
        stderr(&output).contains("Error: r1"),
        "stderr: {}",
        stderr(&output)
    );
}

// --- M2: modules and stdlib ------------------------------------------------------------------

/// A temporary directory tree for module tests. Removes itself on drop.
struct TempTree(PathBuf);

impl TempTree {
    fn new(name: &str) -> Self {
        use std::sync::atomic::{AtomicU64, Ordering};

        static NEXT: AtomicU64 = AtomicU64::new(0);
        let unique = NEXT.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("lite-m2-{}-{unique}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp tree");
        TempTree(dir)
    }

    fn file(&self, relative: &str, body: &str) -> PathBuf {
        let path = self.0.join(relative);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("create dirs");
        std::fs::write(&path, body).expect("write file");
        path
    }

    fn path(&self, relative: &str) -> PathBuf {
        self.0.join(relative)
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn esm_entry_runs_with_top_level_await() {
    let tree = TempTree::new("tla");
    tree.file(
        "main.mjs",
        "console.log('a');\nawait Promise.resolve();\nconsole.log('b');\n",
    );
    let output = lite(&[tree.path("main.mjs").to_str().unwrap()]);

    assert_eq!(code(&output), 0, "{}", stderr(&output));
    assert_eq!(stdout(&output), "a\nb\n");
}

#[test]
fn module_type_follows_package_json() {
    let tree = TempTree::new("type-module");
    tree.file("package.json", r#"{"type":"module"}"#);
    tree.file(
        "main.js",
        "export const value = 7;\nconsole.log('esm', value);\n",
    );
    let output = lite(&[tree.path("main.js").to_str().unwrap()]);

    assert_eq!(code(&output), 0, "{}", stderr(&output));
    assert_eq!(stdout(&output), "esm 7\n");
}

#[test]
fn cjs_entry_gets_the_module_wrapper() {
    let tree = TempTree::new("cjs-wrapper");
    tree.file(
        "main.cjs",
        "console.log(this === module.exports, module.id);\n\
         const path = require('path');\n\
         console.log(path.basename('/a/b.txt'));\n",
    );
    let output = lite(&[tree.path("main.cjs").to_str().unwrap()]);

    assert_eq!(code(&output), 0, "{}", stderr(&output));
    assert_eq!(stdout(&output), "true .\nb.txt\n");
}

#[test]
fn check_reports_a_syntax_error_with_caret_and_does_not_execute() {
    let tree = TempTree::new("check-bad");
    let path = tree.file("bad.js", "const x = ;\nconsole.log('ran');\n");
    let output = lite(&["--check", path.to_str().unwrap()]);
    let text = stderr(&output);

    assert_eq!(code(&output), 1);
    assert!(stdout(&output).is_empty(), "{}", stdout(&output));
    assert!(text.contains("bad.js:1"), "{text}");
    assert!(text.contains("const x = ;"), "{text}");
    // The caret points at the offending `;` (column 11), not at the CJS wrapper prefix.
    assert!(text.contains("\n          ^"), "{text}");
    assert!(text.contains("SyntaxError"), "{text}");
}

#[test]
fn check_accepts_valid_cjs_and_esm_without_running_them() {
    let tree = TempTree::new("check-good");
    let cjs = tree.file("good.cjs", "console.log('ran');\n");
    let esm = tree.file("good.mjs", "export const x = 1;\n");
    for path in [cjs, esm] {
        let output = lite(&["--check", path.to_str().unwrap()]);
        assert_eq!(code(&output), 0, "{}", stderr(&output));
        assert!(stdout(&output).is_empty(), "{}", stdout(&output));
    }
}

#[test]
fn dynamic_import_of_a_missing_module_rejects_with_a_code() {
    let tree = TempTree::new("missing-import");
    tree.file(
        "main.mjs",
        "try {\n  await import('./nope.mjs');\n} catch (error) {\n  console.log(error.code);\n}\n",
    );
    let output = lite(&[tree.path("main.mjs").to_str().unwrap()]);

    assert_eq!(code(&output), 0, "{}", stderr(&output));
    assert_eq!(stdout(&output), "ERR_MODULE_NOT_FOUND\n");
}

#[test]
fn eval_exposes_the_synthetic_module_globals() {
    let output = lite(&[
        "-e",
        "console.log(__filename, __dirname, module.id, typeof require)",
    ]);

    assert_eq!(code(&output), 0, "{}", stderr(&output));
    assert_eq!(stdout(&output), "[eval] . [eval] function\n");
}

#[test]
fn eval_exposes_require_bound_to_the_working_directory() {
    let output = lite(&["-e", "console.log(require('path').basename('/a/b.txt'))"]);

    assert_eq!(code(&output), 0, "{}", stderr(&output));
    assert_eq!(stdout(&output), "b.txt\n");
}

#[test]
fn import_meta_exposes_filename_and_dirname() {
    let tree = TempTree::new("meta");
    tree.file(
        "main.mjs",
        "console.log(import.meta.filename.endsWith('main.mjs'));\n\
         console.log(import.meta.dirname.split('/').pop() === arguments.length);\n",
    );
    // `arguments` is not defined in module scope; keep the second line simple instead.
    tree.file(
        "main.mjs",
        "console.log(import.meta.filename.endsWith('main.mjs'));\n\
         console.log(import.meta.url.startsWith('file://'));\n",
    );
    let output = lite(&[tree.path("main.mjs").to_str().unwrap()]);

    assert_eq!(code(&output), 0, "{}", stderr(&output));
    assert_eq!(stdout(&output), "true\ntrue\n");
}

#[test]
fn syntax_error_in_a_required_module_points_at_that_module() {
    let tree = TempTree::new("dep-syntax");
    tree.file("bad.cjs", "const x = ;\n");
    let entry = tree.file("entry.cjs", "require('./bad.cjs');\n");
    let output = lite(&[entry.to_str().unwrap()]);
    let text = stderr(&output);

    assert_eq!(code(&output), 1);
    let bad = tree.path("bad.cjs").display().to_string();
    assert!(text.contains(&format!("{bad}:1")), "{text}");
    assert!(text.contains("const x = ;"), "{text}");
    assert!(text.contains("\n          ^"), "{text}");
    assert!(text.contains("SyntaxError"), "{text}");
}

#[test]
fn missing_entry_file_reports_cannot_find_module() {
    let tree = TempTree::new("missing-entry");
    let missing = tree.path("nope.js");
    let output = lite(&[missing.to_str().unwrap()]);
    let text = stderr(&output);

    assert_eq!(code(&output), 1);
    assert!(text.contains("Cannot find module"), "{text}");
    assert!(!text.contains("panicked"), "{text}");
}
