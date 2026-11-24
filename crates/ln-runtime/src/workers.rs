//! Worker threads: one nested isolate per OS thread (ADR-0008 §2.1–2.2).
//!
//! A worker is not a second context in the parent's runtime: it is a real [`Isolate`] built on
//! its own thread, with its own engine, scheduler, module graph and loop. That is what gives a
//! worker the ability to block without stalling the parent, and it keeps `Isolate: !Send` honest:
//! the parent never touches the worker's engine.
//!
//! # The shared surface is the wakeup
//!
//! The parent owns the worker's completion channel. It creates a [`ChannelReactor`] and its
//! [`CompletionSender`] before the thread starts, hands both to `Isolate::with_channel`, and keeps
//! the sender to wake the worker when a message or a cancel arrives. Messages themselves are owned
//! bytes plus shared-memory pointers ([`Serialized`]); the worker reconstructs a JS value on its
//! own isolate thread (H1′).
//!
//! # Loop refs
//!
//! A live worker holds at most one external loop ref (H3′): the parent takes it at `spawn` and
//! `exit` releases it at most once. `unref()` releases it early; `ref()` takes it back.
//!
//! # Shutdown
//!
//! [`WorkerBridge::shutdown`] closes the event gate (H4′), sets every worker's cancel flag, wakes
//! its loop, and gives each thread a short window to unwind and be joined. A thread stuck in a
//! native call is left detached rather than hanging the process: `terminate` is cooperative
//! (ADR-0008 §2.7, D48).

use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use ln_engine::{deserialize, js, Serialized};
use ln_error::NodeError;
use ln_sched::{Budget, ChannelReactor, Completion, CompletionSender, Driver};

use crate::ops::RequestIdAllocator;
use crate::{Config, Isolate, Role, WorkerEntry, WorkerRole};

/// Stack for a worker thread. QuickJS checks the native stack while evaluating, and a Rust std
/// thread defaults to 2 MiB; the main thread usually has 8 MiB.
const WORKER_STACK_SIZE: usize = 8 * 1024 * 1024;

/// How long shutdown waits for a worker to unwind before detaching it.
const SHUTDOWN_JOIN_TIMEOUT: Duration = Duration::from_millis(250);

/// Process-wide worker thread ids. The main thread is `0`, as in Node.
static NEXT_THREAD_ID: AtomicU32 = AtomicU32::new(1);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// What a worker sends to its parent. Plain Rust data: no `JSValue` leaves the worker (H1′).
#[derive(Debug)]
pub(crate) enum WorkerEvent {
    Online {
        thread_id: u32,
    },
    Message(Serialized),
    Error {
        name: String,
        message: String,
        stack: Option<String>,
        code: Option<String>,
    },
    Exit {
        code: i32,
    },
}

/// The event batch of one worker, parked until its completion is drained.
type Parked = Arc<Mutex<HashMap<u64, VecDeque<WorkerEvent>>>>;

/// Serializes `emit` against `shutdown` so no event can be delivered after shutdown returns (H4′).
struct Gate {
    open: AtomicBool,
    barrier: Mutex<()>,
}

impl Gate {
    fn new() -> Self {
        Gate {
            open: AtomicBool::new(true),
            barrier: Mutex::new(()),
        }
    }

    fn close(&self) {
        let _barrier = lock(&self.barrier);
        self.open.store(false, Ordering::SeqCst);
    }
}

/// The worker thread's handle on its parent's event table.
///
/// `Send + Sync` and cheap to clone: a worker can emit a message, an error and its exit from its
/// own thread without ever seeing a `WorkerBridge`.
#[derive(Clone)]
pub(crate) struct WorkerSink {
    id: u64,
    parked: Parked,
    sender: CompletionSender,
    gate: Arc<Gate>,
}

impl WorkerSink {
    pub(crate) fn emit(&self, event: WorkerEvent) {
        let _barrier = lock(&self.gate.barrier);
        if !self.gate.open.load(Ordering::SeqCst) {
            return;
        }
        lock(&self.parked)
            .entry(self.id)
            .or_default()
            .push_back(event);
        // The parent may already have dropped its receiver; nothing to wake then.
        let _ = self.sender.send(Completion(self.id));
    }
}

