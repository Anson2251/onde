//! Reference implementation of onde's scheduler: checkpoints, timers and the loop driver.
//!
//! This crate exists so the policy in ADR-0002 and ADR-0003 is executable and reviewable before
//! any FFI is involved. It is engine-free on purpose: `ln-engine` adapts a [`Job`] to
//! `JS_ExecutePendingJob` (unpatched) or `JS_JobRun` (patched) and feeds [`Event`]s back into
//! JS. Everything here is deterministic and single-threaded.
//!
//! # The model
//!
//! Two queues, one checkpoint:
//!
//! ```text
//! ticks  (process.nextTick)  ─┐
//!                             ├─▶ checkpoint ─▶ flush unhandled rejections
//! micros (then/await/qm)     ─┘
//! ```
//!
//! A checkpoint drains `ticks` to exhaustion, then `micros` to exhaustion, then re-checks
//! `ticks`. See ADR-0002 §5 for why each pass is needed.
//!
//! Timers and immediates live in [`driver::Driver`], which models the loop shell from ADR-0003:
//! timers → completions → immediates → block. The checkpoint and the driver are independent: the
//! loop runs one callback from the driver, then one checkpoint, which is exactly the sequencing
//! every later milestone depends on.
//!
//! # Invariants (ADR-0002 §4)
//!
//! * exactly one owner drains ([`Scheduler::checkpoint`] is idempotent when nested);
//! * the microtask queue is FIFO, new jobs append at the tail;
//! * a throwing job is reported inline and the drain continues;
//! * unhandled rejections are reported once, after both queues empty;
//! * a checkpoint can be bounded by a budget, and can be stopped by `process.exit` without
//!   draining the rest of the queue.

pub mod driver;
pub mod timer;

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;
use std::time::{Duration, Instant};

pub use driver::{
    ChannelReactor, Completion, CompletionSender, Driver, FakeReactor, ImmediateId, Reactor,
    Sleeper, Turn,
};
pub use timer::{TimerId, TimerQueue};

/// Identifier for a queued job. Stable for the lifetime of the job, used in diagnostics and in
/// `async_hooks` bookkeeping once the engine patch lands.
pub type JobId = u64;

/// Engine-side async resource id. In the reference implementation it is caller-assigned; in the
/// real runtime it comes from the promise hook (`JS_SetPromiseHook` INIT) and the job tag.
pub type AsyncId = i64;

/// Opaque promise identity used by the unhandled-rejection table. In the real runtime this is an
/// id minted by the JS rejection tracker, which keeps the actual promise object so event
/// listeners receive the engine's own value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PromiseKey(pub u64);

/// Where a job came from. Used for error reporting and diagnostics, not for ordering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// `process.nextTick`.
    Tick,
    /// `queueMicrotask`.
    Microtask,
    /// A promise reaction (`then`/`await`/`catch`/`finally`), enqueued by the engine at settle.
    PromiseReaction,
    /// A host task that should run at microtask priority (module evaluation step, finalizer).
    Host,
    /// A timer, immediate or completion callback. Macrotask origins only appear in `Uncaught`
    /// events, never in the microtask queues.
    Timer,
    /// `setImmediate`.
    Immediate,
    /// An I/O completion dispatched by the reactor (M3+).
    Completion,
}

/// A plain-Rust description of a thrown value. The engine boundary converts its own exception
/// type into this so the scheduler stays engine-free, and the runtime can render Node-shaped
/// output from it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ErrorInfo {
    /// `error.name` for an `Error` instance, `"Error"` otherwise.
    pub name: String,
    /// `error.message` for an `Error` instance, `String(value)` for a thrown primitive.
    pub message: String,
    /// `error.stack`, when the thrown value has one.
    pub stack: Option<String>,
    /// `String(value)` of the thrown value, always populated.
    pub display: String,
    /// True when the thrown value was an `Error`-like object.
    pub is_error: bool,
    /// `error.code` when present (Node-style codes survive the scheduler boundary). Boxed so
    /// every scheduler job result stays small.
    pub code: Option<Box<str>>,
}

