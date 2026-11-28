//! Isolate bootstrap and the M1 event loop for onde.
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
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Instant;

pub use ln_engine::js;
pub use ln_engine::{CaughtError, Completion, Engine, PumpOutcome};
use ln_modules::Format;
use ln_perm::Policy;
pub use ln_sched::Budget;
use ln_sched::{
    ChannelReactor, Checkpoint, CompletionSender, Driver, ErrorInfo, Event, HandleOutcome, Origin,
    PromiseKey, Reactor, Scheduler, SinkMailbox, Turn,
};

mod args;
mod async_hooks;
mod bootstrap;
#[cfg(feature = "node-net")]
mod handles;
mod host;
#[cfg(feature = "node-crypto")]
mod host_crypto;
mod host_error;
mod modules;
pub mod ops;
mod proc;
mod report;
mod signals;
mod trace;
mod workers;
pub use report::render_uncaught;

use async_hooks::AsyncTracker;
#[cfg(feature = "node-net")]
use handles::HandleBridge;
use host::HostState;
use modules::ModuleRuntime;
use ops::OpBridge;
use proc::{IpcBridge, ProcBridge};
use trace::Diagnostics;

use signals::SignalBridge;
pub use trace::{DiagnosticsConfig, FfiTrace};

/// Callback kinds understood by `bootstrap.js`'s `__ln_dispatch`.
const KIND_TIMER: u8 = 0;
const KIND_IMMEDIATE: u8 = 1;
const KIND_TICK: u8 = 2;

/// The fields a worker inherits from its parent (ADR-0011 §5.8).
///
/// They live in one struct so `Config::child_of` copies them with one `clone`: a field added here is
/// inherited by construction, and a field outside it is per-isolate by construction. A field-by-field
/// copy plus a test cannot see a new field.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Inheritable {
    /// Bounds on one checkpoint. Defaults to unbounded (Node has no equivalent); the CLI wires
    /// `--max-microtasks` and `--microtask-timeout` into this.
    pub budget: Budget,
    /// Blocking pool size for async ops (`--io-threads`). The pool is created on the first
    /// async op, never at boot.
    pub io_threads: usize,
    /// Hard cap on the engine heap, in bytes (`--max-old-space-size`).
    pub max_old_space_size: Option<u64>,
    /// The opt-in permission policy (ADR-0011). `None` is the default: every check is skipped.
    /// `Some(Policy::deny_all())` is `--permission` with no grants.
    pub permissions: Option<Policy>,
    /// The FFI trace level (`--trace-ffi`), so a worker's boundary events reach the same stderr.
    pub trace_ffi: FfiTrace,
}

/// Isolate configuration.
#[derive(Debug, Clone)]
pub struct Config {
    /// Values exposed as `process.argv`. `argv[0]` is the program name, as in Node.
    pub argv: Vec<String>,
    /// What a worker inherits from this config; see [`Config::child_of`].
    pub inheritable: Inheritable,
    /// Expose a CommonJS `require` bound to the working directory as a global. Node's `-e`
    /// does this; a file entry point gets `require` through the module wrapper instead.
    pub expose_require: bool,
    /// Append async ancestry to every Error stack (`--async-stack-traces`). Off by default:
    /// recording a creation site per promise is measurable, and M6 ships it opt-in.
    pub async_stack_traces: bool,
    /// The payload this process was linked with, for a compiled app.
    ///
    /// `None` is a normal runtime: modules come from the disk. `Some` is compiled mode: every
    /// module comes from the payload, the disk is never consulted, and `argv[1]` is the executable
    /// because there is no script path.
    pub payload: Option<PayloadBytes>,
    /// Diagnostics: what `--trace-events`, `--timing` and `--trace-gc` asked for.
    ///
    /// Kept as the raw request so the runtime decides when the file is opened and flushed; see
    /// [`DiagnosticsConfig`] and m7-plan §3.4.
    pub diagnostics: DiagnosticsConfig,
    /// Test files discovered by `onde --test`.
    ///
    /// `None` runs a script; `Some` makes [`Isolate::run_tests`] the entry point. Discovery lives
    /// in `ln-cli` (it is argument parsing, m7-plan §4.6), and the runtime only hands this list to
    /// the JavaScript runner in `js/lib/test.js`.
    pub test_files: Option<Vec<String>>,
}

/// The payload bytes a compiled app was linked with.
///
/// It must outlive the isolate (QuickJS reads module bytecode in place), which is why it is
/// `'static`: a linked `const` array or a leaked mapping. `Debug` prints the length, not the
/// bytes.
#[derive(Clone, Copy)]
pub struct PayloadBytes(pub &'static [u8]);

impl std::fmt::Debug for PayloadBytes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "PayloadBytes({} bytes)", self.0.len())
    }
}

impl Config {
    pub fn new(argv: Vec<String>) -> Self {
        Config {
            argv,
            inheritable: Inheritable::default(),
            expose_require: false,
            async_stack_traces: false,
            payload: None,
            diagnostics: DiagnosticsConfig::default(),
            test_files: None,
        }
    }

    /// The config for a worker or other child isolate: the inheritable set from `self`, the
    /// per-isolate defaults from `Config::new`, and the caller's `argv`.
    pub fn child_of(&self, argv: Vec<String>) -> Config {
        self.inheritable.clone().into_config(argv)
    }
}

impl Inheritable {
    /// A fresh per-isolate `Config` with this inheritable set. Used by `Config::child_of` and by
    /// the worker bridge, which stores the set rather than a whole parent config.
    pub fn into_config(self, argv: Vec<String>) -> Config {
        let mut config = Config::new(argv);
        config.diagnostics.trace_ffi = self.trace_ffi;
        config.inheritable = self;
        config
    }
}

/// Whether an isolate is the process entry point or a worker (ADR-0008 §2.1).
pub(crate) enum Role {
    Main,
    Worker(WorkerRole),
}

/// What a worker isolate needs from its parent beyond a normal [`Config`].
///
/// The parent mints the handle id and owns the sink, so every event the worker emits (message,
/// error, exit) goes through [`WorkerSink`] into the parent's parked table. `worker_data` is
/// consumed during host installation, on the worker thread.
pub(crate) struct WorkerRole {
    pub(crate) handle: u64,
    pub(crate) thread_id: u32,
    pub(crate) entry: WorkerEntry,
    pub(crate) worker_data: RefCell<Option<ln_engine::Serialized>>,
    pub(crate) inbound:
        std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<ln_engine::Serialized>>>,
    pub(crate) cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    pub(crate) sink: workers::WorkerSink,
    /// True while this worker's own loop ref is held by `parentPort` (Node's port refcount).
    pub(crate) self_ref: Cell<bool>,
}

/// How a worker was started: a file (resolved like any entry point) or evaluated source.
#[derive(Debug, Clone)]
pub(crate) enum WorkerEntry {
    File(PathBuf),
    Eval(String),
}

/// Why the isolate could not be created or could not evaluate the bootstrap.
///
/// User-level failures (uncaught errors, unhandled rejections, budget exhaustion) are not
/// returned here: they are reported where they happen, Node-style, and the run completes with
/// an exit code.
#[derive(Debug)]
pub enum Failure {
    /// The engine could not be created, or the bootstrap script failed. An onde bug.
    Engine(String),
    /// The payload is not one this runtime can read (corrupt, truncated, unknown format).
    Payload(String),
    /// The payload was built for a different engine: its bytecode must not be read.
    ///
    /// This is the one failure with its own exit code (78, `EX_CONFIG`): the app is fine, the
    /// runtime is fine, and the two were simply not built together.
    AbiMismatch(String),
}