struct WorkerThread {
    handle: JoinHandle<()>,
    cancel: Arc<AtomicBool>,
    wake: CompletionSender,
    inbound: Arc<Mutex<VecDeque<Serialized>>>,
}

/// Owns every worker started by this isolate, its parked events and its loop refs.
pub(crate) struct WorkerBridge {
    ids: Arc<RequestIdAllocator>,
    driver: Rc<RefCell<Driver>>,
    parked: Parked,
    gate: Arc<Gate>,
    sender: CompletionSender,
    argv: Vec<String>,
    io_threads: usize,
    budget: Budget,
    /// The parent's `--max-old-space-size`, inherited by every worker unless `resourceLimits`
    /// overrides it (m7-plan §3.3).
    memory_limit: Option<u64>,
    live: RefCell<HashSet<u64>>,
    refs: RefCell<HashSet<u64>>,
    threads: RefCell<HashMap<u64, WorkerThread>>,
}

impl WorkerBridge {
    pub(crate) fn new(
        driver: Rc<RefCell<Driver>>,
        sender: CompletionSender,
        ids: Arc<RequestIdAllocator>,
        argv: Vec<String>,
        io_threads: usize,
        budget: Budget,
        memory_limit: Option<u64>,
    ) -> Self {
        WorkerBridge {
            ids,
            driver,
            parked: Arc::new(Mutex::new(HashMap::new())),
            gate: Arc::new(Gate::new()),
            sender,
            argv,
            io_threads,
            budget,
            memory_limit,
            live: RefCell::new(HashSet::new()),
            refs: RefCell::new(HashSet::new()),
            threads: RefCell::new(HashMap::new()),
        }
    }

    /// Start a worker for `id`. Returns its `threadId` so `new Worker()` can expose it at once.
    ///
    /// `argv` is `None` for "inherit the parent's `process.argv`", matching Node's default.
    pub(crate) fn spawn(
        &self,
        id: u64,
        entry: WorkerEntry,
        worker_data: Option<Serialized>,
        argv: Option<Vec<String>>,
        // `resourceLimits.maxOldGenerationSizeMb`, in bytes; `None` inherits the parent's limit.
        memory_limit: Option<u64>,
    ) -> Result<u32, NodeError> {
        if id == 0 {
            return Err(NodeError::invalid_arg_value(
                "worker",
                "0",
                "0 means no worker and cannot be spawned",
            ));
        }
        self.ids.observe(id);
        if !self.gate.open.load(Ordering::SeqCst) {
            return Err(NodeError::new(
                "ERR_WORKER_INIT_FAILED",
                "the isolate is shutting down",
            ));
        }
        if self.threads.borrow().contains_key(&id) {
            return Err(NodeError::new(
                "ERR_WORKER_INIT_FAILED",
                format!("worker {id} already exists"),
            ));
        }

        // An `eval: true` worker runs its source like Node's `-e`: a CommonJS context with a
        // `require` bound to the working directory.
        let eval_entry = matches!(entry, WorkerEntry::Eval(_));
        let thread_id = NEXT_THREAD_ID.fetch_add(1, Ordering::SeqCst);
        let (reactor, worker_sender) = ChannelReactor::new();
        // The parent keeps this sender; the worker gets the same channel from `with_channel`.
        let wake = worker_sender.clone();
        let inbound: Arc<Mutex<VecDeque<Serialized>>> = Arc::new(Mutex::new(VecDeque::new()));
        let cancel = Arc::new(AtomicBool::new(false));
        let sink = WorkerSink {
            id,
            parked: self.parked.clone(),
            sender: self.sender.clone(),
            gate: self.gate.clone(),
        };

        let role = WorkerRole {
            handle: id,
            thread_id,
            entry,
            worker_data: RefCell::new(worker_data),
            inbound: inbound.clone(),
            cancel: cancel.clone(),
            sink: sink.clone(),
            self_ref: std::cell::Cell::new(false),
        };

        let mut config = Config::new(argv.unwrap_or_else(|| self.argv.clone()));
        config.io_threads = self.io_threads;
        config.budget = self.budget;
        config.expose_require = eval_entry;
        // A worker's limit is its own runtime's, never the parent's: the two are separate heaps
        // (m7-plan §3.3, D53), which is why this is a per-worker value and not shared state.
        config.max_old_space_size = memory_limit.or(self.memory_limit);

        let thread_name = format!("onde-worker-{thread_id}");
        let handle = std::thread::Builder::new()
            .name(thread_name)
            .stack_size(WORKER_STACK_SIZE)
            .spawn(move || {
                let mut isolate =
                    match Isolate::with_channel(config, reactor, worker_sender, Role::Worker(role))
                    {
                        Ok(isolate) => isolate,
                        Err(failure) => {
                            sink.emit(WorkerEvent::Error {
                                name: "Error".to_owned(),
                                message: format!("could not start worker: {failure}"),
                                stack: None,
                                code: Some("ERR_WORKER_INIT_FAILED".to_owned()),
                            });
                            sink.emit(WorkerEvent::Exit { code: 1 });
                            return;
                        }
                    };
                isolate.run_worker();
            })
            .map_err(|error| {
                NodeError::new(
                    "ERR_WORKER_INIT_FAILED",
                    format!("could not create the worker thread: {error}"),
                )
            })?;

        self.register(
            id,
            WorkerThread {
                handle,
                cancel,
                wake,
                inbound,
            },
        );
        Ok(thread_id)
    }

