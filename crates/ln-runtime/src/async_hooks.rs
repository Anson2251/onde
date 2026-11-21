//! `async_hooks` identity: async ids, the execution context, and the bridge to JavaScript.
//!
//! Node's `async_hooks` needs three things from the engine that an unpatched quickjs-ng cannot
//! provide: an id per promise, a way to know which promise a queued reaction belongs to, and a
//! hook that fires when the promise settles. M6's engine patch supplies all three
//! (`docs/engine-patch.md`), so this module is mostly bookkeeping:
//!
//! * **Ids.** One monotonic `i64` sequence per isolate. `1` is the root (the top-level script),
//!   which is what Node reports as `executionAsyncId()` outside any resource. New resources get
//!   `2, 3, ...`. Ids are allocated even when no hook is enabled so that a hook enabled later
//!   still sees stable, monotonic ids for the promises that already exist.
//!
//! * **The execution context.** `current` is the async id of whatever is running: the root at
//!   top level, a timer's id inside its callback, a promise's id inside its reaction job. Every
//!   entry point that runs user JavaScript brackets the call with [`AsyncTracker::enter`] and
//!   [`AsyncTracker::leave`], which emit `before`/`after` and move `current`. This is the whole
//!   of `executionAsyncId()`.
//!
//! * **Event dispatch.** `init`, `before`, `after`, `destroy` and `promiseResolve` are pushed to
//!   `js/lib/async_hooks.js` through the `__ln_async_event` global. The JavaScript side owns the
//!   hook list, the `AsyncLocalStorage` store table and the `AsyncResource` surface; Rust never
//!   decides what a hook means. Delivery only happens once JavaScript asked for it
//!   (`set_enabled`), so a program that never imports `async_hooks` pays for an id and a tag
//!   write per promise and nothing else.
//!
//! Event ordering is synchronous: `init` fires at creation, inside the enclosing job, before the
//! creator continues. Buffering and flushing later would be cheaper but observable, and the
//! `async_hooks` contract is all about observable order.
//!
//! # Failure mode
//!
//! A throwing hook must not corrupt the calling job. The exception is caught, converted to
//! [`ErrorInfo`] and parked in [`AsyncTracker::take_errors`]; the runtime reports it through
//! `uncaughtException` at the next safe point, which is Node's "throw out of the hook" outcome
//! without unwinding through the engine's C frames.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use ln_engine::{js, CaughtError, Engine};
use ln_sched::ErrorInfo;

use crate::info_from_caught;

/// `__ln_async_event` kinds. Kept in lockstep with `js/lib/async_hooks.js`.
pub(crate) const EVENT_INIT: i64 = 0;
pub(crate) const EVENT_BEFORE: i64 = 1;
pub(crate) const EVENT_AFTER: i64 = 2;
pub(crate) const EVENT_DESTROY: i64 = 3;
pub(crate) const EVENT_RESOLVE: i64 = 4;

// Subscription mask: bit `n` means "JavaScript wants event kind `n`" (see the `EVENT_*` values).
// Rust skips both the JS crossing and the argument conversion for kinds nobody listens to, so a
// program that imports `async_hooks` but only hooks `destroy` pays nothing per promise.

/// The id Node reports for code running outside any asynchronous resource.
pub(crate) const ROOT_ID: i64 = 1;

/// One recorded creation site, for `--async-stack-traces`.
struct Frame {
    /// `name (file:line:col)` of the frame that created the resource.
    text: String,
    /// The id that caused it, so the chain can be walked backwards.
    trigger: i64,
}