impl Failure {
    /// The exit code for a failure that happened outside user code.
    ///
    /// 1 is "this process could not run the program"; 78 (`EX_CONFIG`) is reserved for the
    /// payload/runtime engine mismatch, so a build system can tell "rebuild the app" apart from
    /// "the app is broken".
    pub fn exit_code(&self) -> i32 {
        match self {
            Failure::Engine(_) | Failure::Payload(_) => 1,
            Failure::AbiMismatch(_) => 78,
        }
    }
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failure::Engine(message) => write!(f, "engine failure: {message}"),
            Failure::Payload(message) => write!(f, "bad payload: {message}"),
            Failure::AbiMismatch(message) => write!(
                f,
                "this app was built for a different version of onde ({message}); rebuild it with \
                 the ondec that matches this runtime"
            ),
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
    /// The error that made the run fatal, kept so a worker can report it to its parent.
    pub(crate) fatal_error: RefCell<Option<ErrorInfo>>,
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
    /// async_hooks ids, so a handler that throws or pumps can enter the right context.
    async_hooks: Rc<AsyncTracker>,
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
        if !self.engine.has_jobs() {
            return;
        }
        let engine = self.engine.clone();
        let exit = self.exit.clone();
        let bridge = self.bridge.clone();
        let state = self.state.clone();
        let stop = self.stop.clone();
        let hooks = self.async_hooks.clone();
        self.mailbox
            .push(Origin::Microtask, "engine job", move |s| {
                pump_job(&engine, &exit, &bridge, &state, &stop, &hooks, s)
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
        self.state.fatal_error.replace(Some(info.clone()));
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
    /// The policy every gate asks (ADR-0011). Cloned into the pool and host state.
    permit: ln_io::Permit,
    /// The handle bridge: network tasks, parked events and loop refs (ADR-0006). Only the
    /// `node-net` feature compiles it; without sockets there is nothing to own.
    #[cfg(feature = "node-net")]
    handles: Rc<HandleBridge>,
    /// The worker bridge: worker threads, parked events and loop refs (ADR-0008).
    workers: Rc<workers::WorkerBridge>,
    /// Signal delivery: process-wide, created on the first listener (M5).
    signals: Rc<SignalBridge>,
    /// Child processes: spawned processes and their pipes (M5).
    procs: Rc<ProcBridge>,
    /// SQLite connections, statements and backups (`node:sqlite`).
    #[cfg(feature = "node-sqlite")]
    sqlite: Rc<host::sqlite::SqliteState>,
    /// `onde:ffi` libraries, closures and the type registry.
    #[cfg(feature = "ffi")]
    ffi: Rc<host::ffi::FfiState>,
    /// async_hooks ids and the execution context (M6).
    async_hooks: Rc<AsyncTracker>,
    /// The forked child's IPC channel, if this process has one.
    ipc: Rc<IpcBridge>,
    /// The descriptor the parent passed (`ONDE_IPC_FD`), if any.
    ipc_fd: Option<i32>,
    /// `Some` when this isolate is a worker.
    worker: Option<Rc<WorkerRole>>,
    start: Instant,
    /// Last engine heap measurement. `Runtime::memory_usage` re-borrows the runtime and panics
    /// while a JS callback is on the stack, so it is sampled at the top of a turn — and only when
    /// a `process.memoryUsage()` call asked for it. Sampling it every turn (as M0—M3 did) cost
    /// ~25x network throughput: it walks the entire heap.
    memory: Rc<Cell<usize>>,
    /// Set by the `memoryUsage` host call, cleared when the sample is taken.
    memory_requested: Rc<Cell<bool>>,
    /// Files `onde --test` discovered; `Some` means this isolate is a test runner, not a script
    /// host (see [`Config::test_files`]).
    test_files: Option<Vec<String>>,
    /// `--trace-events`, `--timing` and `--trace-gc`; `None` unless one was asked for.
    diagnostics: Option<Diagnostics>,
    finished: bool,
}

impl Isolate {
    pub fn new(config: Config) -> Result<Self, Failure> {
        let (reactor, sender) = ChannelReactor::new();
        Self::with_channel(config, reactor, sender, Role::Main)
    }

    /// Build an isolate on an externally created completion channel.
    ///
    /// Worker threads use this: the parent creates the channel, keeps the sender to wake the
    /// worker, and hands the reactor and a sender clone to the thread that builds the isolate
    /// (ADR-0008 §2.2). The main isolate keeps the simpler [`Isolate::new`].
    pub(crate) fn with_channel(
        config: Config,
        reactor: ChannelReactor,
        sender: CompletionSender,
        role: Role,
    ) -> Result<Self, Failure> {
        let role = match role {
            Role::Main => None,
            Role::Worker(worker) => Some(worker),
        };
        let cancel = role.as_ref().map(|worker| worker.cancel.clone());
        let engine = Rc::new(
            match cancel {
                Some(cancel) => Engine::new_with_cancel(cancel),
                None => Engine::new(),
            }
            .map_err(|e| Failure::Engine(e.to_string()))?,
        );
        // The limit applies to this runtime before the bootstrap, so a bootstrap that allocates
        // past it fails at boot rather than an hour later (m7-plan §4.4).
        if let Some(limit) = config.inheritable.max_old_space_size {
            engine.set_memory_limit(limit);
        }
        let mut sched = Scheduler::new();
        sched.set_budget(config.inheritable.budget);

        let driver = Rc::new(RefCell::new(Driver::new()));
        let bridge = Rc::new(RefCell::new(Bridge::default()));
        let exit = Rc::new(ExitState::default());
        let state = Rc::new(RuntimeState::default());
        let stop = sched.stop_handle();
        // One permit per isolate. `None` stays one branch on the gated paths; it never becomes a
        // second policy value.
        let permit = match config.inheritable.permissions.clone() {
            Some(policy) => ln_io::Permit::new(policy),
            None => ln_io::Permit::unconfined(),
        };
        let modules = ModuleRuntime::new(
            std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            permit.clone(),
        );
        // Compiled mode is decided here, before any module can load: the loader reads this flag
        // on every resolution, and a payload that fails the engine check must stop the process
        // before the bootstrap (or anything else) can ask for a module.
        if let Some(payload) = config.payload {
            modules
                .set_payload(payload.0)
                .map_err(|failure| match failure {
                    modules::PayloadFailure::Abi(message) => Failure::AbiMismatch(message),
                    modules::PayloadFailure::Corrupt(message) => Failure::Payload(message),
                })?;
        }
        modules.install(&engine);
        let memory = Rc::new(Cell::new(0));
        let memory_requested = Rc::new(Cell::new(false));
        // One id sequence for the whole isolate: ops, handles and workers draw from it.
        let ids = Arc::new(ops::RequestIdAllocator::new());
        let ops = Rc::new(OpBridge::new(
            driver.clone(),
            sender.clone(),
            config.inheritable.io_threads,
            ids.clone(),
            permit.clone(),
        ));
        #[cfg(feature = "node-net")]
        let handles = Rc::new(HandleBridge::new(
            driver.clone(),
            sender.clone(),
            ops.clone(),
        ));
        let signals = Rc::new(signals::SignalBridge::new(
            driver.clone(),
            sender.clone(),
            ops.clone(),
        ));
        let procs = Rc::new(ProcBridge::new(
            driver.clone(),
            sender.clone(),
            ids.clone(),
            ops.clone(),
        ));
        let ipc = Rc::new(IpcBridge::new(driver.clone(), sender.clone(), ops.clone()));
        // Only the main isolate of a forked child owns fd 3. A worker shares the process's
        // environment but must not attach the parent's channel.
        let ipc_fd = if role.is_some() {
            None
        } else {
            std::env::var("ONDE_IPC_FD")
                .ok()
                .and_then(|value| value.trim().parse::<i32>().ok())
                .filter(|fd| *fd > 0)
        };
        // The descriptors every isolate owns before any script runs (ADR-0011 §5.6). A worker has
        // no IPC fd; a forked child's is the channel it was given.
        permit.seed_fd(0, ln_io::FdMode::READ);
        permit.seed_fd(1, ln_io::FdMode::WRITE);
        permit.seed_fd(2, ln_io::FdMode::WRITE);
        if let Some(fd) = ipc_fd {
            permit.seed_fd(fd, ln_io::FdMode::READ_WRITE);
        }
        #[cfg(feature = "node-sqlite")]
        let sqlite = Rc::new(host::sqlite::SqliteState::new());
        #[cfg(feature = "ffi")]
        let ffi = host::ffi::FfiState::new(config.diagnostics.trace_ffi.or_env());
        let async_hooks = AsyncTracker::new();
        // A worker gets no diagnostics of its own: one trace file per process is the contract, and
        // a worker's turns would need a lane in the main isolate's file (m7-plan §3.4).
        let diagnostics = match role {
            Some(_) => None,
            None => Diagnostics::new(&config.diagnostics)
                .map_err(|error| Failure::Engine(format!("diagnostics: {error}")))?,
        };
        let workers = Rc::new(workers::WorkerBridge::new(
            driver.clone(),
            sender,
            ids.clone(),
            config.argv.clone(),
            config.inheritable.clone(),
        ));
        let worker = role.map(Rc::new);

        let mut isolate = Isolate {
            engine,
            sched,
            driver,
            bridge,
            exit,
            state,
            stop,
            // The completion channel is the only wakeup the loop knows about; the op, handle and
            // worker sinks all send through it.
            reactor: Box::new(reactor),
            dispatcher: None,
            modules,
            ops,
            permit: permit.clone(),
            #[cfg(feature = "node-net")]
            handles,
            workers,
            signals,
            procs,
            #[cfg(feature = "node-sqlite")]
            sqlite,
            #[cfg(feature = "ffi")]
            ffi,
            async_hooks,
            ipc,
            ipc_fd,
            worker,
            start: Instant::now(),
            memory,
            memory_requested,
            test_files: config.test_files.clone(),
            diagnostics,
            finished: false,
        };
        // `--async-stack-traces` needs ids even when the program never loads `async_hooks`, and
        // the host object tells the stdlib whether to start minting them from the first callback.
        if config.async_stack_traces {
            isolate.async_hooks.start();
        }
        isolate.install(&config)?;
        // Baseline for --trace-gc before the entry point allocates anything: without it the first
        // sample *is* the baseline, and a collection during the entry script produces no event
        // (the heap never appears to fall, it was never recorded higher).
        if let Some(diagnostics) = &mut isolate.diagnostics {
            if diagnostics.wants_heap() {
                diagnostics.sample_heap(isolate.engine.heap_statistics().malloc_size);
            }
        }
        isolate.install_tracker();
        isolate.install_async_hooks(config.async_stack_traces);
        Ok(isolate)
    }

    /// Replace the reactor. Tests use a scripted reactor; real I/O arrives in M3.
    pub fn set_reactor(&mut self, reactor: Box<dyn Reactor>) {
        self.reactor = reactor;
    }

    fn install(&self, config: &Config) -> Result<(), Failure> {
        let host_state = HostState {
            engine: self.engine.clone(),
            driver: self.driver.clone(),
            bridge: self.bridge.clone(),
            exit: self.exit.clone(),
            stop: self.stop.clone(),
            start: self.start,
            modules: self.modules.clone(),
            workers: self.workers.clone(),
            signals: self.signals.clone(),
            procs: self.procs.clone(),
            ipc: self.ipc.clone(),
            ipc_fd: self.ipc_fd,
            worker: self.worker.clone(),
            memory: self.memory.clone(),
            memory_requested: self.memory_requested.clone(),
            ops: self.ops.clone(),
            permit: self.permit.clone(),
            ids: self.ops.ids().clone(),
            #[cfg(feature = "node-net")]
            handles: self.handles.clone(),
            #[cfg(feature = "node-sqlite")]
            sqlite: self.sqlite.clone(),
            #[cfg(feature = "ffi")]
            ffi: self.ffi.clone(),
            async_hooks: self.async_hooks.clone(),
            async_forced: self.async_hooks.is_started(),
        };

        self.engine
            .with_ctx(|ctx| host::install(&ctx, &host_state, &config.argv).map_err(engine_error))?;

        // Source in debug builds, the build-time snapshot in release (m7-plan §4.3).
        match bootstrap::install(&self.engine) {
            Ok(()) => {}
            // A failing bootstrap is a bug in onde; surface it as an engine failure so the
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

    /// Turn on async stack traces (`--async-stack-traces`), if the flag was passed.
    ///
    /// The engine hooks that mint ids are installed later, by `host.asyncStart`, the first time
    /// JavaScript loads `node:async_hooks` (see `async_hooks::start_tracking`). Until then the
    /// runtime does no async bookkeeping at all, which is what keeps a program that never asks
    /// for `async_hooks` at the pre-M6 cost per callback. The stack hook is installed here
    /// because it only runs while an `Error` is built and is inert until ids exist.
    fn install_async_hooks(&self, async_stack_traces: bool) {
        crate::async_hooks::install_engine_hooks(&self.engine, &self.async_hooks);
        if async_stack_traces {
            self.async_hooks.set_async_stacks(true);
            let frames = self.async_hooks.clone();
            self.engine
                .set_async_stack_hook(move || frames.render_async_frames());
        }
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
                        "Cannot load native addon {}: onde does not support N-API modules",
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

    /// Run the payload this process was linked with (compiled mode).
    ///
    /// The payload was negotiated in [`Isolate::new`], so a bad one never reaches this point.
    /// `begin` is told the module *key*, not a path: that is what `import.meta.filename`, stack
    /// traces and error excerpts show, and it is the only name a compiled app has.
    pub fn run_payload(&mut self) -> Result<RunOutcome, Failure> {
        let Some(payload) = self.modules.payload() else {
            return Err(Failure::Engine(
                "run_payload() on an isolate with no payload".to_owned(),
            ));
        };

        let entry = payload.payload.entry();
        let key = entry.key.to_owned();
        let name = format!("file:///{key}");
        let dirname = ln_payload::dirname(&key).to_owned();
        let kind = entry.kind;
        let body = entry.body;

        self.begin(&key, "", 0);

        let evaluated = match kind {
            ln_payload::Kind::Bytecode => {
                self.engine
                    .eval_module_bytecode(body, &name, Some(&key), Some(&dirname), true)
            }
            ln_payload::Kind::Source => match std::str::from_utf8(body) {
                Ok(source) => {
                    self.engine
                        .eval_module(source, &name, Some(&key), Some(&dirname), true)
                }
                Err(_) => {
                    self.report_entry_error(
                        "ERR_INVALID_MODULE_SPECIFIER",
                        &format!("payload module {key:?} is not UTF-8"),
                    );
                    return Ok(self.finish_failure());
                }
            },
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

    /// Run the `node:test` files discovered by the CLI (`onde --test`).
    ///
    /// The runner is JavaScript (`js/lib/test.js`): hooks, the promise/`done` duality, plan
    /// accounting and timeouts are test semantics, not flag plumbing. Rust hands it the paths and
    /// then drives the same loop a script entry uses. The runner prints the spec transcript and
    /// ends by setting `process.exitCode`, which [`Isolate::finish`] already turns into the
    /// process status.
    pub fn run_tests(&mut self) -> Result<RunOutcome, Failure> {
        let files: Vec<String> = self.test_files.clone().unwrap_or_default();

        // The dispatcher needs a name for errors that escape a test (an uncaught throw in a timer,
        // for example); no source means no excerpt, which is correct for a runner.
        self.begin("<test>", "", 0);

        let invoked = self.engine.with_ctx(|ctx| -> js::Result<()> {
            // `__ln_builtin_exports` is bootstrap's builtin accessor; loading `node:test` here is
            // the same module a test file gets when it requires it, so registration state is one.
            let builtin: js::Function = ctx.globals().get("__ln_builtin_exports")?;
            let runner: js::Object = builtin.call(("node:test",))?;
            let run: js::Function = runner.get("_run")?;
            let paths = js::Array::new(ctx.clone())?;
            for (index, file) in files.iter().enumerate() {
                paths.set(index, file.as_str())?;
            }
            // `_run` is async: the returned promise is the run, and `settle` below pumps the
            // microtasks and timers it waits on.
            let _: js::Value = run.call((paths,))?;
            Ok(())
        });
        if let Err(error) = invoked {
            return Err(Failure::Engine(format!(
                "test runner failed to start: {error}"
            )));
        }
        if self.exit.requested.get() {
            return Ok(self.finish(None));
        }

        self.settle(None)
    }

    /// `onde --check`: compile the entry without running it.
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
        // Entry source is `Source`-class: the interpreter must load code, so `fs.read` does not
        // gate it. Routing through `read_class` is what keeps the runtime to one read site
        // outside an `Op` (ADR-0011 §5.4.1).
        match modules::read_class(path, modules::Class::Source, self.modules.permit()) {
            Ok(source) => Some(source),
            Err(error) => {
                self.report_entry_error(error.code, &error.message);
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
            async_hooks: self.async_hooks.clone(),
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
        if self.engine.is_cancelled() {
            // `terminate()` during the entry evaluation is a cancellation, not a user error.
            self.exit.exit_code.set(1);
            return Some(self.finish(None));
        }
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
        let _ = writeln!(err, "onde: {}", failure.message);
        let _ = err.flush();
    }

    fn report_entry_error(&self, code: &str, message: &str) {
        let mut err = io::stderr().lock();
        let _ = writeln!(err, "onde: {code}: {message}");
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
            if self.memory_requested.get() {
                self.memory.set(self.engine.memory_usage());
                self.memory_requested.set(false);
            }
            // Flush anything the previous callback left behind (including rejections created by
            // rejection event handlers) before deciding whether to block for a timer.
            self.checkpoint_all()?;
            if self.should_stop() {
                break;
            }

            if let Some(diagnostics) = &mut self.diagnostics {
                if diagnostics.wants_heap() {
                    // The allocator's view, not the accounted-object one: `memory_used_size` omits
                    // fast-array storage, so a 40 MB array of numbers barely moves it. This is the
                    // same walk m4-plan §8.4 removed from the loop, so it only runs under
                    // --trace-gc.
                    diagnostics.sample_heap(self.engine.heap_statistics().malloc_size);
                }
            }
            let turn_started = Instant::now();
            let turn = self.driver.borrow_mut().next(Instant::now());
            // Named before the match moves the turn; the vocabulary is `ln_sched::Turn`'s.
            let phase = match &turn {
                Turn::Timer(_) => "timer",
                Turn::Immediate(_) => "immediate",
                Turn::Completion(_) => "completion",
                Turn::BeforeExit => "beforeExit",
                Turn::Exit => "exit",
                Turn::Wait(_) => "wait",
            };
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
                    self.handle_completion(id)?;
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
                Turn::Exit => {
                    // Recorded before the break so the trace's last event is the exit turn; the
                    // timing line after the match never runs for it.
                    if let Some(diagnostics) = &mut self.diagnostics {
                        diagnostics.turn("exit", turn_started.elapsed());
                    }
                    break;
                }
                Turn::Wait(timeout) => {
                    let completions = self.reactor.wait(timeout);
                    for completion in completions {
                        self.driver.borrow_mut().push_completion(completion);
                    }
                }
            }
            if let Some(diagnostics) = &mut self.diagnostics {
                diagnostics.turn(phase, turn_started.elapsed());
            }
        }
        Ok(())
    }

    /// Route one completion id to the family that owns it (ADR-0006 §2.1 extended by ADR-0008).
    ///
    /// The order is load-bearing: reserved ids first, then ops, network handles, processes and
    /// workers. Every table draws from the one allocator, so an id can only match one family.
    fn handle_completion(&mut self, id: u64) -> Result<(), Failure> {
        // The forked child's IPC channel has one reserved id.
        if id == proc::IPC_COMPLETION_ID {
            let events = self.ipc.take();
            self.ipc.observe(&events);
            if !events.is_empty() && !self.should_stop() {
                let engine = self.engine.clone();
                self.sched
                    .run_macrotask("ipc", Origin::Completion, move |_| {
                        proc::dispatch_ipc_events(&engine, events)
                            .map_err(|caught| info_from_caught(&caught))
                    });
                self.checkpoint_all()?;
            }
            return Ok(());
        }

        // Signals have one reserved id: process-wide, no per-handle table.
        if id == signals::SIGNAL_COMPLETION_ID {
            let numbers = self.signals.take();
            if !numbers.is_empty() && !self.should_stop() {
                let engine = self.engine.clone();
                self.sched.run_macrotask("signal", Origin::Host, move |_| {
                    run_signal_events(&engine, numbers).map_err(|caught| info_from_caught(&caught))
                });
                self.checkpoint_all()?;
            }
            return Ok(());
        }

        // A worker's own id means "the parent sent me messages": drain and reconstruct them here,
        // on the worker's isolate thread (H1′).
        if let Some(worker) = self.worker.clone() {
            if id == worker.handle {
                let messages: Vec<ln_engine::Serialized> = {
                    let mut queue = worker
                        .inbound
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    queue.drain(..).collect()
                };
                if !messages.is_empty() && !self.should_stop() {
                    let engine = self.engine.clone();
                    self.sched
                        .run_macrotask("worker message", Origin::Completion, move |_| {
                            run_parent_messages(&engine, messages)
                                .map_err(|caught| info_from_caught(&caught))
                        });
                    self.checkpoint_all()?;
                }
                return Ok(());
            }
        }

        if let Some(done) = self.ops.take(id) {
            let op_started = self.ops.take_start(id);
            self.driver.borrow_mut().unref_external();
            if self.should_stop() {
                // process.exit/fatal: drop the parked result without invoking JS (O4).
                return Ok(());
            }
            let engine = self.engine.clone();
            let exit = self.exit.clone();
            let bridge = self.bridge.clone();
            self.sched
                .run_macrotask("completion", Origin::Completion, move |s| {
                    run_op_done(&engine, &exit, &bridge, done, s)
                });
            self.checkpoint_all()?;
            if let (Some((name, started)), Some(diagnostics)) = (op_started, &mut self.diagnostics)
            {
                diagnostics.op(name, started.elapsed());
            }
            return Ok(());
        }

        #[cfg(feature = "node-net")]
        if let Some(events) = self.handles.take(id) {
            // Bookkeeping happens before JS runs: a `closed` event releases the handle's ref here,
            // and an accepted connection becomes addressable before its `connection` handler can
            // issue `read`.
            for event in &events {
                self.handles.observe_event(id, event);
            }
            if self.should_stop() {
                return Ok(());
            }
            let engine = self.engine.clone();
            let exit = self.exit.clone();
            let bridge = self.bridge.clone();
            self.sched
                .run_macrotask("handle", Origin::Completion, move |s| {
                    run_handle_events(&engine, &exit, &bridge, id, events, s)
                });
            self.checkpoint_all()?;
            return Ok(());
        }

        if let Some(events) = self.procs.take(id) {
            self.procs.observe(id, &events);
            if self.should_stop() {
                return Ok(());
            }
            let engine = self.engine.clone();
            self.sched
                .run_macrotask("process", Origin::Completion, move |_| {
                    proc::dispatch_proc_events(&engine, id, events)
                        .map_err(|caught| info_from_caught(&caught))
                });
            self.checkpoint_all()?;
            return Ok(());
        }

        if let Some(events) = self.workers.take(id) {
            self.workers.observe(id, &events);
            if self.should_stop() {
                return Ok(());
            }
            let engine = self.engine.clone();
            self.sched
                .run_macrotask("worker", Origin::Completion, move |_| {
                    workers::dispatch_worker_events(&engine, id, events)
                        .map_err(|caught| info_from_caught(&caught))
                });
            self.checkpoint_all()?;
        }
        Ok(())
    }

    fn should_stop(&self) -> bool {
        self.stop.get()
            || self.state.fatal.get()
            || self.state.budget.get().is_some()
            || self.exit.requested.get()
            // A worker whose parent asked it to stop unwinds at the next loop boundary; the
            // interrupt handler covers a worker that is still executing bytecode (D48).
            || self.engine.is_cancelled()
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

            self.sync_host();

            // Engine-created jobs are lower priority than nextTick but must be part of the
            // *same* checkpoint, otherwise a tick followed only by promise jobs would end the
            // checkpoint early and flush rejections before the promise jobs ran (C3).
            let (_, queued_micros) = self.sched.pending();
            if queued_micros == 0 && self.engine.has_jobs() {
                self.seed_pump();
            }

            let (ticks, micros) = self.sched.pending();
            if ticks == 0
                && micros == 0
                && !self.engine.has_jobs()
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

            // A throwing async hook must surface like any other uncaught error, but it happened
            // inside an engine callback: report it here, between scheduler jobs.
            if let Some(dispatcher) = self.dispatcher.clone() {
                for info in self.async_hooks.take_errors() {
                    dispatcher.route_uncaught(&info);
                }
            }

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
        let hooks = self.async_hooks.clone();
        self.sched.queue_microtask("engine job", move |s| {
            pump_job(&engine, &exit, &bridge, &state, &stop, &hooks, s)
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
        // H4 for every family: no handle or worker event after this point, and every held loop ref
        // is released before the engine (a field of `Isolate`) is freed. Idempotent with `Drop`.
        self.release_worker_self_ref();
        self.signals.shutdown();
        self.procs.shutdown();
        self.ipc.shutdown();
        #[cfg(feature = "node-net")]
        self.handles.shutdown();
        self.workers.shutdown();
        // Close every SQLite connection while the engine is still alive: a future user-defined
        // function must not outlive the context that owns its callback.
        #[cfg(feature = "node-sqlite")]
        self.sqlite.shutdown();
        // Drop closures and close every library while the engine is alive: a closure holds a
        // persistent reference to a JavaScript function.
        #[cfg(feature = "ffi")]
        self.ffi.shutdown();
        // No completion may be delivered after shutdown (O4); release the refs of the parked
        // results the loop will never dispatch.
        let dropped = self.ops.discard_pending();
        for _ in 0..dropped {
            self.driver.borrow_mut().unref_external();
        }
        self.bridge.borrow_mut().ticks.clear();
        self.bridge.borrow_mut().rejections.clear();
        // The loop is over, so the trace can be closed and the timing rows printed (m7-plan §4.5).
        if let Some(diagnostics) = &mut self.diagnostics {
            diagnostics.finish();
        }

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
                    "onde: microtask budget exhausted after {jobs} jobs; \
                     the script is probably in an infinite microtask loop"
                );
            }
            BudgetHit::Wall => {
                let _ = writeln!(
                    err,
                    "onde: microtask timeout exceeded; \
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

    /// Network handles JavaScript currently knows about (diagnostics/tests).
    #[cfg(feature = "node-net")]
    pub fn live_handles(&self) -> usize {
        self.handles.live_handles()
    }

    /// External loop refs held by live handles: 0 or 1 per handle (H3, diagnostics/tests).
    #[cfg(feature = "node-net")]
    pub fn handle_refs(&self) -> usize {
        self.handles.held_refs()
    }

    /// Release the loop ref `parentPort` holds for this worker, once. Called before teardown, so
    /// a worker that ends (exit, terminate, or a closed port) cannot leak a ref.
    fn release_worker_self_ref(&self) {
        let Some(worker) = &self.worker else {
            return;
        };
        if worker.self_ref.replace(false) {
            self.driver.borrow_mut().unref_external();
        }
    }

    /// Children spawned by this isolate that have not closed (diagnostics/tests).
    pub fn live_children(&self) -> usize {
        self.procs.live_children()
    }

    /// External loop refs held by live children (diagnostics/tests).
    pub fn child_refs(&self) -> usize {
        self.procs.held_refs()
    }

    /// Workers started by this isolate that have not exited (diagnostics/tests).
    pub fn live_workers(&self) -> usize {
        self.workers.live_workers()
    }

    /// External loop refs held by live workers: 0 or 1 per worker (H3′, diagnostics/tests).
    pub fn worker_refs(&self) -> usize {
        self.workers.held_refs()
    }

    /// Run this isolate as a worker: announce, evaluate the entry, report the outcome.
    ///
    /// Called on the worker thread, after host installation and bootstrap. The parent sees
    /// `online`, then optionally `error`, then exactly one `exit`.
    pub(crate) fn run_worker(&mut self) -> i32 {
        let Some(worker) = self.worker.clone() else {
            return 1;
        };
        worker.sink.emit(workers::WorkerEvent::Online {
            thread_id: worker.thread_id,
        });

        let outcome = match &worker.entry {
            WorkerEntry::File(path) => self.run_file(path),
            WorkerEntry::Eval(source) => self.run(source, "[worker eval]"),
        };
        let mut code = match outcome {
            Ok(outcome) => outcome.exit_code,
            Err(failure) => {
                let mut err = io::stderr().lock();
                let _ = writeln!(err, "onde: worker failure: {failure}");
                let _ = err.flush();
                1
            }
        };
        if self.engine.is_cancelled() {
            code = 1;
        }

        if let Some(info) = self.state.fatal_error.borrow_mut().take() {
            worker.sink.emit(workers::WorkerEvent::Error {
                name: info.name,
                message: info.message,
                stack: info.stack,
                code: info.code.map(|code| code.to_string()),
            });
        }
        worker.sink.emit(workers::WorkerEvent::Exit { code });
        code
    }
}

/// Deliver the signal numbers parked since the last drain through `__ln_signal`.
fn run_signal_events(engine: &Engine, numbers: Vec<i32>) -> Result<(), CaughtError> {
    engine.with_ctx(|ctx| {
        let result: js::Result<()> = (|| {
            let signal: js::Function = ctx.globals().get("__ln_signal")?;
            for number in numbers {
                signal.call::<_, ()>((number,))?;
            }
            Ok(())
        })();
        js::CatchResultExt::catch(result, &ctx)
            .map_err(|error| ln_engine::caught_to_owned(&ctx, error))
    })
}

/// Reconstruct and deliver every message the parent queued for this worker.
///
/// This runs as one macrotask, in queue order. A message that fails to deserialize becomes Node's
/// `messageerror` event instead of an exception.
fn run_parent_messages(
    engine: &Engine,
    messages: Vec<ln_engine::Serialized>,
) -> Result<(), CaughtError> {
    engine.with_ctx(|ctx| {
        let result: js::Result<()> = (|| {
            let message: js::Function = ctx.globals().get("__ln_parent_message")?;
            let message_error: js::Function = ctx.globals().get("__ln_parent_message_error")?;
            for serialized in messages {
                match ln_engine::deserialize(&ctx, serialized) {
                    Ok(value) => message.call::<_, ()>((value,))?,
                    Err(error) => message_error.call::<_, ()>((error.message,))?,
                }
            }
            Ok(())
        })();
        js::CatchResultExt::catch(result, &ctx)
            .map_err(|error| ln_engine::caught_to_owned(&ctx, error))
    })
}

impl Drop for Isolate {
    fn drop(&mut self) {
        // The isolate is going away: stop the network tasks and release their refs *before* the
        // engine field is dropped, so no event can be dispatched into a freed context (H4).
        // `finish` normally did this already; `shutdown` is idempotent.
        self.release_worker_self_ref();
        self.signals.shutdown();
        self.procs.shutdown();
        self.ipc.shutdown();
        #[cfg(feature = "node-net")]
        self.handles.shutdown();
        self.workers.shutdown();
        // Close every SQLite connection while the engine is still alive: a future user-defined
        // function must not outlive the context that owns its callback.
        #[cfg(feature = "node-sqlite")]
        self.sqlite.shutdown();
        #[cfg(feature = "ffi")]
        self.ffi.shutdown();
        // The pinned dispatcher must not outlive the runtime it belongs to.
        self.async_hooks.forget_dispatch();
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

/// One handle event batch, followed by the usual bridge drain and a single checkpoint (the caller
/// runs it). The events were parked as plain Rust data (H1); this converts them on the isolate
/// thread and calls `__ln_handle_event` for each, in task order (H2). Compiled only with
/// `node-net`, which is the only thing that can park a handle event.
#[cfg(feature = "node-net")]
fn run_handle_events(
    engine: &Rc<Engine>,
    exit: &Rc<ExitState>,
    bridge: &Rc<RefCell<Bridge>>,
    id: u64,
    events: std::collections::VecDeque<ln_io::net::Event>,
    sched: &mut Scheduler,
) -> Result<(), ErrorInfo> {
    if exit.requested.get() {
        return Ok(());
    }
    let outcome = handles::dispatch_handle_events(engine, id, &events);
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
    hooks: &Rc<AsyncTracker>,
    sched: &mut Scheduler,
) -> Result<(), ErrorInfo> {
    if exit.requested.get() {
        return Ok(());
    }

    // Read the tag first: `before` must run with executionAsyncId already set to it, and the tag
    // is only available while the job is still queued. An untagged job (dynamic import, a
    // finalizer callback) keeps the enclosing context, which is the closest thing to Node's
    // "runs as whoever queued it".
    let Some(tag) = engine.next_job_tag() else {
        drain_bridge(bridge, sched, engine, exit);
        return Ok(());
    };
    let previous = engine.with_ctx(|ctx| hooks.enter(&ctx, tag));
    let outcome = engine.run_next_job();
    engine.with_ctx(|ctx| hooks.leave(&ctx, tag, previous));

    match outcome {
        PumpOutcome::Executed { .. } => {
            drain_bridge(bridge, sched, engine, exit);
            if engine.has_jobs() && !exit.requested.get() && !stop.get() {
                let engine = engine.clone();
                let exit = exit.clone();
                let bridge = bridge.clone();
                let state = state.clone();
                let stop = stop.clone();
                let hooks = hooks.clone();
                sched.queue_microtask("engine job", move |s| {
                    pump_job(&engine, &exit, &bridge, &state, &stop, &hooks, s)
                });
            }
            Ok(())
        }
        PumpOutcome::Idle => {
            drain_bridge(bridge, sched, engine, exit);
            Ok(())
        }
        PumpOutcome::Threw { error: caught, .. } => {
            if engine.take_interrupted() {
                // A worker cancelled by its parent unwinds quietly: termination is not a budget
                // trip and must not print a microtask-timeout diagnostic (D48).
                if engine.is_cancelled() {
                    return Ok(());
                }
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
        std::mem::take(&mut bridge.ticks)
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
        std::mem::take(&mut bridge.rejections)
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

pub(crate) fn info_from_caught(caught: &CaughtError) -> ErrorInfo {
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
            Config::new(vec!["onde".to_owned()]).inheritable.budget,
            Budget::UNBOUNDED
        );
    }

    /// Run `source` as a file entry with `permissions` installed; return its exit code.
    fn run_script(
        dir: &tempfile::TempDir,
        name: &str,
        source: &str,
        permissions: Option<Policy>,
    ) -> i32 {
        let path = dir.path().join(name);
        std::fs::write(&path, source).expect("write script");
        let mut config = Config::new(vec!["onde".to_owned(), path.display().to_string()]);
        config.inheritable.permissions = permissions;
        let mut isolate = Isolate::new(config).expect("isolate");
        isolate.run_file(&path).expect("run").exit_code
    }

    #[test]
    fn a_confined_isolate_denies_json_data_but_loads_module_source() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("data.json"), r#"{"x":1}"#).expect("data");
        std::fs::write(dir.path().join("mod.js"), "module.exports = 5;").expect("module");
        // Exit 0 only when the data read was denied and the source read still worked.
        let script = r#"
try {
  require("./data.json");
} catch (error) {
  if (error.code === "ERR_ACCESS_DENIED") {
    if (require("./mod.js") !== 5) throw new Error("source read failed");
    process.exit(0);
  }
  throw error;
}
process.exit(3);
"#;
        assert_eq!(
            run_script(&dir, "main.js", script, Some(Policy::deny_all())),
            0
        );
        assert_eq!(run_script(&dir, "main.js", script, Some(Policy::any())), 3);
        assert_eq!(run_script(&dir, "main.js", script, None), 3);
    }

    #[test]
    fn a_confined_isolate_denies_a_dynamic_json_import() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("data.json"), r#"{"x":1}"#).expect("data");
        let script = r#"
import("./data.json").then(
  () => process.exit(3),
  (error) => {
    if (error.code === "ERR_ACCESS_DENIED") process.exit(0);
    throw error;
  },
);
"#;
        assert_eq!(
            run_script(&dir, "main.js", script, Some(Policy::deny_all())),
            0
        );
        assert_eq!(run_script(&dir, "main.js", script, Some(Policy::any())), 3);
    }

    #[test]
    fn a_fs_read_grant_on_the_directory_allows_a_json_require() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("data.json"), r#"{"x":1}"#).expect("data");
        let script = r#"
const data = require("./data.json");
process.exit(data.x === 1 ? 0 : 4);
"#;
        let mut policy = Policy::deny_all();
        let root = std::fs::canonicalize(dir.path()).expect("canonical");
        policy.grant(
            ln_perm::Capability::FsRead,
            ln_perm::Rule::Path(ln_perm::PathRule::new(root)),
            ln_perm::Origin::CommandLine,
        );
        assert_eq!(run_script(&dir, "main.js", script, Some(policy)), 0);
    }

    fn fs_policy(root: &std::path::Path, capabilities: &[ln_perm::Capability]) -> Policy {
        let mut policy = ln_perm::Policy::deny_all();
        for capability in capabilities {
            policy.grant(
                *capability,
                ln_perm::Rule::Path(ln_perm::PathRule::new(root.to_path_buf())),
                ln_perm::Origin::CommandLine,
            );
        }
        policy
    }

    fn js_string(value: &str) -> String {
        serde_json::to_string(value).expect("json string")
    }

    #[test]
    fn the_denial_properties_survive_all_three_forms() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = js_string("/etc/passwd");
        let script = format!(
            r#"
const fs = require("fs");
let pending = 3;
function done(error) {{
  if (error.code !== "ERR_ACCESS_DENIED") process.exit(5);
  if (error.capability !== "fs.read") process.exit(6);
  if (typeof error.resource !== "string" || !error.resource.endsWith("/etc/passwd")) process.exit(7);
  if (typeof error.policy !== "string") process.exit(8);
  if (--pending === 0) process.exit(0);
}}
try {{
  fs.readFileSync({path});
  process.exit(9);
}} catch (error) {{
  done(error);
}}
fs.readFile({path}, (error) => done(error));
require("fs/promises").readFile({path}).then(() => process.exit(10), (error) => done(error));
"#,
            path = path,
        );
        assert_eq!(
            run_script(&dir, "main.js", &script, Some(ln_perm::Policy::deny_all())),
            0
        );
    }

    #[test]
    fn process_permission_has_answers_like_the_gates() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(dir.path()).expect("canonical");
        let data = root.join("data.json");
        std::fs::write(&data, "{}").expect("data");
        let script = format!(
            r#"
const data = {data};
const ok =
  process.permission.has("fs.read", data) === true &&
  process.permission.has("fs.read", "/etc/passwd") === false &&
  process.permission.has("nope", "x") === false &&
  process.permission.has("worker.spawn") === false &&
  process.permission.has("net.resolve", "127.0.0.1") === true &&
  process.permission.has("net.resolve", "example.com") === false;
try {{
  process.permission.has(1, "x");
}} catch (error) {{
  process.exit(ok && error.code === "ERR_INVALID_ARG_TYPE" ? 0 : 5);
}}
process.exit(6);
"#,
            data = js_string(&data.display().to_string()),
        );
        let policy = fs_policy(&root, &[ln_perm::Capability::FsRead]);
        assert_eq!(run_script(&dir, "main.js", &script, Some(policy)), 0);

        // With no policy every known scope answers true, including the two Node aliases.
        let unenforced = r#"
const ok =
  process.permission.has("fs.read", "/etc/passwd") === true &&
  process.permission.has("fs.write", "/etc/passwd") === true &&
  process.permission.has("child", "/bin/sh") === true &&
  process.permission.has("worker") === true;
process.exit(ok ? 0 : 5);
"#;
        assert_eq!(run_script(&dir, "main.js", unenforced, None), 0);
    }

    #[test]
    fn sqlite_memory_is_exempt_and_a_file_needs_fs_grants() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(dir.path()).expect("canonical");
        let memory = r#"
const { DatabaseSync } = require("node:sqlite");
try {
  const db = new DatabaseSync(":memory:");
  db.close();
  process.exit(0);
} catch (error) {
  process.exit(error.code === "ERR_ACCESS_DENIED" ? 5 : 6);
}
"#;
        assert_eq!(
            run_script(&dir, "main.js", memory, Some(ln_perm::Policy::deny_all())),
            0
        );

        let path = root.join("app.db");
        let file = format!(
            r#"
const {{ DatabaseSync }} = require("node:sqlite");
try {{
  const db = new DatabaseSync({path});
  db.exec("CREATE TABLE t(x)");
  db.close();
  process.exit(0);
}} catch (error) {{
  process.exit(error.code === "ERR_ACCESS_DENIED" ? 5 : 6);
}}
"#,
            path = js_string(&path.display().to_string()),
        );
        assert_eq!(
            run_script(&dir, "main.js", &file, Some(ln_perm::Policy::deny_all())),
            5
        );
        assert_eq!(
            run_script(
                &dir,
                "main.js",
                &file,
                Some(fs_policy(
                    &root,
                    &[ln_perm::Capability::FsRead, ln_perm::Capability::FsWrite]
                ))
            ),
            0
        );
    }

    #[test]
    fn sqlite_read_only_needs_read_and_read_write_needs_write() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(dir.path()).expect("canonical");
        let path = root.join("app.db");
        // Create the database first, with both grants.
        let create = format!(
            r#"const {{ DatabaseSync }} = require("node:sqlite");
const db = new DatabaseSync({path});
db.exec("CREATE TABLE t(x)");
db.close();
"#,
            path = js_string(&path.display().to_string()),
        );
        assert_eq!(
            run_script(
                &dir,
                "create.js",
                &create,
                Some(fs_policy(
                    &root,
                    &[ln_perm::Capability::FsRead, ln_perm::Capability::FsWrite]
                ))
            ),
            0
        );

        let read_only = format!(
            r#"
const {{ DatabaseSync }} = require("node:sqlite");
try {{
  const db = new DatabaseSync({path}, {{ readOnly: true }});
  db.close();
  process.exit(0);
}} catch (error) {{
  process.exit(error.code === "ERR_ACCESS_DENIED" ? 5 : 6);
}}
"#,
            path = js_string(&path.display().to_string()),
        );
        assert_eq!(
            run_script(
                &dir,
                "main.js",
                &read_only,
                Some(fs_policy(&root, &[ln_perm::Capability::FsRead]))
            ),
            0
        );
        assert_eq!(
            run_script(
                &dir,
                "main.js",
                &read_only,
                Some(fs_policy(&root, &[ln_perm::Capability::FsWrite]))
            ),
            5
        );
    }

    #[test]
    fn sqlite_extension_loading_needs_ffi_load() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(dir.path()).expect("canonical");
        let path = root.join("app.db");
        let script = format!(
            r#"
const {{ DatabaseSync }} = require("node:sqlite");
try {{
  const db = new DatabaseSync({path}, {{ allowExtension: true }});
  db.close();
  process.exit(0);
}} catch (error) {{
  process.exit(error.code === "ERR_ACCESS_DENIED" ? 5 : 6);
}}
"#,
            path = js_string(&path.display().to_string()),
        );
        let fs_only = fs_policy(
            &root,
            &[ln_perm::Capability::FsRead, ln_perm::Capability::FsWrite],
        );
        assert_eq!(run_script(&dir, "main.js", &script, Some(fs_only)), 5);

        let mut with_ffi = fs_policy(
            &root,
            &[ln_perm::Capability::FsRead, ln_perm::Capability::FsWrite],
        );
        with_ffi.grant(
            ln_perm::Capability::FfiLoad,
            ln_perm::Rule::Any,
            ln_perm::Origin::CommandLine,
        );
        assert_eq!(run_script(&dir, "main.js", &script, Some(with_ffi)), 0);
    }

    #[cfg(unix)]
    #[test]
    fn sqlite_refuses_a_symlinked_side_file() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(dir.path()).expect("canonical");
        symlink(root.join("elsewhere"), root.join("app.db-wal")).expect("symlink");
        let path = root.join("app.db");
        let script = format!(
            r#"
const {{ DatabaseSync }} = require("node:sqlite");
try {{
  const db = new DatabaseSync({path});
  db.close();
  process.exit(3);
}} catch (error) {{
  process.exit(error.code === "ERR_ACCESS_DENIED" ? 0 : 5);
}}
"#,
            path = js_string(&path.display().to_string()),
        );
        assert_eq!(
            run_script(
                &dir,
                "main.js",
                &script,
                Some(fs_policy(
                    &root,
                    &[ln_perm::Capability::FsRead, ln_perm::Capability::FsWrite]
                ))
            ),
            0
        );
    }

    #[test]
    fn dns_resolution_needs_a_grant_but_a_literal_address_does_not() {
        let dir = tempfile::tempdir().expect("tempdir");
        let denied = r#"
const dns = require("dns");
dns.lookup("localhost", (error) => {
  process.exit(error && error.code === "ERR_ACCESS_DENIED" ? 0 : 5);
});
"#;
        assert_eq!(
            run_script(&dir, "main.js", denied, Some(ln_perm::Policy::deny_all())),
            0
        );

        let mut policy = ln_perm::Policy::deny_all();
        policy.grant(
            ln_perm::Capability::NetResolve,
            ln_perm::Rule::Host(ln_perm::HostPattern::parse("localhost", false).unwrap()),
            ln_perm::Origin::CommandLine,
        );
        assert_eq!(run_script(&dir, "main.js", denied, Some(policy)), 5);

        let literal = r#"
const dns = require("dns");
dns.lookup("127.0.0.1", (error, address) => {
  process.exit(!error && address === "127.0.0.1" ? 0 : 5);
});
"#;
        assert_eq!(
            run_script(&dir, "main.js", literal, Some(ln_perm::Policy::deny_all())),
            0
        );
    }

    #[test]
    fn net_listen_and_connect_are_gated_at_the_candidate() {
        let dir = tempfile::tempdir().expect("tempdir");
        let denied = r#"
const net = require("net");
const server = net.createServer();
server.on("error", (error) => process.exit(error.code === "ERR_ACCESS_DENIED" ? 0 : 5));
server.listen(0, "127.0.0.1", () => process.exit(3));
"#;
        assert_eq!(
            run_script(&dir, "main.js", denied, Some(ln_perm::Policy::deny_all())),
            0
        );

        // A literal-address grant covers both directions, and a name that resolves to it is
        // governed by the same grant (D7).
        let allowed = r#"
const net = require("net");
const server = net.createServer((socket) => socket.end("ok"));
server.on("error", (error) => process.exit(error.code === "ERR_ACCESS_DENIED" ? 5 : 6));
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const client = net.connect({ host: "localhost", port });
  client.on("connect", () => {
    client.destroy();
    server.close(() => process.exit(0));
  });
  client.on("error", (error) => process.exit(error.code === "ERR_ACCESS_DENIED" ? 7 : 8));
});
"#;
        let mut policy = ln_perm::Policy::deny_all();
        for capability in [
            ln_perm::Capability::NetListen,
            ln_perm::Capability::NetConnect,
        ] {
            policy.grant(
                capability,
                ln_perm::Rule::Endpoint(ln_perm::EndpointRule::new(
                    ln_perm::HostPattern::parse("127.0.0.1", false).unwrap(),
                    None,
                )),
                ln_perm::Origin::CommandLine,
            );
        }
        // Resolving `localhost` is its own capability; the address grant is what the candidate
        // filter then matches.
        policy.grant(
            ln_perm::Capability::NetResolve,
            ln_perm::Rule::Host(ln_perm::HostPattern::parse("localhost", false).unwrap()),
            ln_perm::Origin::CommandLine,
        );
        assert_eq!(run_script(&dir, "main.js", allowed, Some(policy)), 0);
    }

    #[test]
    fn a_name_is_not_resolved_without_a_resolve_grant() {
        let dir = tempfile::tempdir().expect("tempdir");
        let script = |expected: &str| {
            format!(
                r#"
const net = require("net");
const socket = net.connect({{ host: "no-such-host.invalid", port: 80 }});
socket.on("error", (error) => process.exit(error.code === {expected} ? 0 : 5));
socket.on("connect", () => process.exit(3));
"#,
                expected = js_string(expected),
            )
        };

        // Deny-all refuses before the resolver runs: no DNS query escapes the policy.
        assert_eq!(
            run_script(
                &dir,
                "main.js",
                &script("ERR_ACCESS_DENIED"),
                Some(ln_perm::Policy::deny_all())
            ),
            0
        );

        // With the name granted, the resolver runs and reports the ordinary lookup failure.
        let mut policy = ln_perm::Policy::deny_all();
        policy.grant(
            ln_perm::Capability::NetResolve,
            ln_perm::Rule::Host(
                ln_perm::HostPattern::parse("no-such-host.invalid", false).unwrap(),
            ),
            ln_perm::Origin::CommandLine,
        );
        assert_eq!(
            run_script(&dir, "main.js", &script("ENOTFOUND"), Some(policy)),
            0
        );

        let listen = r#"
const net = require("net");
const server = net.createServer();
server.on("error", (error) => process.exit(error.code === "ERR_ACCESS_DENIED" ? 0 : 5));
server.listen(0, "no-such-host.invalid");
"#;
        assert_eq!(
            run_script(&dir, "main.js", listen, Some(ln_perm::Policy::deny_all())),
            0
        );
    }

    #[test]
    fn sqlite_file_uris_cannot_escape_the_grant() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(dir.path()).expect("canonical");
        let outside_dir = tempfile::tempdir().expect("outside");
        let outside = std::fs::canonicalize(outside_dir.path())
            .expect("canonical")
            .join("secret.db");

        let create = format!(
            r#"
const {{ DatabaseSync }} = require("node:sqlite");
const db = new DatabaseSync({path});
db.exec("CREATE TABLE t(x)");
db.exec("INSERT INTO t VALUES (1)");
db.close();
"#,
            path = js_string(&outside.display().to_string()),
        );
        assert_eq!(run_script(&dir, "create.js", &create, None), 0);

        let script = format!(
            r#"
process.chdir({root});
const {{ DatabaseSync }} = require("node:sqlite");
try {{
  const db = new DatabaseSync("file:" + {outside});
  db.exec("INSERT INTO t VALUES (99)");
  db.close();
  process.exit(3);
}} catch (error) {{
  process.exit(error.code === "ERR_ACCESS_DENIED" ? 0 : 5);
}}
"#,
            root = js_string(&root.display().to_string()),
            outside = js_string(&outside.display().to_string()),
        );
        assert_eq!(
            run_script(
                &dir,
                "main.js",
                &script,
                Some(fs_policy(
                    &root,
                    &[ln_perm::Capability::FsRead, ln_perm::Capability::FsWrite]
                ))
            ),
            0
        );
    }

    #[test]
    fn child_spawn_is_gated_on_the_resolved_program() {
        let dir = tempfile::tempdir().expect("tempdir");
        let denied = r#"
const { spawn } = require("child_process");
let child;
try {
  child = spawn("echo", ["hi"]);
} catch (error) {
  process.exit(error.code === "ERR_ACCESS_DENIED" ? 0 : 5);
}
child.on("error", (error) => process.exit(error.code === "ERR_ACCESS_DENIED" ? 0 : 6));
child.on("exit", () => process.exit(3));
"#;
        assert_eq!(
            run_script(&dir, "main.js", denied, Some(ln_perm::Policy::deny_all())),
            0
        );

        let allowed = r#"
const { spawn } = require("child_process");
const child = spawn("echo", ["hi"]);
child.on("error", (error) => process.exit(error.code === "ERR_ACCESS_DENIED" ? 5 : 6));
child.on("exit", (code) => process.exit(code === 0 ? 0 : 4));
"#;
        let mut policy = ln_perm::Policy::deny_all();
        policy.grant(
            ln_perm::Capability::ChildSpawn,
            ln_perm::Rule::Exec(ln_perm::ExecRule::Basename("echo".to_owned())),
            ln_perm::Origin::CommandLine,
        );
        assert_eq!(run_script(&dir, "main.js", allowed, Some(policy)), 0);
    }

    #[test]
    fn process_kill_needs_a_child_spawn_grant() {
        let dir = tempfile::tempdir().expect("tempdir");
        let script = r#"
try {
  process.kill(process.pid, 0);
} catch (error) {
  process.exit(error.code === "ERR_ACCESS_DENIED" ? 0 : 5);
}
process.exit(3);
"#;
        assert_eq!(
            run_script(&dir, "main.js", script, Some(ln_perm::Policy::deny_all())),
            0
        );
        let mut policy = ln_perm::Policy::deny_all();
        policy.grant(
            ln_perm::Capability::ChildSpawn,
            ln_perm::Rule::Exec(ln_perm::ExecRule::Basename("true".to_owned())),
            ln_perm::Origin::CommandLine,
        );
        assert_eq!(run_script(&dir, "main.js", script, Some(policy)), 3);
    }

    #[test]
    fn env_read_filters_process_env_and_deny_all_hides_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let script = r#"
if (process.env.PATH === undefined) process.exit(4);
if (process.env.HOME !== undefined) process.exit(5);
process.exit(0);
"#;
        let mut policy = ln_perm::Policy::deny_all();
        policy.grant(
            ln_perm::Capability::EnvRead,
            ln_perm::Rule::Name("PATH".to_owned()),
            ln_perm::Origin::CommandLine,
        );
        assert_eq!(run_script(&dir, "main.js", script, Some(policy)), 0);
        assert_eq!(
            run_script(&dir, "main.js", script, Some(ln_perm::Policy::deny_all())),
            4
        );
    }