impl ErrorInfo {
    /// A plain `Error` with `message` and no stack. Used by engine-free policy tests.
    pub fn message(message: impl Into<String>) -> Self {
        let message = message.into();
        ErrorInfo {
            name: "Error".to_owned(),
            display: format!("Error: {message}"),
            message,
            stack: None,
            is_error: true,
            code: None,
        }
    }

    /// `name: message` (or the thrown primitive) plus frames. The runtime owns the final layout
    /// (header, source excerpt, caret); this is the shared body.
    pub fn body(&self) -> String {
        let mut out = String::new();
        if self.is_error {
            out.push_str(&self.name);
            if let Some(code) = &self.code {
                out.push_str(" [");
                out.push_str(code);
                out.push(']');
            }
            out.push_str(": ");
            out.push_str(&self.message);
        } else {
            out.push_str(&self.display);
        }
        if let Some(stack) = &self.stack {
            if !stack.is_empty() {
                out.push('\n');
                out.push_str(stack.trim_end_matches('\n'));
            }
        }
        out
    }
}

impl std::fmt::Display for ErrorInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.body())
    }
}

/// A scheduler-level event. The runtime maps these onto JS: `uncaughtException`,
/// `unhandledRejection`, `rejectionHandled`, or a fatal diagnostic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// A job threw. Emitted inline, at the failing job, while the checkpoint is still running.
    Uncaught {
        job: JobId,
        origin: Origin,
        error: ErrorInfo,
    },
    /// A rejection survived a whole checkpoint with no handler attached.
    UnhandledRejection { promise: PromiseKey, reason: String },
    /// A previously reported rejection got a handler later. Emitted at the end of the checkpoint
    /// in which the handler was attached, after the reaction it queued has run (Node's order:
    /// the `catch` callback logs before `rejectionHandled`).
    RejectionHandled { promise: PromiseKey },
    /// A checkpoint exceeded its budget. The queues are left intact; teardown frees them.
    BudgetExceeded {
        jobs: u64,
        ticks_pending: usize,
        micros_pending: usize,
    },
}

/// What happened when a rejection handler was attached.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandleOutcome {
    /// The tracker reported a rejection for an id the scheduler does not know.
    Unknown,
    /// The rejection was still a candidate; it is removed silently and never reported.
    Candidate,
    /// The rejection had already been reported; `rejectionHandled` is queued for the flush.
    Reported,
}

/// Outcome of [`Scheduler::checkpoint`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Checkpoint {
    /// Both queues are empty.
    Drained { jobs: u64 },
    /// The budget tripped. Work remains queued; the runtime is expected to terminate.
    BudgetExceeded { jobs: u64 },
    /// A stop was requested (typically `process.exit`). Queues are left intact for teardown and
    /// no rejection flush happens.
    Stopped { jobs: u64 },
    /// A checkpoint was requested from inside a checkpoint. This is a no-op (invariant I2).
    Nested,
}

/// Optional bounds on a single checkpoint.
///
/// Defaults are unbounded, matching Node. `max_jobs_per_checkpoint` maps to
/// `--max-microtasks`; `max_wall_per_checkpoint` is the cooperative deadline that the real
/// runtime also enforces inside long bytecode runs via `JS_SetInterruptHandler`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Budget {
    pub max_jobs_per_checkpoint: Option<u64>,
    pub max_wall_per_checkpoint: Option<Duration>,
}

impl Budget {
    pub const UNBOUNDED: Budget = Budget {
        max_jobs_per_checkpoint: None,
        max_wall_per_checkpoint: None,
    };

    pub fn jobs(n: u64) -> Budget {
        Budget {
            max_jobs_per_checkpoint: Some(n),
            max_wall_per_checkpoint: None,
        }
    }
}

type Body = Box<dyn FnOnce(&mut Scheduler) -> Result<(), ErrorInfo>>;
type Sink = Box<dyn FnMut(&Event)>;
type Clock = Box<dyn Fn() -> Instant>;