/// Per-isolate `async_hooks` state. Never shared between threads: ids belong to one engine.
pub(crate) struct AsyncTracker {
    next_id: Cell<i64>,
    /// The async id of the code currently running (see the module docs).
    current: Cell<i64>,
    /// Bitmask of event kinds JavaScript subscribed to (`WANT_*`). Zero means nothing is
    /// dispatched: the promise hook is then just an id counter and a tag write.
    wants: Cell<u32>,
    /// The `__ln_async_event` dispatcher, pinned on first use. A per-event global lookup costs
    /// more than the event itself at 1M promises.
    ///
    /// Restored (not cloned) on each event: `Persistent::restore` is the only safe way, and it is
    /// still much cheaper than resolving a global. Cleared in `Isolate::drop` before the engine
    /// goes away, because a persistent handle must never outlive its runtime.
    dispatch: RefCell<Option<js::Persistent<js::Function<'static>>>>,
    /// Exceptions thrown by a hook, reported by the runtime at the next safe point.
    errors: RefCell<Vec<ErrorInfo>>,
    /// `init` events delivered, for `--trace-events` and the leak tests.
    inits: Cell<u64>,
    /// True when `--async-stack-traces` asked for creation sites to be recorded.
    async_stacks: Cell<bool>,
    /// id -> creation site, recorded only while `async_stacks` is on.
    frames: RefCell<HashMap<i64, Frame>>,
    /// True once the engine hooks are installed (see `start_tracking`).
    started: Cell<bool>,
    /// Previous `current` for each async-function body currently on the stack. Node runs an
    /// async function's body as the function's own promise; quickjs announces the body through
    /// the async-function hook, and this stack is what makes the switch reversible.
    async_scope: RefCell<Vec<i64>>,
}

/// Install the engine hooks that give `async_hooks` its identity.
///
/// Called once at isolate setup. The hooks are installed eagerly because rquickjs owns the
/// runtime borrow while JavaScript runs, so they cannot be added from a host function later; they
/// are *inert* until [`AsyncTracker::start`], which is what `node:async_hooks` calls when it is
/// first evaluated. An installed hook that returns immediately costs one C-to-Rust call per
/// promise — measured as noise against promise creation.
pub(crate) fn install_engine_hooks(engine: &Rc<Engine>, tracker: &Rc<AsyncTracker>) {
    // Promise INIT/RESOLVE are the only promise-hook types that matter here: quickjs-ng emits
    // BEFORE/AFTER only around thenable adoption, while Node's per-job pair belongs to the job
    // runner, which knows the tag the job carries.
    {
        let tracker = tracker.clone();
        let engine_ref = engine.clone();
        engine.set_promise_hook(move |ctx, kind, promise, parent| {
            if !tracker.is_started() {
                return;
            }
            match kind {
                js::promise::PromiseHookType::Init => {
                    tracker.promise_init(&ctx, &engine_ref, &promise, &parent);
                }
                js::promise::PromiseHookType::Resolve => {
                    tracker.resolve(&ctx, &engine_ref, &promise);
                }
                _ => {}
            }
        });
    }
    // An async function's body runs as that function's own promise, not as its caller.
    {
        let tracker = tracker.clone();
        engine.set_async_function_hook(move |tag, entering| {
            if !tracker.is_started() {
                return;
            }
            if entering {
                tracker.enter_async_function(tag);
            } else {
                tracker.leave_async_function();
            }
        });
    }
}

impl AsyncTracker {
    pub(crate) fn new() -> Rc<Self> {
        Rc::new(AsyncTracker {
            next_id: Cell::new(ROOT_ID + 1),
            current: Cell::new(ROOT_ID),
            wants: Cell::new(0),
            dispatch: RefCell::new(None),
            errors: RefCell::new(Vec::new()),
            inits: Cell::new(0),
            async_stacks: Cell::new(false),
            frames: RefCell::new(HashMap::new()),
            async_scope: RefCell::new(Vec::new()),
            started: Cell::new(false),
        })
    }

    /// The async id of the running code (`executionAsyncId()`).
    pub(crate) fn current(&self) -> i64 {
        self.current.get()
    }

    /// Subscribe to (or unsubscribe from) event kinds. Ids keep being allocated either way.
    pub(crate) fn set_wants(&self, mask: u32) {
        self.wants.set(mask);
    }

    /// Release the pinned dispatcher. Called from `Isolate::drop`, before the engine is dropped:
    /// a persistent value outliving its runtime aborts the process when the runtime frees.
    pub(crate) fn forget_dispatch(&self) {
        // Dropping the `Persistent` is what releases the reference in the engine.
        self.dispatch.borrow_mut().take();
    }

    /// True when a kind is subscribed. Used by callers to skip building arguments.
    fn wants(&self, kind: i64) -> bool {
        self.wants.get() & (1 << kind) != 0
    }

    pub(crate) fn inits(&self) -> u64 {
        self.inits.get()
    }

    /// Begin minting ids and tracking the execution context. Called when `node:async_hooks` is
    /// first loaded; until then every hook below is a no-op. Idempotent.
    pub(crate) fn start(&self) {
        self.started.set(true);
    }

    pub(crate) fn is_started(&self) -> bool {
        self.started.get()
    }

