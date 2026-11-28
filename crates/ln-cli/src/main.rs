//! `onde` binary — the onde CLI.
//!
//! Entry modes: `-e/--eval EXPR`, `FILE`, `--check`, and the informational flags. There is no
//! REPL and no stdin script. The CLI is a delivery mechanism: argument parsing and flag plumbing
//! only, no runtime semantics — module type detection, resolution and diagnostics live in
//! `ln-runtime`.

use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process;
use std::time::{Duration, Instant};

use clap::Parser;
use ln_perm::{GrantArgs, Policy};
use ln_runtime::{Budget, Config, DiagnosticsConfig, Failure, FfiTrace, Isolate};

#[derive(Debug, Parser)]
#[command(
    name = "onde",
    version = concat!("v", env!("CARGO_PKG_VERSION")),
    about = "A small Node-compatible JavaScript runtime",
    disable_help_subcommand = true
)]
struct Cli {
    /// Evaluate an expression and print its value
    #[arg(
        short = 'e',
        long = "eval",
        value_name = "EXPRESSION",
        allow_hyphen_values = true
    )]
    eval: Option<String>,

    /// Script or module to run
    #[arg(value_name = "FILE")]
    file: Option<PathBuf>,

    /// Parse the file without executing it
    #[arg(long = "check")]
    check: bool,

    /// Abort a microtask checkpoint after N jobs (scheduler guard)
    #[arg(long = "max-microtasks", value_name = "N")]
    max_microtasks: Option<u64>,

    /// Abort a microtask checkpoint after MS of wall-clock time (scheduler guard)
    #[arg(long = "microtask-timeout", value_name = "MS")]
    microtask_timeout: Option<u64>,

    /// Size of the blocking I/O pool (clamped to 1..=1024)
    #[arg(long = "io-threads", value_name = "N", default_value_t = 4)]
    io_threads: u64,

    /// Append the async ancestry of an error to its stack
    #[arg(long = "async-stack-traces")]
    async_stack_traces: bool,

    /// Cap the engine heap in MB (QuickJS has one heap: Node's old/new split does not exist, D67)
    #[arg(long = "max-old-space-size", value_name = "MB")]
    max_old_space_size: Option<u64>,

    /// Write a Chrome trace (turns, phases, ops) to FILE
    #[arg(long = "trace-events", value_name = "FILE")]
    trace_events: Option<PathBuf>,

    /// Report sampled collections in --trace-events (they are sampled, see D69)
    #[arg(long = "trace-gc")]
    trace_gc: bool,

    /// Trace FFI calls to stderr, synchronously, so the last line survives a crash
    /// (`--trace-ffi=full` adds layouts and argument contents)
    #[arg(
        long = "trace-ffi",
        value_name = "LEVEL",
        num_args = 0..=1,
        require_equals = true,
        default_missing_value = "summary",
        value_parser = ["summary", "full"]
    )]
    trace_ffi: Option<String>,

    /// Print per-phase and per-op time at exit
    #[arg(long = "timing")]
    timing: bool,

    /// `--trace-events` buffer before a flush, in MiB
    #[arg(long = "trace-buffer-mb", value_name = "MB", default_value_t = 4)]
    trace_buffer_mb: usize,

    /// Run test files instead of a script (`node:test`; discovers `*.test.js`)
    #[arg(long = "test")]
    test: bool,

    /// Opt into the permission model: deny-all unless a policy file or --allow-* flags follow
    #[arg(long = "permission")]
    permission: bool,

    /// A reviewed policy file (JSON with // and /* */ comments); mutually exclusive with --allow-*
    #[arg(long = "permission-file", value_name = "FILE")]
    permission_file: Option<PathBuf>,

    /// Grant read access to a path prefix (repeatable)
    #[arg(long = "allow-fs-read", value_name = "PATH")]
    allow_fs_read: Vec<String>,

    /// Grant write access to a path prefix (repeatable)
    #[arg(long = "allow-fs-write", value_name = "PATH")]
    allow_fs_write: Vec<String>,

    /// Grant outbound connections to HOST, HOST:PORT, an address, or a Unix socket path
    #[arg(long = "allow-net-connect", value_name = "ENDPOINT")]
    allow_net_connect: Vec<String>,

    /// Grant listening on HOST:PORT or :PORT (repeatable)
    #[arg(long = "allow-net-listen", value_name = "ENDPOINT")]
    allow_net_listen: Vec<String>,

    /// Grant name resolution for HOST (repeatable)
    #[arg(long = "allow-net-resolve", value_name = "HOST")]
    allow_net_resolve: Vec<String>,

    /// Grant spawning an executable, by bare name or by resolved path (repeatable)
    #[arg(long = "allow-child-process", value_name = "COMMAND")]
    allow_child_process: Vec<String>,

    /// Grant reading an environment variable by name (repeatable)
    #[arg(long = "allow-env", value_name = "NAME")]
    allow_env: Vec<String>,

    /// Grant spawning worker threads
    #[arg(long = "allow-worker")]
    allow_worker: bool,

    /// Grant loading native code (`onde:ffi` and sqlite extensions)
    #[arg(long = "allow-ffi")]
    allow_ffi: bool,

    /// Arguments exposed through process.argv after the script name
    #[arg(
        value_name = "ARGS",
        trailing_var_arg = true,
        allow_hyphen_values = true
    )]
    args: Vec<String>,
}