type Injected = (Origin, String, Body);

/// A mailbox an event sink can use to append microtasks while the scheduler is borrowed.
///
/// `uncaughtException` handlers run *inside* `Scheduler::run` (the event is emitted at the
/// failing job). If the handler queues a promise job, the pump that runs engine jobs has already
/// returned; the runtime hands the scheduler a fresh pump through this mailbox so the handler's
/// jobs run later in the same drain (C8).
#[derive(Clone, Default)]
pub struct SinkMailbox {
    queue: Rc<RefCell<VecDeque<Injected>>>,
}

impl SinkMailbox {
    /// Append a microtask. It runs at the tail of the current pass B, after the jobs already
    /// queued, which is exactly where a job enqueued by a running job belongs (invariant I3).
    pub fn push<F>(&self, origin: Origin, name: impl Into<String>, body: F)
    where
        F: FnOnce(&mut Scheduler) -> Result<(), ErrorInfo> + 'static,
    {
        self.queue
            .borrow_mut()
            .push_back((origin, name.into(), Box::new(body)));
    }
}

/// A queued unit of work.
///
/// In the real runtime `body` either runs one `JS_ExecutePendingJob` (unpatched build) or calls
/// `JS_JobRun` on an owned handle (patched build). The scheduler never inspects the body, which
/// is what keeps this crate engine-free.
pub struct Job {
    id: JobId,
    pub origin: Origin,
    pub async_id: AsyncId,
    pub trigger_id: AsyncId,
    pub name: String,
    body: Option<Body>,
}

impl Job {
    /// Diagnostic name, e.g. `process.nextTick`, `Promise.then`, `node:fs readFile`.
    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn id(&self) -> JobId {
        self.id
    }
}

impl std::fmt::Debug for Job {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Job")
            .field("id", &self.id)
            .field("origin", &self.origin)
            .field("name", &self.name)
            .field("async_id", &self.async_id)
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
struct Rejection {
    promise: PromiseKey,
    reason: String,
    reported: bool,
}

/// The scheduler. One per isolate, owned by the event loop, never shared between threads.
pub struct Scheduler {
    ticks: VecDeque<Job>,
    micros: VecDeque<Job>,
    next_job_id: JobId,
    in_checkpoint: bool,
    budget: Budget,
    executed_in_checkpoint: u64,
    total_jobs: u64,
    checkpoints: u64,
    started: Instant,
    clock: Clock,
    events: Vec<Event>,
    sink: Option<Sink>,
    rejections: Vec<Rejection>,
    /// Previously reported rejections that got a handler during the current checkpoint. Their
    /// `rejectionHandled` event is deferred to the flush, after the catch reaction has run.
    late_handled: Vec<PromiseKey>,
    dropped_on_shutdown: u64,
    stop: Rc<Cell<bool>>,
    mailbox: SinkMailbox,
}

impl Default for Scheduler {
    fn default() -> Self {
        Self::new()
    }
}

impl Scheduler {
    pub fn new() -> Self {
        Scheduler {
            ticks: VecDeque::new(),
            micros: VecDeque::new(),
            next_job_id: 0,
            in_checkpoint: false,
            budget: Budget::UNBOUNDED,
            executed_in_checkpoint: 0,
            total_jobs: 0,
            checkpoints: 0,
            started: Instant::now(),
            clock: Box::new(Instant::now),
            events: Vec::new(),
            sink: None,
            rejections: Vec::new(),
            late_handled: Vec::new(),
            dropped_on_shutdown: 0,
            stop: Rc::new(Cell::new(false)),
            mailbox: SinkMailbox::default(),
        }
    }

    /// Replace the clock. Tests use a fake clock so budgets and timers never sleep.
    pub fn set_clock<F>(&mut self, clock: F)
    where
        F: Fn() -> Instant + 'static,
    {
        self.clock = Box::new(clock);
    }