    /// An async function's body started for the promise tagged `tag`.
    ///
    /// `current` becomes that id for the duration of the body, which is what Node reports inside
    /// an `async` function and what makes a promise created there inherit the right trigger.
    pub(crate) fn enter_async_function(&self, tag: i64) {
        if !self.started.get() {
            return;
        }
        let previous = self.current.get();
        self.async_scope.borrow_mut().push(previous);
        if tag > 0 {
            self.current.set(tag);
        }
    }

    /// The body yielded or returned. Restores whatever was running before it.
    pub(crate) fn leave_async_function(&self) {
        if !self.started.get() {
            return;
        }
        if let Some(previous) = self.async_scope.borrow_mut().pop() {
            self.current.set(previous);
        }
    }

    /// True while at least one async-function body is on the stack.
    fn in_async_function(&self) -> bool {
        !self.async_scope.borrow().is_empty()
    }

    /// Turn on async stack traces. Must be called before the first promise exists: recording
    /// starts with the next `init` and there is no back-fill.
    pub(crate) fn set_async_stacks(&self, enabled: bool) {
        self.async_stacks.set(enabled);
    }

    /// The `    at async ...` lines for the current execution context, oldest last, or `None`.
    ///
    /// Called from the engine while an `Error`'s stack is being built, so it may not run
    /// JavaScript.
    ///
    /// Only promises created *inside an async function body* are recorded, and the recorded frame
    /// is where that function was called (its `await` site). Walking from the running promise up
    /// through its triggers therefore yields the chain of async activations waiting on this one —
    /// the `at async <fn>` lines Node appends. A `.then()` chain at module scope records nothing,
    /// because there is no async activation to name.
    pub(crate) fn render_async_frames(&self) -> Option<String> {
        if !self.async_stacks.get() {
            return None;
        }
        let frames = self.frames.borrow();
        let mut out = String::new();
        let mut id = self.current.get();
        for _ in 0..10 {
            let Some(node) = frames.get(&id) else { break };
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str("    at async ");
            out.push_str(&node.text);
            id = node.trigger;
            if id <= ROOT_ID {
                break;
            }
        }
        if out.is_empty() {
            None
        } else {
            Some(out)
        }
    }

    fn alloc(&self) -> i64 {
        let id = self.next_id.get();
        self.next_id.set(id + 1);
        id
    }

    /// Allocate an id for a host resource and emit its `init`.
    ///
    /// `trigger` is the async id that caused the resource to exist; `None` means "the code that
    /// is running now", which is what every scheduling site in the stdlib wants.
    pub(crate) fn init_resource(
        &self,
        ctx: &js::Ctx<'_>,
        type_name: &str,
        trigger: Option<i64>,
    ) -> i64 {
        let id = self.alloc();
        let trigger = trigger
            .filter(|id| *id > 0)
            .unwrap_or_else(|| self.current.get());
        let undefined = js::Value::new_undefined(ctx.clone());
        self.emit(ctx, EVENT_INIT, id, trigger, type_name, undefined);
        id
    }

