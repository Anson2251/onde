//! Isolate bootstrap and the M1 event loop for lite-node.
//!
//! One [`Isolate`] = one engine + one scheduler + one loop driver + the host globals. It is the
//! only place that decides when microtasks run (ADR-0002 invariant I1): every host→JS callback
//! is followed by [`Isolate::checkpoint_all`], and engine jobs are pumped from exactly one place.
//!
//! # Shape
//!
//! * `ln-sched` owns the policy: two microtask queues, the checkpoint, timers, immediates, the
//!   exit decision. It knows nothing about JavaScript.
//! * This crate owns the boundary: native primitives push into a [`Bridge`]; scheduler job
//!   bodies call JS through the engine and then drain the bridge back into the scheduler.
//! * `bootstrap.js` owns the Node surface: `process`, timers, the event emitter and the
//!   rejection table. JS values never leave the engine.
//!
//! # M1 semantics implemented here
//!
//! `process.nextTick`, `setTimeout`/`setInterval`/`setImmediate` and clears, `ref`/`unref`,
//! Node's 1 ms clamp, `beforeExit`/`exit`, `process.exit`/`exitCode`, `uncaughtException`,
//! `unhandledRejection` and `rejectionHandled`, and the `--max-microtasks`/`--microtask-timeout`
//! fatal-unwind path. Modules are M2; `fs` and I/O are M3+.

use std::cell::{Cell, RefCell};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Instant;

pub use ln_engine::js;
pub use ln_engine::{CaughtError, Completion, Engine, PumpOutcome};
use ln_modules::Format;
pub use ln_sched::Budget;
use ln_sched::{
    ChannelReactor, Checkpoint, Driver, ErrorInfo, Event, HandleOutcome, Origin, PromiseKey,
    Reactor, Scheduler, SinkMailbox, Turn,
};

mod args;
mod host;
mod host_crypto;
mod host_error;
mod modules;
pub mod ops;
mod report;
pub use report::render_uncaught;

use host::HostState;
use modules::ModuleRuntime;
use ops::OpBridge;

/// Compiled into the binary; evaluated once per isolate before the entry script.
const BOOTSTRAP: &str = include_str!("../../../js/bootstrap.js");
const BOOTSTRAP_NAME: &str = "<lite:bootstrap>";

/// Private value thrown by `process.exit` so the host can unwind the current callback
/// immediately. JS can catch it, but the recorded exit code is authoritative: the runtime stops
/// at the next boundary and never drains the remaining queue (ADR-0002 R3).
const EXIT_SENTINEL: &str = "lite-node:process.exit";

/// Callback kinds understood by `bootstrap.js`'s `__ln_dispatch`.
const KIND_TIMER: u8 = 0;
const KIND_IMMEDIATE: u8 = 1;
const KIND_TICK: u8 = 2;

/// Isolate configuration.
#[derive(Debug, Clone)]
pub struct Config {
    /// Values exposed as `process.argv`. `argv[0]` is the program name, as in Node.
    pub argv: Vec<String>,
    /// Bounds on one checkpoint. Defaults to unbounded (Node has no equivalent); the CLI wires
    /// `--max-microtasks` and `--microtask-timeout` into this.
    pub budget: Budget,
    /// Expose a CommonJS `require` bound to the working directory as a global. Node's `-e`
    /// does this; a file entry point gets `require` through the module wrapper instead.
    pub expose_require: bool,
    /// Blocking pool size for async ops (`--io-threads`). The pool is created on the first
    /// async op, never at boot.
    pub io_threads: usize,
}

impl Config {
    pub fn new(argv: Vec<String>) -> Self {
        Config {
            argv,
            budget: Budget::UNBOUNDED,
            expose_require: false,
            io_threads: 4,
        }
    }
}

/// Why the isolate could not be created or could not evaluate the bootstrap.
///
/// User-level failures (uncaught errors, unhandled rejections, budget exhaustion) are not
/// returned here: they are reported where they happen, Node-style, and the run completes with
/// an exit code.
#[derive(Debug)]
pub enum Failure {
    /// The engine could not be created, or the bootstrap script failed. A lite-node bug.
    Engine(String),
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failure::Engine(message) => write!(f, "engine failure: {message}"),
        }
    }
}

impl std::error::Error for Failure {}

/// What the caller should do after a run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunOutcome {
    /// Completion value of an `-e` expression, already stringified. `None` for files/`undefined`.
    pub value: Option<String>,
    /// Exit code: `process.exit`/`process.exitCode` if used, else 0.
    pub exit_code: i32,
}

#[derive(Debug)]
pub(crate) struct ExitState {
    /// `process.exit` was called.
    pub(crate) requested: Cell<bool>,
    /// Current `process.exitCode` value. `exit` listeners may change it.
    pub(crate) exit_code: Cell<i32>,
}