    /// `host.worker(id, "postMessage", ...)` in the main isolate: park and wake.
    pub(crate) fn post_message(&self, id: u64, message: Serialized) {
        let threads = self.threads.borrow();
        let Some(worker) = threads.get(&id) else {
            return;
        };
        lock(&worker.inbound).push_back(message);
        let _ = worker.wake.send(Completion(id));
    }

    /// `worker.terminate()`: cooperative cancel plus a wakeup.
    pub(crate) fn terminate(&self, id: u64) {
        let threads = self.threads.borrow();
        if let Some(worker) = threads.get(&id) {
            worker.cancel.store(true, Ordering::SeqCst);
            let _ = worker.wake.send(Completion(id));
        }
    }

    /// Drain the events parked for `id`.
    pub(crate) fn take(&self, id: u64) -> Option<VecDeque<WorkerEvent>> {
        lock(&self.parked).remove(&id)
    }

    /// Bookkeeping before dispatch: `exit` is the end of a worker's life and releases its ref.
    pub(crate) fn observe(&self, id: u64, events: &VecDeque<WorkerEvent>) {
        if events
            .iter()
            .any(|event| matches!(event, WorkerEvent::Exit { .. }))
        {
            self.live.borrow_mut().remove(&id);
            self.release_ref(id);
            self.threads.borrow_mut().remove(&id);
        }
    }

    pub(crate) fn ref_worker(&self, id: u64) {
        if self.live.borrow().contains(&id) {
            self.take_ref(id);
        }
    }

    pub(crate) fn unref_worker(&self, id: u64) {
        self.release_ref(id);
    }