impl Cli {
    fn budget(&self) -> Budget {
        Budget {
            max_jobs_per_checkpoint: self.max_microtasks,
            max_wall_per_checkpoint: self.microtask_timeout.map(Duration::from_millis),
        }
    }

    /// The pool size is clamped rather than rejected so a hostile value cannot create thousands
    /// of OS threads; the flag is a tuning knob, not a correctness boundary.
    fn io_threads(&self) -> usize {
        self.io_threads.clamp(1, 1024) as usize
    }

    /// The heap cap in bytes. `saturating_mul` because a silly `--max-old-space-size` is a silly
    /// cap, not a panic in argument parsing.
    fn max_old_space_size(&self) -> Option<u64> {
        self.max_old_space_size
            .map(|mb| mb.saturating_mul(1024 * 1024))
    }

    /// Build the permission policy from the two grant channels, or `None` when the model is off.
    ///
    /// The file and the flags are mutually exclusive because both come from the caller and a
    /// union lets a wrapper widen a reviewed file by appending an argument (ADR-0011 §4.3).
    fn permissions(&self) -> Result<Option<Policy>, String> {
        let any_flag = !self.allow_fs_read.is_empty()
            || !self.allow_fs_write.is_empty()
            || !self.allow_net_connect.is_empty()
            || !self.allow_net_listen.is_empty()
            || !self.allow_net_resolve.is_empty()
            || !self.allow_child_process.is_empty()
            || !self.allow_env.is_empty()
            || self.allow_worker
            || self.allow_ffi;

        if !self.permission {
            if self.permission_file.is_some() || any_flag {
                return Err(
                    "--permission is required with --permission-file or --allow-*".to_owned(),
                );
            }
            return Ok(None);
        }

        if let Some(file) = &self.permission_file {
            if any_flag {
                return Err(
                    "--permission-file and --allow-* cannot be combined; use one grant channel"
                        .to_owned(),
                );
            }
            return Policy::from_file(file)
                .map(Some)
                .map_err(|error| format!("permissions: {error}"));
        }

        let cwd = env::current_dir().map_err(|error| format!("cannot read the cwd: {error}"))?;
        let mut args = GrantArgs::new(cwd);
        args.fs_read = self.allow_fs_read.clone();
        args.fs_write = self.allow_fs_write.clone();
        args.net_connect = self.allow_net_connect.clone();
        args.net_listen = self.allow_net_listen.clone();
        args.net_resolve = self.allow_net_resolve.clone();
        args.child_spawn = self.allow_child_process.clone();
        args.env_read = self.allow_env.clone();
        args.worker = self.allow_worker;
        args.ffi = self.allow_ffi;
        Policy::from_args(&args)
            .map(Some)
            .map_err(|error| format!("permissions: {error}"))
    }

    /// What the diagnostic flags asked for; all-empty when none was passed.
    fn diagnostics(&self) -> DiagnosticsConfig {
        DiagnosticsConfig {
            trace_events: self.trace_events.clone(),
            trace_buffer_mb: self.trace_buffer_mb.clamp(1, 512),
            timing: self.timing,
            trace_gc: self.trace_gc,
            trace_ffi: match self.trace_ffi.as_deref() {
                Some("full") => FfiTrace::Full,
                Some(_) => FfiTrace::Summary,
                None => FfiTrace::Off,
            },
            // Filled in by `real_main` after the policy is parsed.
            setup_micros: None,
        }
    }
}