    /// Install a synchronous event sink. It is called *at the point the event happens*, which is
    /// how `uncaughtException` reporting interleaves with the remaining microtasks (Node C2).
    pub fn set_event_sink<F>(&mut self, sink: F)
    where
        F: FnMut(&Event) + 'static,
    {
        self.sink = Some(Box::new(sink));
    }

    pub fn set_budget(&mut self, budget: Budget) {
        self.budget = budget;
    }

    /// A mailbox the installed sink can use to queue microtasks from inside an event callback.
    pub fn sink_mailbox(&self) -> SinkMailbox {
        self.mailbox.clone()
    }

    /// A handle the runtime flips to end the current drain without touching the queues. Used by
    /// `process.exit`, which must not run the remaining microtasks (ADR-0002 R3).
    pub fn stop_handle(&self) -> Rc<Cell<bool>> {
        self.stop.clone()
    }

    /// Request that the current and any future checkpoint stop draining.
    pub fn request_stop(&self) {
        self.stop.set(true);
    }

    /// True when a rejection has been recorded but not reported (or a late-handled event is
    /// waiting for the flush). The loop keeps checkpointing while this is true, so a rejection
    /// created by an `unhandledRejection` handler is reported in the next drain, as in Node.
    pub fn has_pending_rejections(&self) -> bool {
        !self.late_handled.is_empty() || self.rejections.iter().any(|r| !r.reported)
    }

    /// True when a stop was requested.
    pub fn is_stopped(&self) -> bool {
        self.stop.get()
    }

    /// Clear a previous stop request. The runtime calls this before each run.
    pub fn clear_stop(&self) {
        self.stop.set(false);
    }

    /// The wall-clock bound for one checkpoint, if configured. The runtime turns this into an
    /// engine interrupt deadline so a single long-running JS job can be aborted too.
    pub fn wall_budget(&self) -> Option<Duration> {
        self.budget.max_wall_per_checkpoint
    }

    /// Queue a `process.nextTick` job.
    pub fn queue_tick<F>(&mut self, name: impl Into<String>, f: F) -> JobId
    where
        F: FnOnce(&mut Scheduler) -> Result<(), ErrorInfo> + 'static,
    {
        self.push(true, Origin::Tick, name, f)
    }

    /// Queue a `queueMicrotask` job. Same FIFO as promise reactions, by design.
    pub fn queue_microtask<F>(&mut self, name: impl Into<String>, f: F) -> JobId
    where
        F: FnOnce(&mut Scheduler) -> Result<(), ErrorInfo> + 'static,
    {
        self.push(false, Origin::Microtask, name, f)
    }

    /// Queue an engine-created promise reaction job (`then`/`await` continuation).
    pub fn queue_promise_reaction<F>(&mut self, name: impl Into<String>, f: F) -> JobId
    where
        F: FnOnce(&mut Scheduler) -> Result<(), ErrorInfo> + 'static,
    {
        self.push(false, Origin::PromiseReaction, name, f)
    }

    /// Queue a host task at microtask priority (module evaluation step, finalizer callback).
    pub fn queue_host_microtask<F>(&mut self, name: impl Into<String>, f: F) -> JobId
    where
        F: FnOnce(&mut Scheduler) -> Result<(), ErrorInfo> + 'static,
    {
        self.push(false, Origin::Host, name, f)
    }

    fn push<F>(&mut self, tick: bool, origin: Origin, name: impl Into<String>, f: F) -> JobId
    where
        F: FnOnce(&mut Scheduler) -> Result<(), ErrorInfo> + 'static,
    {
        let id = self.next_job_id;
        self.next_job_id += 1;
        let job = Job {
            id,
            origin,
            async_id: 0,
            trigger_id: 0,
            name: name.into(),
            body: Some(Box::new(f)),
        };
        if tick {
            self.ticks.push_back(job);
        } else {
            self.micros.push_back(job);
        }
        id
    }