    #[test]
    fn worker_spawn_is_gated_and_deny_all_refuses_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let script = r#"
const { Worker } = require("worker_threads");
try {
  new Worker("process.exit(0)", { eval: true });
} catch (error) {
  process.exit(error.code === "ERR_ACCESS_DENIED" ? 0 : 5);
}
process.exit(3);
"#;
        assert_eq!(
            run_script(&dir, "main.js", script, Some(ln_perm::Policy::deny_all())),
            0
        );
    }

    #[test]
    fn a_confined_write_fd_outside_the_table_is_denied() {
        let dir = tempfile::tempdir().expect("tempdir");
        let script = r#"
try {
  __ln_host.writeFd(9, new Uint8Array([65]));
} catch (error) {
  process.exit(error.code === "ERR_ACCESS_DENIED" ? 0 : 5);
}
process.exit(3);
"#;
        assert_eq!(
            run_script(&dir, "main.js", script, Some(ln_perm::Policy::deny_all())),
            0
        );
    }

    #[test]
    fn child_of_copies_the_inheritable_set_and_nothing_else() {
        let mut parent = Config::new(vec!["onde".to_owned()]);
        parent.inheritable.budget = Budget::jobs(7);
        parent.inheritable.io_threads = 9;
        parent.inheritable.max_old_space_size = Some(64 << 20);
        parent.inheritable.permissions = Some(Policy::deny_all());
        parent.inheritable.trace_ffi = FfiTrace::Full;
        parent.expose_require = true;
        parent.async_stack_traces = true;
        parent.test_files = Some(vec!["x".to_owned()]);

        let child = parent.child_of(vec!["onde".to_owned(), "worker.js".to_owned()]);
        assert_eq!(child.inheritable, parent.inheritable);
        assert!(!child.expose_require);
        assert!(!child.async_stack_traces);
        assert_eq!(child.test_files, None);
        assert_eq!(child.argv[1], "worker.js");
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
        let mut isolate = Isolate::new(Config::new(vec!["onde".to_owned()])).expect("isolate");
        isolate.run(source, "[eval]").expect("run")
    }

    #[test]
    fn sync_host_ops_return_uint8_arrays_with_negative_errno() {
        let source = r#"const value = __ln_host.fsSync("readFile", [__PATH__]);
if (!(value instanceof Uint8Array) || value.length === 0) throw new Error("bad readFile");
try {
  __ln_host.fsSync("readFile", ["/onde/definitely-missing"]);
  process.exit(20);
} catch (error) {
  const shaped =
    error.code === "ENOENT" &&
    error.errno === -2 &&
    error.syscall === "open" &&
    error.path === "/onde/definitely-missing";
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
        let mut isolate = Isolate::new(Config::new(vec!["onde".to_owned()])).expect("isolate");
        let outcome = isolate.run(&source, "[eval]").expect("run");
        assert_eq!(outcome.exit_code, 31);
        // O3: the ref was released when the completion slot was taken.
        assert_eq!(isolate.pending_ops(), 0);
    }

    #[test]
    fn async_op_errors_are_shaped_like_node() {
        let source = r#"__ln_op("readFile", ["/onde/definitely-missing"]).then(
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