fn main() {
    process::exit(real_main());
}

/// Node's rule for script arguments: everything after the script path belongs to the script, even
/// when it is spelled like one of onde's own options.
///
/// clap cannot express this alone. A flag defined on the command keeps priority over a trailing
/// positional, so `onde app.js --check` would enable the checker instead of handing `--check` to
/// the script. Inserting the `--` terminator before the script path turns every later token into a
/// positional, which is exactly Node's behaviour.
fn with_script_terminator(argv: Vec<std::ffi::OsString>) -> Vec<std::ffi::OsString> {
    /// Options that consume the next token, so the token after them is not the script path.
    /// Every value-taking flag must be listed: a missing one makes its value look like the script,
    /// and the terminator is inserted before it (which is how `--trace-events FILE` first failed).
    const VALUED: [&str; 16] = [
        "-e",
        "--eval",
        "--max-microtasks",
        "--microtask-timeout",
        "--io-threads",
        "--max-old-space-size",
        "--trace-events",
        "--trace-buffer-mb",
        "--permission-file",
        "--allow-fs-read",
        "--allow-fs-write",
        "--allow-net-connect",
        "--allow-net-listen",
        "--allow-net-resolve",
        "--allow-child-process",
        "--allow-env",
    ];

    let mut argv = argv;
    let mut index = 1; // argv[0] is the program name
    while index < argv.len() {
        let token = argv[index].to_string_lossy().into_owned();

        if token == "--" {
            // The caller already separated the script; clap will do the right thing.
            return argv;
        }
        if VALUED.contains(&token.as_str()) {
            index += 2; // the option and its value
            continue;
        }
        if token.starts_with('-') {
            index += 1; // a onde flag (or `--eval=...`), never the script path
            continue;
        }

        argv.insert(index, std::ffi::OsString::from("--"));
        return argv;
    }
    argv
}

/// The isolate knobs the entry points share. One struct so the file, eval and test entry points do
/// not grow a parameter per flag.
struct RunOptions {
    budget: Budget,
    io_threads: usize,
    async_stack_traces: bool,
    max_old_space_size: Option<u64>,
    diagnostics: DiagnosticsConfig,
    permissions: Option<Policy>,
}

fn real_main() -> i32 {
    let cli = match Cli::try_parse_from(with_script_terminator(env::args_os().collect())) {
        Ok(cli) => cli,
        Err(error) => return cli_error(error),
    };
    let exe = env::args().next().unwrap_or_else(|| "onde".to_owned());
    let budget = cli.budget();
    let io_threads = cli.io_threads();
    let async_stack_traces = cli.async_stack_traces;
    let max_old_space_size = cli.max_old_space_size();
    let mut diagnostics = cli.diagnostics();
    let permissions_start = Instant::now();
    let permissions = match cli.permissions() {
        Ok(permissions) => permissions,
        Err(message) => {
            eprintln!("onde: {message}");
            return 1;
        }
    };
    if permissions.is_some() {
        diagnostics.setup_micros = Some(
            permissions_start
                .elapsed()
                .as_micros()
                .min(u128::from(u64::MAX)) as u64,
        );
    }
    let options = RunOptions {
        budget,
        io_threads,
        async_stack_traces,
        max_old_space_size,
        diagnostics,
        permissions,
    };

    if cli.test {
        return run_tests(&cli, &exe, &options);
    }

    if let Some(expression) = cli.eval {
        // `node -e EXPR a b` exposes `a b` in `process.argv`; a positional after `-e` is an
        // argument, not a second entry point.
        let mut argv = vec![exe];
        if let Some(file) = &cli.file {
            argv.push(file.display().to_string());
        }
        argv.extend(cli.args);
        return run_eval(&expression, argv, &options);
    }

    let Some(file) = cli.file else {
        eprintln!("onde: expected a script (or -e EXPR)");
        eprintln!("Try 'onde --help' for more information.");
        return 1;
    };

    // Node exposes the entry as an absolute path in `process.argv[1]`. Resolve it here so the
    // loader and `process.argv` agree, and leave a missing file to the resolver's Node-shaped
    // `Cannot find module` error.
    let absolute = std::fs::canonicalize(&file).unwrap_or_else(|_| {
        if file.is_absolute() {
            file.clone()
        } else {
            env::current_dir()
                .map(|cwd| cwd.join(&file))
                .unwrap_or_else(|_| file.clone())
        }
    });
    let filename = absolute.display().to_string();

    let mut argv = vec![exe, filename];
    argv.extend(cli.args);
    let mut config = Config::new(argv);
    config.inheritable.budget = options.budget;
    config.inheritable.io_threads = options.io_threads;
    config.async_stack_traces = options.async_stack_traces;
    config.inheritable.max_old_space_size = options.max_old_space_size;
    config.inheritable.permissions = options.permissions.clone();
    config.inheritable.trace_ffi = options.diagnostics.trace_ffi;
    config.diagnostics = options.diagnostics.clone();
    let mut isolate = match Isolate::new(config) {
        Ok(isolate) => isolate,
        Err(failure) => return report_failure(failure),
    };

    let result = if cli.check {
        isolate.check_file(&absolute)
    } else {
        isolate.run_file(&absolute)
    };

    match result {
        Ok(outcome) => outcome.exit_code,
        Err(failure) => report_failure(failure),
    }
}