    /// Run a macrotask body *now*, through the normal event path, without putting it in either
    /// microtask queue. The loop uses this for timer/immediate/completion callbacks and for the
    /// entry script: the callback is not a microtask, but its exception must still be reported
    /// inline and attributed to a job.
    pub fn run_macrotask<F>(&mut self, name: impl Into<String>, origin: Origin, f: F)
    where
        F: FnOnce(&mut Scheduler) -> Result<(), ErrorInfo> + 'static,
    {
        if self.stop.get() {
            return;
        }
        let id = self.next_job_id;
        self.next_job_id += 1;
        let job = Job {
            id,
            origin,
            async_id: 0,
            trigger_id: 0,
            name: name.into(),
            body: Some(Box::new(f)),
        };
        self.run(job);
    }

    /// Record a rejected promise. This is the tracker's `is_handled = false` signal: a
    /// *candidate*, not yet an unhandled rejection.
    pub fn reject(&mut self, promise: PromiseKey, reason: impl Into<String>) {
        if self.rejections.iter().any(|r| r.promise == promise) {
            return;
        }
        self.rejections.push(Rejection {
            promise,
            reason: reason.into(),
            reported: false,
        });
    }

    /// Record that a handler was attached (tracker's `is_handled = true`).
    ///
    /// If the rejection had already been reported, the `rejectionHandled` event is queued for
    /// the end of the current checkpoint so it lands after the catch reaction (Node's order).
    pub fn handle(&mut self, promise: PromiseKey) -> HandleOutcome {
        let Some(pos) = self.rejections.iter().position(|r| r.promise == promise) else {
            return HandleOutcome::Unknown;
        };
        let r = self.rejections.remove(pos);
        if r.reported {
            if !self.late_handled.contains(&promise) {
                self.late_handled.push(promise);
            }
            HandleOutcome::Reported
        } else {
            HandleOutcome::Candidate
        }
    }

    /// Run a checkpoint: drain ticks, then microtasks, then re-check ticks.
    ///
    /// Nested calls are no-ops (invariant I2) and do not flush rejections.
    pub fn checkpoint(&mut self) -> Checkpoint {
        if self.in_checkpoint {
            return Checkpoint::Nested;
        }
        self.in_checkpoint = true;
        self.executed_in_checkpoint = 0;
        self.started = (self.clock)();
        self.checkpoints += 1;

        let mut tripped = false;
        let mut stopped = false;
        'drain: loop {
            if self.stop.get() {
                stopped = true;
                break;
            }

            // Pass A: nextTick to exhaustion. The budget only applies while work remains, and is
            // checked before popping so that a trip leaves the queue intact (invariant I9).
            loop {
                if self.ticks.is_empty() {
                    break;
                }
                if self.stop.get() {
                    stopped = true;
                    break 'drain;
                }
                if self.over_budget() {
                    tripped = true;
                    break 'drain;
                }
                let job = self.ticks.pop_front().expect("checked non-empty");
                self.executed_in_checkpoint += 1;
                self.run(job);
            }

            // Pass B: engine microtasks to exhaustion, in settle order.
            loop {
                if self.micros.is_empty() {
                    break;
                }
                if self.stop.get() {
                    stopped = true;
                    break 'drain;
                }
                if self.over_budget() {
                    tripped = true;
                    break 'drain;
                }
                let job = self.micros.pop_front().expect("checked non-empty");
                self.executed_in_checkpoint += 1;
                self.run(job);
            }

            // Pass C: ticks queued from a microtask run after the microtask queue is empty.
            if self.ticks.is_empty() {
                break;
            }
        }

        self.in_checkpoint = false;

        if stopped {
            return Checkpoint::Stopped {
                jobs: self.executed_in_checkpoint,
            };
        }

        if tripped {
            self.emit(Event::BudgetExceeded {
                jobs: self.executed_in_checkpoint,
                ticks_pending: self.ticks.len(),
                micros_pending: self.micros.len(),
            });
            return Checkpoint::BudgetExceeded {
                jobs: self.executed_in_checkpoint,
            };
        }

        self.flush_rejections();
        // Event handlers may have queued microtasks through the sink mailbox.
        self.drain_mailbox();
        Checkpoint::Drained {
            jobs: self.executed_in_checkpoint,
        }
    }