impl Default for ExitState {
    fn default() -> Self {
        ExitState {
            requested: Cell::new(false),
            exit_code: Cell::new(0),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BudgetHit {
    Jobs(u64),
    Wall,
}

#[derive(Debug, Default)]
pub(crate) struct RuntimeState {
    /// A fatal error was reported and no `uncaughtException`/`unhandledRejection` handler
    /// absorbed it. The loop must stop and run `exit` listeners.
    pub(crate) fatal: Cell<bool>,
    /// Which budget stopped the run, if any.
    pub(crate) budget: Cell<Option<BudgetHit>>,
}

/// Rejection events raised by the JS tracker and drained into the scheduler at safe points.
#[derive(Debug)]
pub(crate) enum RejectionEvent {
    Reject { id: u64, reason: String },
    Handle { id: u64 },
}

/// Data pushed by native primitives during JS execution.
///
/// The scheduler is not reachable from inside a JS callback (its `&mut self` is held by the
/// checkpoint), so primitives queue owned ids here and the runtime drains them between jobs.
#[derive(Debug, Default)]
pub(crate) struct Bridge {
    pub(crate) ticks: Vec<u64>,
    pub(crate) rejections: Vec<RejectionEvent>,
}

/// The event sink installed on the scheduler. It owns everything needed to turn a scheduler
/// event into a JS event and to print Node-shaped fatal output.
#[derive(Clone)]
struct Dispatcher {
    engine: Rc<Engine>,
    exit: Rc<ExitState>,
    state: Rc<RuntimeState>,
    stop: Rc<Cell<bool>>,
    bridge: Rc<RefCell<Bridge>>,
    mailbox: SinkMailbox,
    filename: Rc<str>,
    source: Rc<str>,
    /// CJS wrapper columns for line 1 (0 for scripts and ESM).
    first_line_offset: usize,
}

impl Dispatcher {
    /// Report an error the way Node does: `uncaughtException` listeners first, then fatal
    /// output. Used for job exceptions and for exceptions thrown by other event listeners
    /// (Node routes those through `uncaughtException` too).
    fn route_uncaught(&self, info: &ErrorInfo) {
        if self.exit.requested.get() {
            return;
        }
        match emit_uncaught(&self.engine, info) {
            Ok(true) => {}
            Ok(false) => self.report_fatal(info),
            Err(caught) => self.report_fatal_caught(&caught),
        }
        self.maybe_pump();
    }

    /// If a handler queued promise jobs, hand the scheduler a pump for them. The pump joins the
    /// tail of the current microtask pass, which is where a job enqueued by a running job runs.
    fn maybe_pump(&self) {
        if !self.engine.is_job_pending() {
            return;
        }
        let engine = self.engine.clone();
        let exit = self.exit.clone();
        let bridge = self.bridge.clone();
        let state = self.state.clone();
        let stop = self.stop.clone();
        self.mailbox
            .push(Origin::Microtask, "engine job", move |s| {
                pump_job(&engine, &exit, &bridge, &state, &stop, s)
            });
    }

    fn report_fatal(&self, info: &ErrorInfo) {
        if self.exit.requested.get() {
            return;
        }
        let caught = caught_from_info(info);
        let text = report::render_uncaught_with_offset(
            &caught,
            &self.filename,
            &self.source,
            self.first_line_offset,
        );
        let mut err = io::stderr().lock();
        let _ = writeln!(err, "{text}");
        let _ = err.flush();

        self.exit.exit_code.set(1);
        self.state.fatal.set(true);
        self.stop.set(true);
    }

    fn report_fatal_caught(&self, caught: &CaughtError) {
        self.report_fatal(&info_from_caught(caught));
    }

    /// `exit` listeners run after the status is decided; a throw is reported but does not change
    /// it (Node exits 0 after printing).
    fn report_exit_error(&self, caught: &CaughtError) {
        let text = report::render_uncaught_with_offset(
            caught,
            &self.filename,
            &self.source,
            self.first_line_offset,
        );
        let mut err = io::stderr().lock();
        let _ = writeln!(err, "{text}");
        let _ = err.flush();
    }

    fn handle(&self, event: &Event) {
        match event {
            Event::Uncaught { error, .. } => {
                if self.state.budget.get().is_some() {
                    // An interrupted job is a budget trip, not a user exception.
                    return;
                }
                self.route_uncaught(error);
            }
            Event::UnhandledRejection { promise, .. } => {
                // With no listener the JS helper throws the actual reason, which surfaces here
                // as a caught error and is routed like Node's default uncaught exception.
                match emit_unhandled(&self.engine, promise.0) {
                    Ok(()) => self.maybe_pump(),
                    Err(caught) => {
                        self.route_uncaught(&info_from_caught(&caught));
                    }
                }
            }
            Event::RejectionHandled { promise } => {
                match emit_rejection_handled(&self.engine, promise.0) {
                    Ok(()) => self.maybe_pump(),
                    Err(caught) => self.route_uncaught(&info_from_caught(&caught)),
                }
            }
            Event::BudgetExceeded { .. } => {}
        }
    }
}

/// One engine + one scheduler + one loop. Not `Send`: an isolate is pinned to its thread.
pub struct Isolate {
    engine: Rc<Engine>,
    sched: Scheduler,
    driver: Rc<RefCell<Driver>>,
    bridge: Rc<RefCell<Bridge>>,
    exit: Rc<ExitState>,
    state: Rc<RuntimeState>,
    stop: Rc<Cell<bool>>,
    reactor: Box<dyn Reactor>,
    dispatcher: Option<Dispatcher>,
    modules: Rc<ModuleRuntime>,
    /// The async-op bridge: pool, result slots and abort flags.
    ops: Rc<OpBridge>,
    start: Instant,
    /// Last engine heap measurement. Refreshed between JS calls: `Runtime::memory_usage`
    /// re-borrows the runtime, which panics while a JS callback is on the stack.
    memory: Rc<Cell<usize>>,
    finished: bool,
}

impl Isolate {
    pub fn new(config: Config) -> Result<Self, Failure> {
        let engine = Rc::new(Engine::new().map_err(|e| Failure::Engine(e.to_string()))?);
        let mut sched = Scheduler::new();
        sched.set_budget(config.budget);

        let driver = Rc::new(RefCell::new(Driver::new()));
        let bridge = Rc::new(RefCell::new(Bridge::default()));
        let exit = Rc::new(ExitState::default());
        let state = Rc::new(RuntimeState::default());
        let stop = sched.stop_handle();
        let modules =
            ModuleRuntime::new(std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        modules.install(&engine);
        let memory = Rc::new(Cell::new(0));
        let (reactor, sender) = ChannelReactor::new();
        let ops = Rc::new(OpBridge::new(driver.clone(), sender, config.io_threads));

        let isolate = Isolate {
            engine,
            sched,
            driver,
            bridge,
            exit,
            state,
            stop,
            // The completion channel is the only wakeup the loop knows about; the op bridge's
            // sink sends through it.
            reactor: Box::new(reactor),
            dispatcher: None,
            modules,
            ops,
            start: Instant::now(),
            memory,
            finished: false,
        };
        isolate.install(&config)?;
        isolate.install_tracker();
        Ok(isolate)
    }

    /// Replace the reactor. Tests use a scripted reactor; real I/O arrives in M3.
    pub fn set_reactor(&mut self, reactor: Box<dyn Reactor>) {
        self.reactor = reactor;
    }

    fn install(&self, config: &Config) -> Result<(), Failure> {
        let host_state = HostState {
            driver: self.driver.clone(),
            bridge: self.bridge.clone(),
            exit: self.exit.clone(),
            stop: self.stop.clone(),
            start: self.start,
            modules: self.modules.clone(),
            memory: self.memory.clone(),
            ops: self.ops.clone(),
        };

        self.engine
            .with_ctx(|ctx| host::install(&ctx, &host_state, &config.argv).map_err(engine_error))?;

        match self.engine.eval_global(BOOTSTRAP, BOOTSTRAP_NAME) {
            Ok(_) => {}
            // A failing bootstrap is a bug in lite-node; surface it as an engine failure so the
            // CLI does not pretend it was a user script error.
            Err(error) => {
                return Err(Failure::Engine(format!(
                    "bootstrap failed: {}",
                    error.body()
                )))
            }
        }

        if config.expose_require {
            self.expose_require()?;
        }
        Ok(())
    }

    /// Node's `-e` runs with a global `require` bound to the current directory.
    fn expose_require(&self) -> Result<(), Failure> {
        let cwd = std::env::current_dir()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|_| ".".to_owned());
        self.engine
            .with_ctx(|ctx| -> js::Result<()> {
                let expose: js::Function = ctx.globals().get("__ln_expose_require")?;
                expose.call::<_, ()>((cwd,))
            })
            .map_err(|error| Failure::Engine(format!("install require: {error}")))
    }

    /// Install the engine's rejection tracker. It forwards to the JS table, which keeps the
    /// actual promise/reason values and mints the ids the scheduler uses.
    fn install_tracker(&self) {
        self.engine
            .set_rejection_tracker(|ctx, promise, reason, is_handled| {
                let result: js::Result<()> = (|| {
                    let helper: Option<js::Function> = ctx.globals().get("__ln_track_rejection")?;
                    match helper {
                        Some(helper) => helper.call::<_, ()>((promise, reason, is_handled)),
                        None => Ok(()),
                    }
                })();
                if result.is_err() {
                    // The table is deliberately simple and non-throwing; never leave an exception
                    // pending across the engine callback.
                    let _ = ctx.catch();
                }
            });
    }

    /// Evaluate `source` as a classic script and run the loop until the process should exit.
    ///
    /// This is the `-e` path. File entry points go through [`Isolate::run_file`], which detects
    /// CJS vs ESM and gives modules their own loader.
    pub fn run(&mut self, source: &str, filename: &str) -> Result<RunOutcome, Failure> {
        self.begin(filename, source, 0);

        let evaluated = self.engine.eval_global(source, filename);
        if self.exit.requested.get() {
            return Ok(self.finish(None));
        }

        let value = match evaluated {
            Ok(Completion::Undefined) => None,
            Ok(Completion::Value(value)) => Some(value),
            Err(error) => {
                if let Some(outcome) = self.entry_error(error) {
                    return Ok(outcome);
                }
                None
            }
        };

        self.settle(value)
    }

    /// Run a file entry point: `.mjs` is ESM, `.cjs` is CJS, `.js` follows the nearest
    /// `package.json` `type`, and a bare `require`-style path is resolved before entering.
    pub fn run_file(&mut self, path: &Path) -> Result<RunOutcome, Failure> {
        let Some((resolved, format)) = self.resolve_entry(path) else {
            return Ok(self.finish_failure());
        };
        let Some(source) = self.read_entry(&resolved) else {
            return Ok(self.finish_failure());
        };

        let filename = resolved.display().to_string();
        self.begin(&filename, &source, cjs_column_offset(format));

        let evaluated = match format {
            Format::Module => {
                let name = ln_modules::url::path_to_file_url(&resolved);
                let dirname = resolved.parent().map(|parent| parent.display().to_string());
                self.engine
                    .eval_module(&source, &name, Some(&filename), dirname.as_deref(), true)
            }
            Format::CommonJs => self.eval_cjs_entry(&resolved),
            Format::Json => {
                self.report_entry_error(
                    "ERR_UNKNOWN_FILE_EXTENSION",
                    &format!("Cannot run JSON file {}", resolved.display()),
                );
                return Ok(self.finish_failure());
            }
            Format::Native => {
                self.report_entry_error(
                    "ERR_DLOPEN_FAILED",
                    &format!(
                        "Cannot load native addon {}: lite-node does not support N-API modules",
                        resolved.display()
                    ),
                );
                return Ok(self.finish_failure());
            }
        };

        if self.exit.requested.get() {
            return Ok(self.finish(None));
        }

        if let Err(error) = evaluated {
            if let Some(outcome) = self.entry_error(error) {
                return Ok(outcome);
            }
        }

        self.settle(None)
    }

    /// `lite --check`: compile the entry without running it.
    ///
    /// CJS is checked by compiling the wrapper function expression (the body is never called);
    /// ESM is checked with the engine's compile-only module path. The diagnostics use the same
    /// renderer as a fatal runtime error, so the file, line, column and caret match.
    pub fn check_file(&mut self, path: &Path) -> Result<RunOutcome, Failure> {
        let Some((resolved, format)) = self.resolve_entry(path) else {
            return Ok(self.finish_failure());
        };
        let Some(source) = self.read_entry(&resolved) else {
            return Ok(self.finish_failure());
        };

        let filename = resolved.display().to_string();
        self.begin(&filename, &source, cjs_column_offset(format));

        let compiled = match format {
            Format::Module => {
                let name = ln_modules::url::path_to_file_url(&resolved);
                self.engine.compile_module(&source, &name)
            }
            Format::CommonJs => self.engine.compile_cjs(&source, &filename),
            Format::Json | Format::Native => {
                self.report_entry_error(
                    "ERR_UNKNOWN_FILE_EXTENSION",
                    &format!("Cannot check {}", resolved.display()),
                );
                return Ok(self.finish_failure());
            }
        };

        match compiled {
            Ok(()) => Ok(self.finish_check()),
            Err(error) => {
                let info = info_from_caught(&error);
                if let Some(dispatcher) = self.dispatcher.as_ref() {
                    dispatcher.report_fatal(&info);
                }
                Ok(self.finish(None))
            }
        }
    }

    /// Split a CLI path into an absolute file and the format the loader must use.
    fn resolve_entry(&mut self, path: &Path) -> Option<(PathBuf, Format)> {
        match self.modules.resolver.resolve_entry(path) {
            Ok(resolved) => Some(resolved),
            Err(failure) => {
                self.report_resolution(&failure);
                None
            }
        }
    }

    fn read_entry(&mut self, path: &Path) -> Option<String> {
        match fs::read_to_string(path) {
            Ok(source) => Some(source),
            Err(error) => {
                let code = host_error::io_error_code(&error);
                self.report_entry_error(
                    code,
                    &host_error::io_error_message(code, "open", path, &error),
                );
                None
            }
        }
    }

    /// Sample the engine heap while no JS callback is on the stack.
    fn refresh_memory(&self) {
        self.memory.set(self.engine.memory_usage());
    }

    /// Reset per-run state and install the dispatcher for `filename`/`source`.
    fn begin(&mut self, filename: &str, source: &str, first_line_offset: usize) {
        self.refresh_memory();
        self.sched.clear_stop();
        self.exit.requested.set(false);
        self.exit.exit_code.set(0);
        self.state.fatal.set(false);
        self.state.budget.set(None);
        self.finished = false;

        let dispatcher = Dispatcher {
            engine: self.engine.clone(),
            exit: self.exit.clone(),
            state: self.state.clone(),
            stop: self.stop.clone(),
            bridge: self.bridge.clone(),
            mailbox: self.sched.sink_mailbox(),
            filename: Rc::from(filename),
            source: Rc::from(source),
            first_line_offset,
        };
        {
            let dispatcher = dispatcher.clone();
            self.sched
                .set_event_sink(move |event| dispatcher.handle(event));
        }
        self.dispatcher = Some(dispatcher);
    }

    /// Route a failure from the entry evaluation.
    ///
    /// A syntax error is reported immediately (Node never runs the module and does not dispatch
    /// `uncaughtException` for it); a runtime error goes through the normal event path so an
    /// `uncaughtException` handler can absorb it.
    fn entry_error(&mut self, error: CaughtError) -> Option<RunOutcome> {
        if error.name == "SyntaxError" {
            let info = info_from_caught(&error);
            self.dispatcher
                .as_ref()
                .expect("dispatcher installed")
                .report_fatal(&info);
            return Some(self.finish(None));
        }

        let info = info_from_caught(&error);
        self.sched
            .run_macrotask("entry", Origin::Host, move |_| Err::<(), ErrorInfo>(info));
        if self.state.fatal.get() {
            return Some(self.finish(None));
        }
        None
    }

    fn settle(&mut self, value: Option<String>) -> Result<RunOutcome, Failure> {
        self.sync_host();
        self.checkpoint_all()?;
        if self.should_stop() {
            return Ok(self.finish(None));
        }

        self.run_loop()?;
        Ok(self.finish(value))
    }

    fn eval_cjs_entry(&mut self, path: &Path) -> Result<(), CaughtError> {
        let filename = path.display().to_string();
        self.engine.with_ctx(|ctx| {
            let result: js::Result<()> = (|| {
                let run: js::Function = ctx.globals().get("__ln_run_cjs")?;
                run.call::<_, ()>((filename,))
            })();
            js::CatchResultExt::catch(result, &ctx)
                .map_err(|error| ln_engine::caught_to_owned(&ctx, error))
        })
    }

    /// Print a resolution failure (`Cannot find module ...`) and return a failing outcome.
    fn report_resolution(&self, failure: &ln_modules::ResolveFailure) {
        let mut err = io::stderr().lock();
        let _ = writeln!(err, "lite: {}", failure.message);
        let _ = err.flush();
    }

    fn report_entry_error(&self, code: &str, message: &str) {
        let mut err = io::stderr().lock();
        let _ = writeln!(err, "lite: {code}: {message}");
        let _ = err.flush();
    }

    /// A failure that happened before any user code ran: exit 1, no `exit` listeners.
    fn finish_failure(&mut self) -> RunOutcome {
        self.exit.exit_code.set(1);
        self.finished = true;
        self.sched.shutdown();
        RunOutcome {
            value: None,
            exit_code: 1,
        }
    }

    /// `--check` success: exit 0 without running the loop or `exit` listeners.
    fn finish_check(&mut self) -> RunOutcome {
        self.finished = true;
        self.sched.shutdown();
        RunOutcome {
            value: None,
            exit_code: 0,
        }
    }

    /// The loop shell from ADR-0003: timers → completions → immediates → block, with a
    /// checkpoint after every callback.
    fn run_loop(&mut self) -> Result<(), Failure> {
        loop {
            if self.should_stop() {
                break;
            }
            self.refresh_memory();
            // Flush anything the previous callback left behind (including rejections created by
            // rejection event handlers) before deciding whether to block for a timer.
            self.checkpoint_all()?;
            if self.should_stop() {
                break;
            }

            let turn = self.driver.borrow_mut().next(Instant::now());
            match turn {
                Turn::Timer(id) => {
                    let fire = self.driver.borrow_mut().fire_timer(id, Instant::now());
                    if let Some(fire) = fire {
                        let engine = self.engine.clone();
                        let exit = self.exit.clone();
                        let bridge = self.bridge.clone();
                        self.sched
                            .run_macrotask("setTimeout", Origin::Timer, move |s| {
                                run_callback(
                                    &engine,
                                    &exit,
                                    &bridge,
                                    fire.payload,
                                    fire.id.0,
                                    KIND_TIMER,
                                    s,
                                )
                            });
                        self.checkpoint_all()?;
                    }
                }
                Turn::Immediate(id) => {
                    let payload = self.driver.borrow_mut().fire_immediate(id);
                    if let Some(payload) = payload {
                        let engine = self.engine.clone();
                        let exit = self.exit.clone();
                        let bridge = self.bridge.clone();
                        self.sched
                            .run_macrotask("setImmediate", Origin::Immediate, move |s| {
                                run_callback(
                                    &engine,
                                    &exit,
                                    &bridge,
                                    payload,
                                    id.0,
                                    KIND_IMMEDIATE,
                                    s,
                                )
                            });
                        self.checkpoint_all()?;
                    }
                }
                Turn::Completion(id) => {
                    // The slot is the payload: the channel only carries the id (ADR-0005 §2.3).
                    let Some(done) = self.ops.take(id) else {
                        // A duplicate or unknown completion must not release a second loop ref.
                        continue;
                    };
                    self.driver.borrow_mut().unref_external();
                    if self.should_stop() {
                        // process.exit/fatal: drop the parked result without invoking JS (O4).
                        continue;
                    }
                    let engine = self.engine.clone();
                    let exit = self.exit.clone();
                    let bridge = self.bridge.clone();
                    self.sched
                        .run_macrotask("completion", Origin::Completion, move |s| {
                            run_op_done(&engine, &exit, &bridge, done, s)
                        });
                    // The exception path (if any) was already routed to `uncaughtException` by
                    // the scheduler; this is the same single checkpoint other callbacks get.
                    self.checkpoint_all()?;
                }
                Turn::BeforeExit => {
                    let code = self.exit.exit_code.get();
                    let engine = self.engine.clone();
                    self.sched
                        .run_macrotask("beforeExit", Origin::Host, move |_| {
                            emit_before_exit(&engine, code)
                                .map_err(|caught| info_from_caught(&caught))
                        });
                    self.checkpoint_all()?;
                }
                Turn::Exit => break,
                Turn::Wait(timeout) => {
                    let completions = self.reactor.wait(timeout);
                    for completion in completions {
                        self.driver.borrow_mut().push_completion(completion);
                    }
                }
            }
        }
        Ok(())
    }

    fn should_stop(&self) -> bool {
        self.stop.get()
            || self.state.fatal.get()
            || self.state.budget.get().is_some()
            || self.exit.requested.get()
    }

    /// Run checkpoints until both microtask queues and the engine queue are empty. This is the
    /// only drive loop in the project; `Scheduler::checkpoint` does the draining.
    fn checkpoint_all(&mut self) -> Result<(), Failure> {
        let mut ran = false;
        loop {
            if self.should_stop() {
                self.sched.shutdown();
                return Ok(());
            }

            self.refresh_memory();
            self.sync_host();

            // Engine-created jobs are lower priority than nextTick but must be part of the
            // *same* checkpoint, otherwise a tick followed only by promise jobs would end the
            // checkpoint early and flush rejections before the promise jobs ran (C3).
            let (_, queued_micros) = self.sched.pending();
            if queued_micros == 0 && self.engine.is_job_pending() {
                self.seed_pump();
            }

            let (ticks, micros) = self.sched.pending();
            if ticks == 0
                && micros == 0
                && !self.engine.is_job_pending()
                && !self.sched.has_pending_rejections()
                && ran
            {
                break;
            }

            let deadline = self
                .sched
                .wall_budget()
                .map(|budget| Instant::now() + budget);
            self.engine.set_interrupt_deadline(deadline);
            let outcome = self.sched.checkpoint();
            self.engine.set_interrupt_deadline(None);
            ran = true;

            match outcome {
                Checkpoint::Drained { .. } | Checkpoint::Nested => {}
                Checkpoint::Stopped { .. } => break,
                Checkpoint::BudgetExceeded { jobs } => {
                    self.state.budget.set(Some(BudgetHit::Jobs(jobs)));
                    break;
                }
            }
        }
        Ok(())
    }

    fn seed_pump(&mut self) {
        let engine = self.engine.clone();
        let exit = self.exit.clone();
        let bridge = self.bridge.clone();
        let state = self.state.clone();
        let stop = self.stop.clone();
        self.sched.queue_microtask("engine job", move |s| {
            pump_job(&engine, &exit, &bridge, &state, &stop, s)
        });
    }

    fn sync_host(&mut self) {
        let bridge = self.bridge.clone();
        drain_bridge(&bridge, &mut self.sched, &self.engine, &self.exit);
    }

    fn finish(&mut self, value: Option<String>) -> RunOutcome {
        if self.finished {
            return RunOutcome {
                value: None,
                exit_code: self.exit.exit_code.get(),
            };
        }
        self.finished = true;

        self.report_budget();
        if self.state.budget.get().is_some() && !self.exit.requested.get() {
            self.exit.exit_code.set(1);
        }
        let code = self.exit.exit_code.get();
        if let Err(caught) = emit_exit(&self.engine, code) {
            // `process.exit` inside an `exit` listener unwinds with the private sentinel; that
            // is not a reportable error.
            if !self.exit.requested.get() {
                if let Some(dispatcher) = self.dispatcher.as_ref() {
                    dispatcher.report_exit_error(&caught);
                }
            }
        }
        let exit_code = self.exit.exit_code.get();

        self.sched.shutdown();
        // No completion may be delivered after shutdown (O4); release the refs of the parked
        // results the loop will never dispatch.
        let dropped = self.ops.discard_pending();
        for _ in 0..dropped {
            self.driver.borrow_mut().unref_external();
        }
        self.bridge.borrow_mut().ticks.clear();
        self.bridge.borrow_mut().rejections.clear();

        let suppress = self.exit.requested.get()
            || self.state.fatal.get()
            || self.state.budget.get().is_some();
        RunOutcome {
            value: if suppress { None } else { value },
            exit_code,
        }
    }

    fn report_budget(&self) {
        let Some(hit) = self.state.budget.get() else {
            return;
        };
        let mut err = io::stderr().lock();
        match hit {
            BudgetHit::Jobs(jobs) => {
                let _ = writeln!(
                    err,
                    "lite: microtask budget exhausted after {jobs} jobs; \
                     the script is probably in an infinite microtask loop"
                );
            }
            BudgetHit::Wall => {
                let _ = writeln!(
                    err,
                    "lite: microtask timeout exceeded; \
                     the script is probably in an infinite loop"
                );
            }
        }
        let _ = err.flush();
    }

    // --- introspection for tests ------------------------------------------------

    pub fn total_jobs(&self) -> u64 {
        self.sched.total_jobs()
    }

    pub fn checkpoints_run(&self) -> u64 {
        self.sched.checkpoints_run()
    }

    pub fn timer_count(&self) -> usize {
        self.driver.borrow().timer_count()
    }

    /// Async ops submitted but not yet dispatched.
    pub fn pending_ops(&self) -> usize {
        self.ops.pending()
    }

    pub fn exit_code(&self) -> i32 {
        self.exit.exit_code.get()
    }
}

/// One timer/immediate/tick/completion callback, followed by a bridge drain.
fn run_callback(
    engine: &Rc<Engine>,
    exit: &Rc<ExitState>,
    bridge: &Rc<RefCell<Bridge>>,
    callback: u64,
    handle: u64,
    kind: u8,
    sched: &mut Scheduler,
) -> Result<(), ErrorInfo> {
    if exit.requested.get() {
        return Ok(());
    }
    let outcome = dispatch_callback(engine, callback, handle, kind);
    drain_bridge(bridge, sched, engine, exit);
    match outcome {
        Ok(()) => Ok(()),
        Err(caught) => {
            // `process.exit` unwinds by throwing a private sentinel; it is not an error.
            if exit.requested.get() {
                Ok(())
            } else {
                Err(info_from_caught(&caught))
            }
        }
    }
}

/// One op completion, followed by the usual bridge drain and a single checkpoint (the caller
/// runs it). A throw from `__ln_op_done` — including a user callback — becomes an `ErrorInfo`,
/// which the scheduler reports through `uncaughtException`, exactly like any other callback.
fn run_op_done(
    engine: &Rc<Engine>,
    exit: &Rc<ExitState>,
    bridge: &Rc<RefCell<Bridge>>,
    done: ln_io::OpDone,
    sched: &mut Scheduler,
) -> Result<(), ErrorInfo> {
    if exit.requested.get() {
        return Ok(());
    }
    let outcome = dispatch_op_done(engine, &done);
    drain_bridge(bridge, sched, engine, exit);
    match outcome {
        Ok(()) => Ok(()),
        Err(caught) => {
            if exit.requested.get() {
                Ok(())
            } else {
                Err(info_from_caught(&caught))
            }
        }
    }
}

/// Build the error/value pair for one completion and hand it to `bootstrap.js`'s
/// `__ln_op_done`. Everything runs on the isolate thread; the payload itself never left Rust.
fn dispatch_op_done(engine: &Engine, done: &ln_io::OpDone) -> Result<(), CaughtError> {
    engine.with_ctx(|ctx| {
        let result: js::Result<()> = (|| {
            let id = ops::done_id(done);
            let undefined = js::Value::new_undefined(ctx.clone());
            let (error, value) = match done {
                ln_io::OpDone::Ok { value, .. } => {
                    (undefined.clone(), ops::op_value_to_js(&ctx, value)?)
                }
                ln_io::OpDone::Err { error, .. } => (
                    host_error::node_error_value(&ctx, error)?,
                    undefined.clone(),
                ),
                ln_io::OpDone::Aborted { .. } => {
                    let aborted = ln_error::NodeError::aborted();
                    (
                        host_error::node_error_value(&ctx, &aborted)?,
                        undefined.clone(),
                    )
                }
            };
            let callback: js::Function = ctx.globals().get("__ln_op_done")?;
            callback.call::<_, ()>((id, error, value))
        })();
        js::CatchResultExt::catch(result, &ctx)
            .map_err(|error| ln_engine::caught_to_owned(&ctx, error))
    })
}

/// One engine job, then re-arm if the engine still has work.
fn pump_job(
    engine: &Rc<Engine>,
    exit: &Rc<ExitState>,
    bridge: &Rc<RefCell<Bridge>>,
    state: &Rc<RuntimeState>,
    stop: &Rc<Cell<bool>>,
    sched: &mut Scheduler,
) -> Result<(), ErrorInfo> {
    if exit.requested.get() {
        return Ok(());
    }

    match engine.pump_one() {
        PumpOutcome::Executed => {
            drain_bridge(bridge, sched, engine, exit);
            if engine.is_job_pending() && !exit.requested.get() && !stop.get() {
                let engine = engine.clone();
                let exit = exit.clone();
                let bridge = bridge.clone();
                let state = state.clone();
                let stop = stop.clone();
                sched.queue_microtask("engine job", move |s| {
                    pump_job(&engine, &exit, &bridge, &state, &stop, s)
                });
            }
            Ok(())
        }
        PumpOutcome::Idle => {
            drain_bridge(bridge, sched, engine, exit);
            Ok(())
        }
        PumpOutcome::Threw(caught) => {
            if engine.take_interrupted() {
                state.budget.set(Some(BudgetHit::Wall));
                stop.set(true);
                return Ok(());
            }
            drain_bridge(bridge, sched, engine, exit);
            if exit.requested.get() {
                Ok(())
            } else {
                Err(info_from_caught(&caught))
            }
        }
    }
}

/// Move bridge state into the scheduler. Called after every JS call and before every checkpoint.
fn drain_bridge(
    bridge: &Rc<RefCell<Bridge>>,
    sched: &mut Scheduler,
    engine: &Rc<Engine>,
    exit: &Rc<ExitState>,
) {
    let ticks: Vec<u64> = {
        let mut bridge = bridge.borrow_mut();
        bridge.ticks.drain(..).collect()
    };
    for callback in ticks {
        let engine = engine.clone();
        let exit = exit.clone();
        let bridge = bridge.clone();
        sched.queue_tick("process.nextTick", move |s| {
            run_callback(&engine, &exit, &bridge, callback, u64::MAX, KIND_TICK, s)
        });
    }

    let rejections: Vec<RejectionEvent> = {
        let mut bridge = bridge.borrow_mut();
        bridge.rejections.drain(..).collect()
    };
    for event in rejections {
        match event {
            RejectionEvent::Reject { id, reason } => {
                sched.reject(PromiseKey(id), reason);
            }
            RejectionEvent::Handle { id } => {
                match sched.handle(PromiseKey(id)) {
                    HandleOutcome::Reported => {}
                    HandleOutcome::Candidate | HandleOutcome::Unknown => {
                        // No event will ever be emitted for this id; let the JS table forget it.
                        forget_rejection(engine, id);
                    }
                }
            }
        }
    }
}

// --- JS calls from Rust ---------------------------------------------------------------------

fn dispatch_callback(
    engine: &Engine,
    callback: u64,
    handle: u64,
    kind: u8,
) -> Result<(), CaughtError> {
    engine.with_ctx(|ctx| {
        let result: js::Result<()> = (|| {
            let dispatch: js::Function = ctx.globals().get("__ln_dispatch")?;
            dispatch.call::<_, ()>((callback, handle, kind))
        })();
        js::CatchResultExt::catch(result, &ctx)
            .map_err(|error| ln_engine::caught_to_owned(&ctx, error))
    })
}

fn emit_uncaught(engine: &Engine, info: &ErrorInfo) -> Result<bool, CaughtError> {
    engine.with_ctx(|ctx| {
        let result: js::Result<bool> = (|| {
            let make: js::Function = ctx.globals().get("__ln_make_error")?;
            let object: js::Object = make.call((
                info.name.clone(),
                info.message.clone(),
                info.stack.clone(),
                info.code.as_deref().map(ToOwned::to_owned),
            ))?;
            let emit: js::Function = ctx.globals().get("__ln_emit_uncaught")?;
            emit.call((object,))
        })();
        js::CatchResultExt::catch(result, &ctx)
            .map_err(|error| ln_engine::caught_to_owned(&ctx, error))
    })
}

fn emit_unhandled(engine: &Engine, id: u64) -> Result<(), CaughtError> {
    engine.with_ctx(|ctx| {
        let result: js::Result<()> = (|| {
            let emit: js::Function = ctx.globals().get("__ln_emit_unhandled")?;
            emit.call::<_, ()>((id,))
        })();
        js::CatchResultExt::catch(result, &ctx)
            .map_err(|error| ln_engine::caught_to_owned(&ctx, error))
    })
}

fn emit_rejection_handled(engine: &Engine, id: u64) -> Result<(), CaughtError> {
    engine.with_ctx(|ctx| {
        let result: js::Result<()> = (|| {
            let emit: js::Function = ctx.globals().get("__ln_emit_rejection_handled")?;
            emit.call::<_, ()>((id,))
        })();
        js::CatchResultExt::catch(result, &ctx)
            .map_err(|error| ln_engine::caught_to_owned(&ctx, error))
    })
}

fn emit_before_exit(engine: &Engine, code: i32) -> Result<(), CaughtError> {
    engine.with_ctx(|ctx| {
        let result: js::Result<()> = (|| {
            let emit: js::Function = ctx.globals().get("__ln_emit_before_exit")?;
            emit.call::<_, ()>((code,))
        })();
        js::CatchResultExt::catch(result, &ctx)
            .map_err(|error| ln_engine::caught_to_owned(&ctx, error))
    })
}

fn emit_exit(engine: &Engine, code: i32) -> Result<(), CaughtError> {
    engine.with_ctx(|ctx| {
        let result: js::Result<()> = (|| {
            let emit: js::Function = ctx.globals().get("__ln_emit_exit")?;
            emit.call::<_, ()>((code,))
        })();
        js::CatchResultExt::catch(result, &ctx)
            .map_err(|error| ln_engine::caught_to_owned(&ctx, error))
    })
}

fn forget_rejection(engine: &Engine, id: u64) {
    let _ = engine.with_ctx(|ctx| -> js::Result<()> {
        let forget: js::Function = ctx.globals().get("__ln_forget_rejection")?;
        forget.call::<_, ()>((id,))?;
        Ok(())
    });
}

// --- conversions and helpers ----------------------------------------------------------------

/// The line-1 column shift the CJS wrapper introduces.
fn cjs_column_offset(format: Format) -> usize {
    if format == Format::CommonJs {
        ln_engine::cjs_wrapper_column_offset()
    } else {
        0
    }
}

fn info_from_caught(caught: &CaughtError) -> ErrorInfo {
    ErrorInfo {
        name: caught.name.clone(),
        message: caught.message.clone(),
        stack: caught.stack.clone(),
        display: caught.display.clone(),
        is_error: caught.is_error,
        code: caught.code.clone(),
    }
}

fn caught_from_info(info: &ErrorInfo) -> CaughtError {
    CaughtError {
        name: info.name.clone(),
        message: info.message.clone(),
        stack: info.stack.clone(),
        display: info.display.clone(),
        is_error: info.is_error,
        code: info.code.clone(),
    }
}

fn engine_error(error: js::Error) -> Failure {
    Failure::Engine(error.to_string())
}

/// Node's `process.platform` names, not Rust's `std::env::consts::OS` names.
pub(crate) fn platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_budget_is_unbounded_like_node() {
        assert_eq!(
            Config::new(vec!["lite".to_owned()]).budget,
            Budget::UNBOUNDED
        );
    }

    #[test]
    fn caught_errors_round_trip_through_error_info() {
        let caught = CaughtError {
            name: "TypeError".to_owned(),
            message: "bad".to_owned(),
            stack: Some("    at <eval> (a.js:1:1)".to_owned()),
            display: "TypeError: bad".to_owned(),
            is_error: true,
            code: None,
        };
        let info = info_from_caught(&caught);
        assert_eq!(info.body(), "TypeError: bad\n    at <eval> (a.js:1:1)");
        assert_eq!(caught_from_info(&info), caught);
    }

    #[test]
    fn platform_uses_node_names() {
        let platform = platform();
        assert!(
            ["darwin", "linux", "win32"].contains(&platform) || !platform.is_empty(),
            "{platform}"
        );
    }

    // --- M3 op bridge -----------------------------------------------------------------------

    /// A file that exists no matter which directory the test binary runs in.
    fn manifest_literal() -> String {
        serde_json::to_string(&format!("{}/Cargo.toml", env!("CARGO_MANIFEST_DIR")))
            .expect("json string")
    }

    fn run_eval(source: &str) -> RunOutcome {
        let mut isolate = Isolate::new(Config::new(vec!["lite".to_owned()])).expect("isolate");
        isolate.run(source, "[eval]").expect("run")
    }

    #[test]
    fn sync_host_ops_return_uint8_arrays_with_negative_errno() {
        let source = r#"const value = __ln_host.fsSync("readFile", [__PATH__]);
if (!(value instanceof Uint8Array) || value.length === 0) throw new Error("bad readFile");
try {
  __ln_host.fsSync("readFile", ["/lite-node/definitely-missing"]);
  process.exit(20);
} catch (error) {
  const shaped =
    error.code === "ENOENT" &&
    error.errno === -2 &&
    error.syscall === "open" &&
    error.path === "/lite-node/definitely-missing";
  process.exit(shaped ? 21 : 22);
}"#
        .replace("__PATH__", &manifest_literal());
        assert_eq!(run_eval(&source).exit_code, 21);
    }

    #[test]
    fn async_op_completes_on_the_loop_and_releases_its_ref() {
        let source = r#"__ln_op("readFile", [__PATH__]).then(
  (value) => process.exit(value.length > 0 ? 31 : 32),
  () => process.exit(33),
);"#
        .replace("__PATH__", &manifest_literal());
        let mut isolate = Isolate::new(Config::new(vec!["lite".to_owned()])).expect("isolate");
        let outcome = isolate.run(&source, "[eval]").expect("run");
        assert_eq!(outcome.exit_code, 31);
        // O3: the ref was released when the completion slot was taken.
        assert_eq!(isolate.pending_ops(), 0);
    }

    #[test]
    fn async_op_errors_are_shaped_like_node() {
        let source = r#"__ln_op("readFile", ["/lite-node/definitely-missing"]).then(
  () => process.exit(40),
  (error) => process.exit(
    error.code === "ENOENT" && error.errno === -2 ? 41 : 42,
  ),
);"#;
        assert_eq!(run_eval(source).exit_code, 41);
    }

    #[test]
    fn a_throwing_op_callback_goes_to_uncaught_exception() {
        let source = r#"process.on("uncaughtException", (error) => {
  process.exit(error.message === "boom" ? 51 : 52);
});
__ln_op("readFile", [__PATH__], {
  callback() {
    throw new Error("boom");
  },
});"#
            .replace("__PATH__", &manifest_literal());
        assert_eq!(run_eval(&source).exit_code, 51);
    }

    #[test]
    fn an_abort_that_races_the_completion_still_settles_with_abort_error() {
        let source = r#"const controller = new AbortController();
const pending = __ln_op("readFile", [__PATH__], { signal: controller.signal });
controller.abort();
pending.then(
  () => process.exit(60),
  (error) =>
    process.exit(error.name === "AbortError" && error.code === "ABORT_ERR" ? 61 : 62),
);"#
        .replace("__PATH__", &manifest_literal());
        assert_eq!(run_eval(&source).exit_code, 61);
    }
}