/// `onde --test [FILES…]`: discover, then hand the list to the runtime's JavaScript runner.
///
/// The CLI owns discovery because it is argument parsing (m7-plan §4.6); the runner, the reporter
/// and the exit-code decision live in `js/lib/test.js`. The positional `FILE` and `ARGS` fields
/// already carry every path: with the `--` terminator in place, the first path lands in `file` and
/// the rest in `args`, so `--test` does not need its own `Vec<PathBuf>` and the CLI keeps its
/// single-script shape.
fn run_tests(cli: &Cli, exe: &str, options: &RunOptions) -> i32 {
    if cli.eval.is_some() {
        eprintln!("onde: --test cannot be combined with -e EXPR");
        return 1;
    }

    let mut requested: Vec<PathBuf> = Vec::new();
    if let Some(file) = &cli.file {
        requested.push(file.clone());
    }
    requested.extend(cli.args.iter().map(PathBuf::from));

    let files = match discover_tests(&requested) {
        Ok(files) => files,
        Err(message) => {
            eprintln!("onde: {message}");
            return 1;
        }
    };
    if files.is_empty() {
        // Node prints "Could not find any test files matching pattern" and exits 1; the wording
        // is ours, the status is the same contract.
        eprintln!("onde: no test files found");
        return 1;
    }

    let paths: Vec<String> = files
        .iter()
        .map(|path| path.display().to_string())
        .collect();
    // Node runs each test file in its own process with `process.argv = [exec, file]`; one isolate
    // runs all of them here, so `argv[1..]` is the discovered list in execution order.
    let mut argv = vec![exe.to_owned()];
    argv.extend(paths.iter().cloned());

    let mut config = Config::new(argv);
    config.inheritable.budget = options.budget;
    config.inheritable.io_threads = options.io_threads;
    config.async_stack_traces = options.async_stack_traces;
    config.inheritable.max_old_space_size = options.max_old_space_size;
    config.inheritable.permissions = options.permissions.clone();
    config.inheritable.trace_ffi = options.diagnostics.trace_ffi;
    config.diagnostics = options.diagnostics.clone();
    config.test_files = Some(paths);

    let mut isolate = match Isolate::new(config) {
        Ok(isolate) => isolate,
        Err(failure) => return report_failure(failure),
    };
    match isolate.run_tests() {
        Ok(outcome) => outcome.exit_code,
        Err(failure) => report_failure(failure),
    }
}