    /// Stop accepting events, cancel every worker, release every ref, and join what can be joined.
    pub(crate) fn shutdown(&self) {
        self.gate.close();
        let threads: HashMap<u64, WorkerThread> = self.threads.borrow_mut().drain().collect();
        for (id, worker) in &threads {
            worker.cancel.store(true, Ordering::SeqCst);
            let _ = worker.wake.send(Completion(*id));
        }
        let deadline = Instant::now() + SHUTDOWN_JOIN_TIMEOUT;
        for worker in threads.values() {
            while !worker.handle.is_finished() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        for (_, worker) in threads {
            if worker.handle.is_finished() {
                let _ = worker.handle.join();
            }
            // Otherwise the thread is detached: the process is exiting or the worker is stuck in a
            // native call that cannot be interrupted (D48).
        }
        lock(&self.parked).clear();
        let released: Vec<u64> = self.refs.borrow_mut().drain().collect();
        self.live.borrow_mut().clear();
        let mut driver = self.driver.borrow_mut();
        for _ in released {
            driver.unref_external();
        }
    }

    /// `parentPort.ref()` on a worker isolate: take (or keep) its own loop ref.
    pub(crate) fn self_ref(&self, role: &WorkerRole) {
        if !role.self_ref.replace(true) {
            self.driver.borrow_mut().ref_external();
        }
    }

    /// `parentPort.unref()` on a worker isolate: release its own loop ref early.
    pub(crate) fn self_unref(&self, role: &WorkerRole) {
        if role.self_ref.replace(false) {
            self.driver.borrow_mut().unref_external();
        }
    }

    pub(crate) fn live_workers(&self) -> usize {
        self.live.borrow().len()
    }

    pub(crate) fn held_refs(&self) -> usize {
        self.refs.borrow().len()
    }

    fn take_ref(&self, id: u64) {
        if self.refs.borrow_mut().insert(id) {
            self.driver.borrow_mut().ref_external();
        }
    }

    fn release_ref(&self, id: u64) {
        if self.refs.borrow_mut().remove(&id) {
            self.driver.borrow_mut().unref_external();
        }
    }

    /// Take the one ref a worker holds. Called by `spawn` after the thread exists.
    fn activate(&self, id: u64) {
        self.live.borrow_mut().insert(id);
        self.take_ref(id);
    }
}

// The spawn body is split so the `?` above cannot leave a live-but-unregistered thread behind.
impl WorkerBridge {
    fn register(&self, id: u64, thread: WorkerThread) {
        self.threads.borrow_mut().insert(id, thread);
        self.activate(id);
    }
}

/// Convert one worker event batch to JS and dispatch it through `__ln_worker_event`.
pub(crate) fn dispatch_worker_events(
    engine: &crate::Engine,
    id: u64,
    events: VecDeque<WorkerEvent>,
) -> Result<(), crate::CaughtError> {
    engine.with_ctx(|ctx| {
        let result: js::Result<()> = (|| {
            let callback: js::Function = ctx.globals().get("__ln_worker_event")?;
            for event in events {
                match event {
                    WorkerEvent::Online { thread_id } => {
                        let payload = js::Object::new(ctx.clone())?;
                        payload.set("threadId", thread_id)?;
                        callback.call::<_, ()>((id, "online", payload))?;
                    }
                    WorkerEvent::Message(message) => {
                        // On failure the sink reports `messageerror` so the JS side can emit
                        // Node's event rather than throwing into the loop.
                        let value = match deserialize(&ctx, message) {
                            Ok(value) => value,
                            Err(error) => {
                                let payload = js::Object::new(ctx.clone())?;
                                payload.set("message", error.message)?;
                                callback.call::<_, ()>((id, "messageerror", payload))?;
                                continue;
                            }
                        };
                        callback.call::<_, ()>((id, "message", value))?;
                    }
                    WorkerEvent::Error {
                        name,
                        message,
                        stack,
                        code,
                    } => {
                        let make: js::Function = ctx.globals().get("__ln_make_error")?;
                        let error: js::Value = make.call((
                            name.as_str(),
                            message.as_str(),
                            stack.as_deref(),
                            code.as_deref(),
                        ))?;
                        callback.call::<_, ()>((id, "error", error))?;
                    }
                    WorkerEvent::Exit { code } => {
                        let payload = js::Object::new(ctx.clone())?;
                        payload.set("code", code)?;
                        callback.call::<_, ()>((id, "exit", payload))?;
                    }
                }
            }
            Ok(())
        })();
        js::CatchResultExt::catch(result, &ctx)
            .map_err(|error| ln_engine::caught_to_owned(&ctx, error))
    })
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::time::Duration;

    use crate::{Config, Isolate};

    fn run(source: &str) -> (i32, usize, usize) {
        let mut config = Config::new(vec!["lite".to_owned()]);
        config.expose_require = true;
        let mut isolate = Isolate::new(config).expect("isolate");
        let outcome = isolate.run(source, "[eval]").expect("run");
        (
            outcome.exit_code,
            isolate.worker_refs(),
            isolate.live_workers(),
        )
    }

    /// Run with a wall-clock bound, so a worker that fails to terminate fails the test instead of
    /// hanging the suite.
    fn run_bounded(source: &str, bound: Duration) -> i32 {
        let source = source.to_owned();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut config = Config::new(vec!["lite".to_owned()]);
            config.expose_require = true;
            let mut isolate = Isolate::new(config).expect("isolate");
            let outcome = isolate.run(&source, "[eval]").expect("run");
            let refs = isolate.worker_refs();
            let live = isolate.live_workers();
            let _ = tx.send((outcome.exit_code, refs, live));
        });
        let (code, refs, live) = rx
            .recv_timeout(bound)
            .expect("the isolate did not finish: a worker kept the loop alive");
        assert_eq!(refs, 0, "every worker ref must be released");
        assert_eq!(live, 0, "every worker must be forgotten");
        code
    }

    /// A worker that exits normally releases its loop ref and is forgotten; the process exits 0.
    #[test]
    fn a_finished_worker_releases_its_ref() {
        let (code, refs, live) = run(r#"
const { Worker } = require("worker_threads");
const worker = new Worker("process.exit(0)", { eval: true });
worker.on("exit", (code) => process.exit(code === 0 ? 0 : 21));
"#);
        assert_eq!(code, 0);
        assert_eq!(refs, 0);
        assert_eq!(live, 0);
    }

    /// `terminate()` interrupts a tight JS loop at the next bytecode safepoint (D48's supported
    /// half), reports exit code 1, and releases the parent's ref.
    #[test]
    fn terminate_stops_a_busy_worker_and_reports_one() {
        let code = run_bounded(
            r#"
const { Worker } = require("worker_threads");
const worker = new Worker("while (true) {}", { eval: true });
worker.on("exit", (code) => {
  if (code !== 1) process.exit(8);
});
worker.on("online", () => {
  worker.terminate().then((code) => {
    if (code !== 1) process.exit(9);
  });
});
"#,
            Duration::from_secs(10),
        );
        assert_eq!(code, 0);
    }

    /// An uncaught error in a worker becomes `error` on the parent and then `exit 1`.
    #[test]
    fn a_worker_error_is_reported_before_exit() {
        let code = run_bounded(
            r#"
const { Worker } = require("worker_threads");
const worker = new Worker("throw new Error('boom')", { eval: true });
let sawError = false;
worker.on("error", (error) => {
  if (error.message !== "boom") process.exit(9);
  sawError = true;
});
worker.on("exit", (code) => {
  if (!sawError) process.exit(7);
  if (code !== 1) process.exit(8);
});
"#,
            Duration::from_secs(10),
        );
        assert_eq!(code, 0);
    }

    /// A listening `parentPort` keeps the worker alive long enough to receive a later message; the
    /// port is what holds the loop ref (Node's refcount), not the thread itself.
    #[test]
    fn a_listening_parent_port_keeps_the_worker_alive() {
        let code = run_bounded(
            r#"
const { Worker } = require("worker_threads");
const worker = new Worker(
  `const { parentPort } = require("worker_threads");
   parentPort.on("message", (value) => parentPort.postMessage("echo:" + value));`,
  { eval: true },
);
let seen = false;
worker.on("message", (message) => {
  if (message !== "echo:go") process.exit(9);
  seen = true;
  worker.terminate().then(() => process.exit(seen ? 0 : 7));
});
setTimeout(() => worker.postMessage("go"), 20);
"#,
            Duration::from_secs(10),
        );
        assert_eq!(code, 0);
    }

    /// `unref()` releases the parent's loop ref, so the parent exits while the worker is still
    /// running; teardown then cancels it.
    #[test]
    fn an_unrefed_worker_lets_the_parent_exit() {
        let code = run_bounded(
            r#"
const { Worker } = require("worker_threads");
const worker = new Worker("setInterval(() => {}, 1000)", { eval: true });
worker.unref();
"#,
            Duration::from_secs(10),
        );
        assert_eq!(code, 0);
    }
}