    fn run(&mut self, mut job: Job) {
        self.total_jobs += 1;
        let body = job.body.take().expect("job body is taken exactly once");
        if let Err(error) = body(self) {
            self.emit(Event::Uncaught {
                job: job.id,
                origin: job.origin,
                error,
            });
        }
        self.drain_mailbox();
    }

    fn drain_mailbox(&mut self) {
        let injected: Vec<Injected> = {
            let mut mailbox = self.mailbox.queue.borrow_mut();
            // The queue is a `VecDeque` and the jobs are processed in order, so the deque is moved
            // out whole and converted rather than drained element by element.
            std::mem::take(&mut *mailbox).into()
        };
        for (origin, name, body) in injected {
            let id = self.next_job_id;
            self.next_job_id += 1;
            self.micros.push_back(Job {
                id,
                origin,
                async_id: 0,
                trigger_id: 0,
                name,
                body: Some(body),
            });
        }
    }

    fn over_budget(&self) -> bool {
        if let Some(max) = self.budget.max_jobs_per_checkpoint {
            if self.executed_in_checkpoint >= max {
                return true;
            }
        }
        if let Some(max) = self.budget.max_wall_per_checkpoint {
            if (self.clock)().saturating_duration_since(self.started) >= max {
                return true;
            }
        }
        false
    }

    fn flush_rejections(&mut self) {
        let pending: Vec<(PromiseKey, String)> = self
            .rejections
            .iter()
            .filter(|r| !r.reported)
            .map(|r| (r.promise, r.reason.clone()))
            .collect();

        for (promise, reason) in pending {
            if self.stop.get() {
                return;
            }
            if let Some(r) = self.rejections.iter_mut().find(|r| r.promise == promise) {
                r.reported = true;
                // The JS table owns the reason for listeners; the scheduler only needed it for
                // the event. Keeping it would grow the table for every reported rejection.
                r.reason.clear();
            }
            self.emit(Event::UnhandledRejection { promise, reason });
        }

        let late = std::mem::take(&mut self.late_handled);
        for promise in late {
            if self.stop.get() {
                return;
            }
            self.emit(Event::RejectionHandled { promise });
        }
    }

    fn emit(&mut self, event: Event) {
        if let Some(sink) = self.sink.as_mut() {
            sink(&event);
        }
        self.events.push(event);
    }

    /// Drop all queued work. In the real runtime this is where `JS_JobFree` would be called for
    /// every pending job; holding only owned Rust payloads keeps teardown trivial (invariant I10).
    pub fn shutdown(&mut self) {
        self.dropped_on_shutdown += (self.ticks.len() + self.micros.len()) as u64;
        self.ticks.clear();
        self.micros.clear();
        self.rejections.clear();
        self.late_handled.clear();
    }

    // --- introspection -------------------------------------------------------

    /// `(ticks, micros)` currently queued.
    pub fn pending(&self) -> (usize, usize) {
        (self.ticks.len(), self.micros.len())
    }

    /// True while a checkpoint is draining.
    pub fn in_checkpoint(&self) -> bool {
        self.in_checkpoint
    }

    pub fn checkpoints_run(&self) -> u64 {
        self.checkpoints
    }

    pub fn total_jobs(&self) -> u64 {
        self.total_jobs
    }

    pub fn dropped_on_shutdown(&self) -> u64 {
        self.dropped_on_shutdown
    }

    pub fn events(&self) -> &[Event] {
        &self.events
    }

    pub fn take_events(&mut self) -> Vec<Event> {
        std::mem::take(&mut self.events)
    }
}