/// Resolve the paths `onde --test` should run, sorted and deduplicated.
///
/// Two discovery rules, both from the plan's table: a named file is run as named and a named
/// directory is searched for `*.test.js`; with no path at all every `.js` under `test/` is a test
/// file, which is Node's `test/**/*.js` rule. Sorting keeps the transcript deterministic (the
/// runner is sequential, so discovery order is execution order).
fn discover_tests(requested: &[PathBuf]) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    if requested.is_empty() {
        if Path::new("test").is_dir() {
            collect_test_files(Path::new("test"), true, &mut files)?;
        }
    } else {
        for path in requested {
            let metadata = fs::metadata(path)
                .map_err(|error| format!("cannot find test path '{}': {error}", path.display()))?;
            if metadata.is_dir() {
                collect_test_files(path, false, &mut files)?;
            } else {
                files.push(path.clone());
            }
        }
    }

    // Canonical paths are what the CJS loader and stack traces use; dedupe after resolving so
    // `./a.test.js` and `a.test.js` run once.
    for path in &mut files {
        if let Ok(canonical) = fs::canonicalize(&*path) {
            *path = canonical;
        }
    }
    files.sort();
    files.dedup();
    Ok(files)
}

/// Recursively collect `.js` files under `directory`.
///
/// `every_js` is the no-argument rule (`test/**/*.js`); otherwise only `*.test.js` is collected.
/// Symlinks are not followed, so a link cycle cannot make discovery loop.
fn collect_test_files(
    directory: &Path,
    every_js: bool,
    files: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("cannot read '{}': {error}", directory.display()))?;
    let mut entries = entries
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("cannot read '{}': {error}", directory.display()))?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("cannot stat '{}': {error}", path.display()))?;
        if file_type.is_dir() {
            collect_test_files(&path, every_js, files)?;
        } else if file_type.is_file()
            && path.extension().is_some_and(|extension| extension == "js")
            && (every_js || is_test_file_name(&path))
        {
            files.push(path);
        }
    }
    Ok(())
}

fn is_test_file_name(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".test.js"))
}

fn run_eval(expression: &str, argv: Vec<String>, options: &RunOptions) -> i32 {
    let mut config = Config::new(argv);
    config.inheritable.budget = options.budget;
    config.inheritable.io_threads = options.io_threads;
    config.async_stack_traces = options.async_stack_traces;
    config.inheritable.max_old_space_size = options.max_old_space_size;
    config.inheritable.permissions = options.permissions.clone();
    config.inheritable.trace_ffi = options.diagnostics.trace_ffi;
    config.diagnostics = options.diagnostics.clone();
    // Node's `-e` evaluates as CommonJS with `require` in scope; keep the completion-value
    // printing, which is onde's documented convenience.
    config.expose_require = true;
    let mut isolate = match Isolate::new(config) {
        Ok(isolate) => isolate,
        Err(failure) => return report_failure(failure),
    };

    match isolate.run(expression, "[eval]") {
        Ok(outcome) => {
            if let Some(value) = outcome.value {
                let mut out = io::stdout().lock();
                let _ = writeln!(out, "{value}");
                let _ = out.flush();
            }
            outcome.exit_code
        }
        Err(failure) => report_failure(failure),
    }
}

/// Translate a clap parse result into `onde`'s exit-code convention.
///
/// Help and version are successful output; every usage error is exit 1 (Node's convention), and
/// unknown options keep the wording the CLI documents.
fn cli_error(error: clap::Error) -> i32 {
    use clap::error::{ContextKind, ContextValue, ErrorKind};

    match error.kind() {
        ErrorKind::DisplayHelp | ErrorKind::DisplayVersion => {
            let _ = error.print();
            0
        }
        ErrorKind::UnknownArgument => {
            let argument = error
                .get(ContextKind::InvalidArg)
                .and_then(|value| match value {
                    ContextValue::String(text) => Some(text.clone()),
                    _ => None,
                });
            let mut err = io::stderr().lock();
            match argument {
                Some(argument) => {
                    let _ = writeln!(err, "onde: unknown option '{argument}'");
                }
                None => {
                    let _ = writeln!(err, "onde: unknown option");
                }
            }
            let _ = writeln!(err, "Try 'onde --help' for more information.");
            1
        }
        _ => {
            let _ = error.print();
            1
        }
    }
}

/// Print an engine-level failure (an onde bug, not a user program error). User errors are
/// rendered by the runtime at the point they happen.
fn report_failure(failure: Failure) -> i32 {
    let mut err = io::stderr().lock();
    let _ = writeln!(err, "onde: {failure}");
    // A compiled-app payload from another engine exits 78 rather than 1, so a build system can
    // tell "rebuild the app" apart from "the program is broken". `onde` itself never carries a
    // payload, but the same `Failure` reaches this function through the shared runtime.
    failure.exit_code()
}