    /// Allocate the async id for a promise, tag it, and emit `init`.
    ///
    /// The trigger is the parent promise's id when the promise was created by `.then()`
    /// (quickjs-ng reports the parent only then), otherwise the id of the running code. That is
    /// exactly Node's rule, and it is what makes `triggerAsyncId()` inside a `then` callback point
    /// at the promise whose reaction it is.
    pub(crate) fn promise_init<'js>(
        &self,
        ctx: &js::Ctx<'js>,
        engine: &Engine,
        promise: &js::Value<'js>,
        parent: &js::Value<'js>,
    ) -> i64 {
        let id = self.alloc();
        // The tag is what makes the jobs this promise enqueues carry `id`. Write it even when
        // nothing is listening: a hook enabled later must still see the right `before`.
        engine.set_promise_tag(ctx, promise, id);
        let parent_id = if parent.is_undefined() {
            0
        } else {
            engine.promise_tag(ctx, parent)
        };
        let trigger = if parent_id > 0 {
            parent_id
        } else {
            self.current.get()
        };
        if self.async_stacks.get() && self.in_async_function() {
            // Level 0 is the JavaScript frame creating the promise: the `await` or `then` line in
            // the async function that is running. Node prints exactly that as `at async <fn>`,
            // and only for promises created inside an async function body.
            if let Some(text) = engine.describe_stack_frame(ctx, 0) {
                // Native helpers ("resolve", "then") have no location; they are engine plumbing,
                // not user frames.
                if text.contains(" (") && !text.contains("<lite:") {
                    self.frames.borrow_mut().insert(id, Frame { text, trigger });
                }
            }
        }
        self.emit(ctx, EVENT_INIT, id, trigger, "PROMISE", promise.clone());
        id
    }

    /// Emit `promiseResolve` for a settled promise.
    pub(crate) fn resolve<'js>(
        &self,
        ctx: &js::Ctx<'js>,
        engine: &Engine,
        promise: &js::Value<'js>,
    ) {
        let id = engine.promise_tag(ctx, promise);
        if id > 0 {
            let undefined = js::Value::new_undefined(ctx.clone());
            self.emit(ctx, EVENT_RESOLVE, id, 0, "", undefined);
        }
    }

    /// Enter an async resource: set `current` to `id`, emit `before`, return the previous id.
    ///
    /// The returned value must be handed back to [`AsyncTracker::leave`]. `before` runs with
    /// `executionAsyncId()` already equal to `id`, which is what Node promises.
    pub(crate) fn enter(&self, ctx: &js::Ctx<'_>, id: i64) -> i64 {
        let previous = self.current.get();
        if id <= 0 {
            return previous;
        }
        self.current.set(id);
        self.emit(
            ctx,
            EVENT_BEFORE,
            id,
            0,
            "",
            js::Value::new_undefined(ctx.clone()),
        );
        previous
    }

    /// Leave an async resource: emit `after` while still running as `id`, then restore.
    pub(crate) fn leave(&self, ctx: &js::Ctx<'_>, id: i64, previous: i64) {
        if id > 0 {
            self.emit(
                ctx,
                EVENT_AFTER,
                id,
                0,
                "",
                js::Value::new_undefined(ctx.clone()),
            );
        }
        self.current.set(previous);
    }

    /// Emit `destroy` for a resource that has finished or was collected.
    pub(crate) fn destroy(&self, ctx: &js::Ctx<'_>, id: i64) {
        if id > 0 {
            self.emit(
                ctx,
                EVENT_DESTROY,
                id,
                0,
                "",
                js::Value::new_undefined(ctx.clone()),
            );
        }
    }

    /// Park an error thrown by a hook. Drained by the runtime, never by the hook itself.
    pub(crate) fn take_errors(&self) -> Vec<ErrorInfo> {
        std::mem::take(&mut *self.errors.borrow_mut())
    }

    /// Deliver one event to `__ln_async_event`. A no-op while disabled.
    fn emit<'js>(
        &self,
        ctx: &js::Ctx<'js>,
        kind: i64,
        id: i64,
        trigger: i64,
        type_name: &str,
        resource: js::Value<'js>,
    ) {
        if !self.wants(kind) {
            return;
        }
        let result: js::Result<()> = (|| {
            // Resolve the dispatcher once, then restore the pinned handle per event.
            let mut slot = self.dispatch.borrow_mut();
            if slot.is_none() {
                let found: Option<js::Function> = ctx.globals().get("__ln_async_event")?;
                let Some(found) = found else {
                    // Subscribed before the module installed its dispatcher: nothing to tell yet.
                    return Ok(());
                };
                *slot = Some(js::Persistent::save(ctx, found));
            }
            let dispatch = slot
                .as_ref()
                .expect("just installed")
                .clone()
                .restore(ctx)?;
            dispatch.call::<_, ()>((kind, id, trigger, type_name, self.current.get(), resource))?;
            Ok(())
        })();
        if result.is_ok() {
            if kind == EVENT_INIT {
                self.inits.set(self.inits.get() + 1);
            }
            return;
        }
        // A hook threw. Keep the exception from leaking into the current job and park it for the
        // runtime, which reports it like any other uncaught error.
        let value = ctx.catch();
        let caught: CaughtError = ln_engine::caught_to_owned(ctx, js::CaughtError::Value(value));
        self.errors.borrow_mut().push(info_from_caught(&caught));
    }
}

impl std::fmt::Debug for AsyncTracker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AsyncTracker")
            .field("current", &self.current.get())
            .field("next_id", &self.next_id.get())
            .field("wants", &self.wants.get())
            .field("inits", &self.inits.get())
            .finish_non_exhaustive()
    }
}