impl Drop for Scheduler {
    fn drop(&mut self) {
        // Job bodies own engine handles in the real runtime; dropping the queues releases them.
        self.ticks.clear();
        self.micros.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn stop_breaks_the_drain_without_flushing_rejections() {
        let mut scheduler = Scheduler::new();
        let stop = scheduler.stop_handle();
        let seen = Rc::new(Cell::new(0));

        let seen_job = seen.clone();
        scheduler.queue_microtask("first", move |s| {
            seen_job.set(seen_job.get() + 1);
            s.request_stop();
            Ok(())
        });
        let seen_after = seen.clone();
        scheduler.queue_microtask("second", move |_| {
            seen_after.set(seen_after.get() + 1);
            Ok(())
        });
        scheduler.reject(PromiseKey(1), "r");

        assert!(matches!(
            scheduler.checkpoint(),
            Checkpoint::Stopped { jobs: 1 }
        ));
        assert_eq!(seen.get(), 1);
        assert_eq!(scheduler.pending(), (0, 1));
        assert!(!scheduler
            .events()
            .iter()
            .any(|event| matches!(event, Event::UnhandledRejection { .. })));

        // The handle is shared with the runtime; flipping it back resumes.
        stop.set(false);
    }

    #[test]
    fn rejection_handled_is_deferred_to_the_flush() {
        let mut scheduler = Scheduler::new();
        scheduler.reject(PromiseKey(7), "r");
        scheduler.checkpoint();
        assert!(matches!(
            scheduler.events().last(),
            Some(Event::UnhandledRejection { .. })
        ));

        scheduler.queue_tick("attach", |s| {
            assert_eq!(s.handle(PromiseKey(7)), HandleOutcome::Reported);
            assert!(!s
                .events()
                .iter()
                .any(|event| matches!(event, Event::RejectionHandled { .. })));
            Ok(())
        });
        scheduler.checkpoint();

        assert!(matches!(
            scheduler.events().last(),
            Some(Event::RejectionHandled { promise }) if *promise == PromiseKey(7)
        ));
    }

    #[test]
    fn uncaught_carries_structured_error_info() {
        let mut scheduler = Scheduler::new();
        scheduler.queue_microtask("throws", |_| Err(ErrorInfo::message("boom")));
        scheduler.checkpoint();

        let event = scheduler.events().first().expect("event");
        match event {
            Event::Uncaught { error, .. } => {
                assert_eq!(error.name, "Error");
                assert_eq!(error.message, "boom");
                assert_eq!(error.body(), "Error: boom");
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn macrotask_errors_are_reported_inline() {
        let mut scheduler = Scheduler::new();
        scheduler.run_macrotask("setTimeout", Origin::Timer, |_| {
            Err(ErrorInfo::message("timer-boom"))
        });
        assert_eq!(
            scheduler.events(),
            &[Event::Uncaught {
                job: 0,
                origin: Origin::Timer,
                error: ErrorInfo::message("timer-boom"),
            }]
        );
        assert!(!scheduler.in_checkpoint());
        assert_eq!(scheduler.total_jobs(), 1);
    }

    #[test]
    fn budget_does_not_trip_when_the_budget_is_exactly_the_work() {
        let mut scheduler = Scheduler::new();
        scheduler.set_budget(Budget::jobs(2));
        scheduler.queue_microtask("a", |_| Ok(()));
        scheduler.queue_microtask("b", |_| Ok(()));
        assert_eq!(scheduler.checkpoint(), Checkpoint::Drained { jobs: 2 });
    }

    #[test]
    fn wall_clock_budget_uses_the_injected_clock() {
        use std::time::Instant;

        let base = Instant::now();
        let ticks = Rc::new(Cell::new(0u64));
        let clock = {
            let ticks = ticks.clone();
            move || base + Duration::from_millis(ticks.get())
        };
        let mut scheduler = Scheduler::new();
        scheduler.set_clock(clock);
        scheduler.set_budget(Budget {
            max_jobs_per_checkpoint: None,
            max_wall_per_checkpoint: Some(Duration::from_millis(10)),
        });
        for _ in 0..10 {
            let ticks = ticks.clone();
            scheduler.queue_microtask("slow", move |_| {
                ticks.set(ticks.get() + 4);
                Ok(())
            });
        }
        assert!(matches!(
            scheduler.checkpoint(),
            Checkpoint::BudgetExceeded { .. }
        ));
    }
}
