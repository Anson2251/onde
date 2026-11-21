//! `lite` binary — the onde CLI.
//!
//! Entry modes: `-e/--eval EXPR`, `FILE`, `--check`, and the informational flags. There is no
//! REPL and no stdin script. The CLI is a delivery mechanism: argument parsing and flag plumbing
//! only, no runtime semantics — module type detection, resolution and diagnostics live in
//! `ln-runtime`.

use std::env;
use std::io::{self, Write};
use std::path::PathBuf;
use std::process;
use std::time::Duration;

use clap::Parser;
use ln_runtime::{Budget, Config, Failure, Isolate};

#[derive(Debug, Parser)]
#[command(
    name = "lite",
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
}

fn main() {
    process::exit(real_main());
}

/// Node's rule for script arguments: everything after the script path belongs to the script, even
/// when it is spelled like one of lite's own options.
///
/// clap cannot express this alone. A flag defined on the command keeps priority over a trailing
/// positional, so `lite app.js --check` would enable the checker instead of handing `--check` to
/// the script. Inserting the `--` terminator before the script path turns every later token into a
/// positional, which is exactly Node's behaviour.
fn with_script_terminator(argv: Vec<std::ffi::OsString>) -> Vec<std::ffi::OsString> {
    /// Options that consume the next token, so the token after them is not the script path.
    const VALUED: [&str; 5] = [
        "-e",
        "--eval",
        "--max-microtasks",
        "--microtask-timeout",
        "--io-threads",
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
            index += 1; // a lite flag (or `--eval=...`), never the script path
            continue;
        }

        argv.insert(index, std::ffi::OsString::from("--"));
        return argv;
    }
    argv
}

fn real_main() -> i32 {
    let cli = match Cli::try_parse_from(with_script_terminator(env::args_os().collect())) {
        Ok(cli) => cli,
        Err(error) => return cli_error(error),
    };
    let exe = env::args().next().unwrap_or_else(|| "lite".to_owned());
    let budget = cli.budget();
    let io_threads = cli.io_threads();
    let async_stack_traces = cli.async_stack_traces;

    if let Some(expression) = cli.eval {
        // `node -e EXPR a b` exposes `a b` in `process.argv`; a positional after `-e` is an
        // argument, not a second entry point.
        let mut argv = vec![exe];
        if let Some(file) = &cli.file {
            argv.push(file.display().to_string());
        }
        argv.extend(cli.args);
        return run_eval(&expression, argv, budget, io_threads, async_stack_traces);
    }

    let Some(file) = cli.file else {
        eprintln!("lite: expected a script (or -e EXPR)");
        eprintln!("Try 'lite --help' for more information.");
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
    config.budget = budget;
    config.io_threads = io_threads;
    config.async_stack_traces = async_stack_traces;
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

fn run_eval(
    expression: &str,
    argv: Vec<String>,
    budget: Budget,
    io_threads: usize,
    async_stack_traces: bool,
) -> i32 {
    let mut config = Config::new(argv);
    config.budget = budget;
    config.io_threads = io_threads;
    config.async_stack_traces = async_stack_traces;
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
                    let _ = writeln!(err, "lite: unknown option '{argument}'");
                }
                None => {
                    let _ = writeln!(err, "lite: unknown option");
                }
            }
            let _ = writeln!(err, "Try 'lite --help' for more information.");
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
    let _ = writeln!(err, "lite: {failure}");
    1
}
