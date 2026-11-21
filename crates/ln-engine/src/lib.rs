//! Safe engine boundary for onde.
//!
//! This crate owns the [`rquickjs`] `Runtime`/`Context` pair and exposes the small surface the
//! runtime needs. It deliberately contains **no Node semantics**: no globals are installed here,
//! and it never decides when microtasks run.
//!
//! # The job queue (M6)
//!
//! Since M6 the engine does not own its pending jobs: the vendored quickjs-ng patch offers every
//! job to [`Engine`] through the hook in [`jobs`], together with an opaque handle and an `int64_t`
//! tag. The tag is where `async_hooks` identity comes from (a promise reaction job inherits the
//! settled promise's tag, see `docs/engine-patch.md`).
//!
//! The runtime moves the queue with [`Engine::run_next_job`], one job at a time, from exactly one
//! place: the scheduler pump body in `ln-runtime` (invariant I1 in ADR-0002). The engine's own
//! `rt->job_list` is never used; [`Engine::has_jobs`] asserts that in debug builds.
//!
//! # Unsafe
//!
//! The safe rquickjs API covers everything except the patch's job and promise-tag entry points,
//! which are declared in [`ffi`] and wrapped here. Every `unsafe` block names the invariant it
//! relies on; the queue's ownership rules live in [`jobs`].

use std::cell::Cell;
use std::fmt;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

pub use rquickjs as js;

use js::context::EvalOptions;
use js::Ctx;

mod ffi;
mod jobs;

pub mod sab;
pub mod serialize;

use jobs::JobQueue;

pub use serialize::{deserialize, detach_buffer, serialize, SerializeError, Serialized};

/// Result of evaluating a script.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Completion {
    /// The script's completion value was `undefined` (the common case for a file).
    Undefined,
    /// `String(value)` of the completion value, produced with JavaScript's own ToString.
    Value(String),
}

/// Outcome of one engine job step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PumpOutcome {
    /// One job ran without throwing. `tag` is the async id the job carried (0 when the host never
    /// tagged it, e.g. an engine-internal dynamic-import job).
    Executed { tag: i64 },
    /// Nothing was pending.
    Idle,
    /// The job threw. The engine exception was taken and cleared.
    Threw { tag: i64, error: CaughtError },
}

/// A caught JavaScript exception, converted to owned data at the engine boundary.
///
/// The runtime formats this; the engine does not decide what stderr looks like.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaughtError {
    /// `error.name` for an `Error` instance, `"Error"` otherwise.
    pub name: String,
    /// `error.message` for an `Error` instance, `String(value)` for a thrown primitive.
    pub message: String,
    /// `error.stack` when the thrown value has one (QuickJS formats frames, not the header).
    pub stack: Option<String>,
    /// `String(value)` of the thrown value, always populated.
    pub display: String,
    /// True when the thrown value was an `Error`-like object.
    pub is_error: bool,
    /// `error.code` when it is a string (Node's `ERR_*`/`ENOENT`-style codes).
    ///
    /// Boxed so the owned error stays under clippy's `result_large_err` threshold: every
    /// scheduler result carries an `ErrorInfo`, and codes are short.
    pub code: Option<Box<str>>,
}

impl CaughtError {
    /// Render `name: message` (or the thrown primitive) plus frames, without the location header.
    /// The runtime owns the final layout; this is the shared body used for both top-level and
    /// per-job errors.
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

/// Why the engine could not be created.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InitError(pub String);

impl fmt::Display for InitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for InitError {}

/// One `JSRuntime` + one main `JSContext`, owned together.
///
/// One engine per isolate thread. It is intentionally not `Send`: QuickJS values are
/// runtime-local and an isolate must stay on its thread (ADR-0003).
pub struct Engine {
    runtime: js::Runtime,
    context: js::Context,
    /// The raw runtime, for the patched entry points that take it directly. Derived from the
    /// context at construction and valid until `runtime` is dropped.
    raw: *mut ffi::JSRuntime,
    /// The installed async-stack hook, reclaimed by `Drop`.
    async_stack_hook: std::cell::Cell<*mut AsyncStackHookCell>,
    /// The installed async-function hook, reclaimed by `Drop`.
    async_function_hook: std::cell::Cell<*mut AsyncFunctionHookCell>,
    /// Pending engine jobs, owned by this engine (see [`jobs`]).
    queue: Rc<JobQueue>,
    /// Wall-clock deadline for cooperative interruption (`--microtask-timeout`). The interrupt
    /// handler checks this and aborts bytecode with the engine's internal error.
    deadline: Rc<Cell<Option<Instant>>>,
    /// Set by the interrupt handler when it aborted a job. The runtime turns this into a budget
    /// failure instead of an `uncaughtException`.
    interrupted: Rc<Cell<bool>>,
    /// Set by the worker's parent to stop the isolate cooperatively (ADR-0008 §2.7). Shared with
    /// the interrupt handler, so it is visible even while bytecode is running.
    cancelled: Arc<AtomicBool>,
}

impl Engine {
    /// Create a runtime and a full-intrinsics context.
    pub fn new() -> Result<Self, InitError> {
        Self::new_with_cancel(Arc::new(AtomicBool::new(false)))
    }

    /// Create an engine whose interrupt handler also trips when `cancelled` is set.
    ///
    /// Worker threads pass the token the parent will flip on `terminate()` (ADR-0008 §2.7). The
    /// token is checked alongside the microtask deadline, so a worker in a tight JS loop stops at
    /// the next bytecode safepoint.
    pub fn new_with_cancel(cancelled: Arc<AtomicBool>) -> Result<Self, InitError> {
        let runtime = js::Runtime::new().map_err(|e| InitError(format!("create runtime: {e}")))?;
        let context =
            js::Context::full(&runtime).map_err(|e| InitError(format!("create context: {e}")))?;

        // SharedArrayBuffer support and blocking atomics are process-wide engine settings; they
        // must be installed before any JavaScript can construct a buffer (ADR-0008 §2.3, §2.4).
        context.with(|ctx| sab::install(&ctx));

        // Take the job queue before anything can enqueue a job: every later `await`/`then` lands
        // in `queue`, so the engine's internal list stays empty for the whole isolate lifetime.
        let raw = context.with(|ctx| {
            // SAFETY: `ctx` is live and belongs to `runtime`; `JS_GetRuntime` only reads it.
            unsafe { js::qjs::JS_GetRuntime(ctx.as_raw().as_ptr()) }
        });
        let queue = JobQueue::new(raw);
        queue.install();

        let deadline: Rc<Cell<Option<Instant>>> = Rc::new(Cell::new(None));
        let interrupted = Rc::new(Cell::new(false));
        {
            let deadline = deadline.clone();
            let interrupted = interrupted.clone();
            let cancelled = cancelled.clone();
            runtime.set_interrupt_handler(Some(Box::new(move || {
                if cancelled.load(Ordering::SeqCst) {
                    interrupted.set(true);
                    return true;
                }
                match deadline.get() {
                    Some(deadline) if Instant::now() >= deadline => {
                        interrupted.set(true);
                        true
                    }
                    _ => false,
                }
            })));
        }

        Ok(Self {
            runtime,
            context,
            raw,
            async_stack_hook: std::cell::Cell::new(std::ptr::null_mut()),
            async_function_hook: std::cell::Cell::new(std::ptr::null_mut()),
            queue,
            deadline,
            interrupted,
            cancelled,
        })
    }

    /// The cooperative-cancel token shared with the worker's parent.
    pub fn cancel_token(&self) -> Arc<AtomicBool> {
        self.cancelled.clone()
    }

    /// True once the parent asked this isolate to stop.
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// Install the engine's promise rejection tracker.
    ///
    /// The callback fires twice for a rejection that survives: once at settle with
    /// `is_handled = false` (a candidate, not yet "unhandled") and once when a handler is
    /// attached with `is_handled = true`. The runtime forwards both to its rejection table.
    pub fn set_rejection_tracker<F>(&self, tracker: F)
    where
        F: for<'js> Fn(Ctx<'js>, js::Value<'js>, js::Value<'js>, bool) + 'static,
    {
        self.runtime
            .set_host_promise_rejection_tracker(Some(Box::new(tracker)));
    }

    /// Set (or clear) the cooperative deadline checked by the interrupt handler.
    ///
    /// The handler is consulted by the engine while executing bytecode; when it trips, the
    /// current job aborts with an internal, uncatchable error and [`Engine::take_interrupted`]
    /// returns true.
    pub fn set_interrupt_deadline(&self, deadline: Option<Instant>) {
        self.deadline.set(deadline);
    }

    /// Read and clear the interrupt flag.
    pub fn take_interrupted(&self) -> bool {
        self.interrupted.replace(false)
    }

    pub fn is_interrupted(&self) -> bool {
        self.interrupted.get()
    }

    /// Run `f` with the main context. All JS access goes through here.
    pub fn with_ctx<R>(&self, f: impl FnOnce(Ctx<'_>) -> R) -> R {
        self.context.with(f)
    }

    /// Evaluate `source` as a **classic script** (global code, sloppy mode) with `filename` used
    /// for stack traces.
    ///
    /// On success the completion value is converted with JavaScript's `ToString`; on failure the
    /// exception is consumed and returned as owned data, never left pending.
    pub fn eval_global(&self, source: &str, filename: &str) -> Result<Completion, CaughtError> {
        self.with_ctx(|ctx| {
            let mut options = js::context::EvalOptions::default();
            options.global = true;
            // rquickjs defaults to strict; Node's classic scripts are sloppy unless they opt in.
            options.strict = false;
            options.filename = Some(filename.to_owned());

            match js::CatchResultExt::catch(
                ctx.eval_with_options::<js::Value, _>(source, options),
                &ctx,
            ) {
                Ok(value) if value.is_undefined() => Ok(Completion::Undefined),
                Ok(value) => Ok(Completion::Value(stringify(&ctx, value))),
                Err(error) => Err(caught_to_owned(&ctx, error)),
            }
        })
    }

    /// Install the engine's module loader (ESM resolution + source loading).
    ///
    /// The resolver and loader are the runtime's: `ln-engine` only forwards them to QuickJS.
    /// They must stay on this thread; the engine keeps them for the life of the runtime.
    pub fn set_module_loader<R, L>(&self, resolver: R, loader: L)
    where
        R: js::loader::Resolver + 'static,
        L: js::loader::Loader + 'static,
    {
        self.runtime.set_loader(resolver, loader);
    }

    /// Compile and evaluate an ES module.
    ///
    /// The module name is the canonical name the loader assigned (`file:///...` or `node:path`),
    /// so `import.meta.url` and nested imports agree with the resolver. `filename`/`dirname` fill
    /// `import.meta` for disk modules; `is_main` marks the entry point.
    ///
    /// Evaluation errors are returned as owned data, never left pending. A module using
    /// top-level-await returns immediately; its settlement is observed through the normal promise
    /// queue (and therefore reported like any other unhandled rejection if it rejects).
    pub fn eval_module(
        &self,
        source: &str,
        name: &str,
        filename: Option<&str>,
        dirname: Option<&str>,
        is_main: bool,
    ) -> Result<(), CaughtError> {
        self.with_ctx(|ctx| {
            let source = strip_source_prefix(source);
            let declared = match js::Module::declare(ctx.clone(), name, source) {
                Ok(module) => module,
                Err(error) => return Err(caught_from_error(&ctx, error)),
            };

            if let Ok(meta) = declared.meta() {
                let _ = meta.set("url", name);
                if let Some(filename) = filename {
                    let _ = meta.set("filename", filename);
                }
                if let Some(dirname) = dirname {
                    let _ = meta.set("dirname", dirname);
                }
                let _ = meta.set("main", is_main);
                if let Ok(resolve) = meta_resolve_function(&ctx, name) {
                    let _ = meta.set("resolve", resolve);
                }
            }

            match declared.eval() {
                Ok(_) => Ok(()),
                Err(error) => Err(caught_from_error(&ctx, error)),
            }
        })
    }

    /// Compile an ES module without evaluating it (`lite --check`).
    pub fn compile_module(&self, source: &str, name: &str) -> Result<(), CaughtError> {
        self.with_ctx(|ctx| {
            let source = strip_source_prefix(source);
            match js::Module::declare(ctx.clone(), name, source) {
                Ok(_) => Ok(()),
                Err(error) => Err(caught_from_error(&ctx, error)),
            }
        })
    }

    /// Compile a CommonJS wrapper without evaluating the function body (`lite --check`).
    pub fn compile_cjs(&self, source: &str, filename: &str) -> Result<(), CaughtError> {
        let wrapped = cjs_wrapper(source);
        self.with_ctx(|ctx| {
            let mut options = EvalOptions::default();
            options.global = true;
            options.strict = false;
            options.filename = Some(filename.to_owned());
            // Evaluating the function *expression* compiles the body but never runs it.
            match js::CatchResultExt::catch(
                ctx.eval_with_options::<js::Value, _>(wrapped, options),
                &ctx,
            ) {
                Ok(_) => Ok(()),
                Err(error) => Err(caught_to_owned(&ctx, error)),
            }
        })
    }

    /// Current engine heap usage in bytes (the basis of `process.memoryUsage().heapUsed`).
    pub fn memory_usage(&self) -> usize {
        self.runtime.memory_usage().memory_used_size as usize
    }

    /// Install the engine's promise hook: the only source of `async_hooks` identity.
    ///
    /// The callback fires on promise creation (`INIT`, with the parent promise when there is one)
    /// and at settlement (`RESOLVE`). `BEFORE`/`AFTER` also fire around thenable adoption, but the
    /// runtime ignores them: per-job `before`/`after` belong to the job runner, which knows the
    /// async id the job carries.
    pub fn set_promise_hook<F>(&self, hook: F)
    where
        F: for<'js> Fn(Ctx<'js>, js::promise::PromiseHookType, js::Value<'js>, js::Value<'js>)
            + 'static,
    {
        self.runtime.set_promise_hook(Some(Box::new(hook)));
    }

    /// Install the async-stack hook: called while the engine builds an `Error`'s stack, it
    /// returns the `    at async ...` lines to append (opt-in, `--async-stack-traces`).
    ///
    /// The closure must not run JavaScript: the engine is mid-construction. It only walks the
    /// host's own id table, which is why it can be cheap enough to run for every error.
    pub fn set_async_stack_hook<F>(&self, hook: F)
    where
        F: Fn() -> Option<String> + 'static,
    {
        let cell = Box::into_raw(Box::new(AsyncStackHookCell(Box::new(hook))));
        self.async_stack_hook.set(cell);
        // SAFETY: `raw` is this engine's runtime and `cell` outlives the hook (reclaimed in
        // `Drop`, after the hook is removed).
        unsafe {
            ffi::JS_SetAsyncStackHook(self.raw, Some(async_stack_trampoline), cell as *mut _);
        }
    }

    /// Install the async-function hook: called with `entering = true` when an async function's
    /// body starts and `false` when it yields or returns, with the promise for the invocation.
    ///
    /// This is how the host knows that `current` should be the async function's promise while its
    /// body runs, which is Node's model and what makes `executionAsyncId()` inside an `async`
    /// function report that function rather than its caller.
    pub fn set_async_function_hook<F>(&self, hook: F)
    where
        F: Fn(i64, bool) + 'static,
    {
        let cell = Box::into_raw(Box::new(AsyncFunctionHookCell(Box::new(hook))));
        self.async_function_hook.set(cell);
        // SAFETY: `raw` is this engine's runtime, and `cell` outlives the hook (reclaimed in
        // `Drop`, after the hook is removed).
        unsafe {
            ffi::JS_SetAsyncFunctionHook(self.raw, Some(async_function_trampoline), cell as *mut _);
        }
    }

    /// Describe the JavaScript frame `level` levels above the caller, for async stack traces.
    ///
    /// Returns `name (file:line:col)`, or `None` when the frame is native or absent.
    pub fn describe_stack_frame(&self, ctx: &Ctx<'_>, level: u32) -> Option<String> {
        // SAFETY: `ctx` is this engine's context. The returned buffer is owned by us until it is
        // released with `JS_FreeStackFrameDesc`.
        unsafe {
            let raw = ffi::JS_DescribeStackFrame(ctx.as_raw().as_ptr(), level as i32);
            if raw.is_null() {
                return None;
            }
            let text = std::ffi::CStr::from_ptr(raw).to_string_lossy().into_owned();
            ffi::JS_FreeStackFrameDesc(ctx.as_raw().as_ptr(), raw);
            Some(text)
        }
    }

    /// The host tag attached to a promise, or 0 when it has none (including non-promises).
    pub fn promise_tag(&self, ctx: &Ctx<'_>, promise: &js::Value<'_>) -> i64 {
        // SAFETY: both handles belong to this engine's context, and reading the tag has no side
        // effects (a non-promise reads as 0).
        unsafe { ffi::JS_GetPromiseTag(ctx.as_raw().as_ptr(), promise.as_raw()) }
    }

    /// Attach the host tag that promise reaction jobs will inherit when the promise settles.
    pub fn set_promise_tag(&self, ctx: &Ctx<'_>, promise: &js::Value<'_>, tag: i64) {
        // SAFETY: same as `promise_tag`; writing is dropped for non-promises.
        unsafe { ffi::JS_SetPromiseTag(ctx.as_raw().as_ptr(), promise.as_raw(), tag) }
    }

    /// True when the host queue holds work. `JS_IsJobPending` must stay false: the hook owns
    /// every job, so anything left in the engine's list means the hook was bypassed.
    pub fn has_jobs(&self) -> bool {
        debug_assert!(
            !self.runtime.is_job_pending(),
            "the engine queued a job while the host owns the queue"
        );
        !self.queue.is_empty()
    }

    /// The tag of the next job, without running it. `None` when the queue is empty.
    ///
    /// The runtime reads this first so it can emit `before` for the right async id *before* the
    /// job's JavaScript starts running.
    pub fn next_job_tag(&self) -> Option<i64> {
        self.queue.next_tag()
    }

    /// Execute exactly one pending engine job, in enqueue order.
    ///
    /// This is the only path that runs a job (I1). The runtime wraps it in a scheduler job that
    /// also emits the async-hooks `before`/`after` pair; nothing else may call it.
    pub fn run_next_job(&self) -> PumpOutcome {
        let Some(job) = self.queue.pop() else {
            return PumpOutcome::Idle;
        };
        // SAFETY: `job` came from this engine's hook, has not been run, and is freed immediately
        // after the run whether it threw or not.
        let tag = unsafe { ffi::JS_JobTag(job) };
        debug_assert_eq!(
            unsafe { ffi::JS_JobContext(job) },
            self.context.with(|ctx| ctx.as_raw().as_ptr()),
            "a job from another context reached this engine"
        );
        let ran = self.queue.run(job);
        self.queue.free(job);
        if ran {
            return PumpOutcome::Executed { tag };
        }
        // The job left an exception pending. Taking it here is what keeps it from leaking into
        // the next job; `ctx.catch()` consumes it.
        let error = self.with_ctx(|ctx| {
            let value = ctx.catch();
            caught_from_value(&ctx, value)
        });
        PumpOutcome::Threw { tag, error }
    }

    /// Pending jobs, for diagnostics (`--trace-events`) and the leak assertion at teardown.
    pub fn queued_jobs(&self) -> usize {
        self.queue.len()
    }

    /// Mark `value` as an uncatchable engine error.
    ///
    /// QuickJS skips every JavaScript `catch` block while such an error unwinds, which is what
    /// `process.exit` needs: an application's own `try { ... process.exit(0) } catch (error)`
    /// must not be able to observe the exit as a failure. The error is still visible to the host
    /// (`CaughtError`), and `finally` blocks run as the engine unwinds.
    pub fn set_uncatchable(&self, ctx: &Ctx<'_>, value: &js::Value<'_>) {
        // SAFETY: both values belong to this engine's context, and the mark is a bit on the error
        // object's header. The object stays owned by JavaScript.
        unsafe {
            js::qjs::JS_SetUncatchableError(ctx.as_raw().as_ptr(), value.as_raw());
        }
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        // Order matters: stop routing new jobs to the host, release the ones already adopted,
        // then let the runtime go. Freeing a job touches the runtime's allocator and its values,
        // so it must happen while `self.runtime`/`self.context` are still alive - which they are,
        // because fields are dropped after this body returns.
        let function_hook = self.async_function_hook.replace(std::ptr::null_mut());
        if !function_hook.is_null() {
            // SAFETY: installed by `set_async_function_hook` on this runtime.
            unsafe {
                ffi::JS_SetAsyncFunctionHook(self.raw, None, std::ptr::null_mut());
                drop(Box::from_raw(function_hook));
            }
        }
        let hook = self.async_stack_hook.replace(std::ptr::null_mut());
        if !hook.is_null() {
            // SAFETY: installed by `set_async_stack_hook` on this runtime; cleared before the
            // backing cell is reclaimed.
            unsafe {
                ffi::JS_SetAsyncStackHook(self.raw, None, std::ptr::null_mut());
                drop(Box::from_raw(hook));
            }
        }
        self.queue.uninstall();
        debug_assert!(
            !self.runtime.is_job_pending(),
            "an engine job bypassed the host queue"
        );
        // Releasing a job can run a finalizer, and a finalizer job goes to `rt->job_list` now
        // that the hook is gone; the engine frees those itself (the assertion above ran before
        // that could happen).
        self.queue.clear();
        debug_assert_eq!(
            self.queue.outstanding(),
            0,
            "engine jobs leaked: {} adopted and not freed",
            self.queue.outstanding()
        );
    }
}

impl fmt::Debug for Engine {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Engine")
            .field("queued_jobs", &self.queue.len())
            .finish_non_exhaustive()
    }
}

/// The closure behind the async-stack hook, boxed so the C side can hold a thin pointer to it.
struct AsyncStackHookCell(Box<dyn Fn() -> Option<String>>);

/// The closure behind the async-function hook (same trick).
struct AsyncFunctionHookCell(Box<dyn Fn(i64, bool)>);

/// C entry point for the async-function hook.
unsafe extern "C" fn async_function_trampoline(
    _ctx: *mut ffi::JSContext,
    tag: i64,
    entering: bool,
    opaque: *mut std::ffi::c_void,
) {
    let cell = &*(opaque as *const AsyncFunctionHookCell);
    // A panic may not cross the boundary; a missed context switch is a bug, not a crash.
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        (cell.0)(tag, entering);
    }));
}

/// C entry point for the async-stack hook.
///
/// The returned buffer must use the runtime's allocator (`free` by default), because QuickJS
/// frees it with `js_free`. A panic must not cross the boundary: it becomes "no extra frames".
unsafe extern "C" fn async_stack_trampoline(
    ctx: *mut ffi::JSContext,
    opaque: *mut std::ffi::c_void,
) -> *mut std::os::raw::c_char {
    let cell = &*(opaque as *const AsyncStackHookCell);
    let text = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (cell.0)())) {
        Ok(Some(text)) => text,
        _ => return std::ptr::null_mut(),
    };
    if text.is_empty() {
        return std::ptr::null_mut();
    }
    let bytes = text.as_bytes();
    // SAFETY: the engine frees this with its own allocator, so it must come from `JS_Malloc`.
    unsafe {
        let buffer = ffi::JS_Malloc(ctx, bytes.len() + 1) as *mut u8;
        if buffer.is_null() {
            return std::ptr::null_mut();
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), buffer, bytes.len());
        *buffer.add(bytes.len()) = 0;
        buffer as *mut std::os::raw::c_char
    }
}

/// `String(value)` using the engine's own global function.
///
/// The global (rather than the abstract `ToString` operation) is what the CLI contract says to
/// print, and it is the only form that handles `Symbol()` without throwing.
fn stringify<'js>(ctx: &Ctx<'js>, value: js::Value<'js>) -> String {
    // The runtime installs a formatter (`util.inspect` for objects) so `lite -e '({a:1})'`
    // prints a value, not `[object Object]`. The engine only provides the hook.
    if let Ok(Some(formatter)) = ctx
        .globals()
        .get::<_, Option<js::Function>>("__ln_format_result")
    {
        if let Ok(text) = formatter.call::<_, js::String>((value.clone(),)) {
            if let Ok(text) = text.to_string() {
                return text;
            }
        }
        let _ = ctx.catch();
    }

    let converted = ctx
        .globals()
        .get::<_, js::Function>("String")
        .and_then(|function| function.call::<_, js::String>((value,)));
    match converted {
        Ok(string) => string
            .to_string()
            .unwrap_or_else(|_| "<unprintable>".to_owned()),
        Err(_) => {
            // A throwing `toString`/`Symbol.toPrimitive`. Clear it; the caller still gets text.
            let _ = ctx.catch();
            "<unprintable>".to_owned()
        }
    }
}

pub fn caught_to_owned<'js>(ctx: &Ctx<'js>, error: js::CaughtError<'js>) -> CaughtError {
    match error {
        js::CaughtError::Exception(exception) => {
            let name = exception
                .as_object()
                .get::<_, Option<js::String>>("name")
                .ok()
                .flatten()
                .and_then(|name| name.to_string().ok())
                .unwrap_or_else(|| "Error".to_owned());
            let message = exception.message().unwrap_or_default();
            let stack = exception.stack();
            let code = exception
                .as_object()
                .get::<_, Option<js::String>>("code")
                .ok()
                .flatten()
                .and_then(|code| code.to_string().ok())
                .map(Into::into);
            CaughtError {
                display: if message.is_empty() {
                    name.clone()
                } else {
                    format!("{name}: {message}")
                },
                name,
                message,
                stack,
                is_error: true,
                code,
            }
        }
        js::CaughtError::Value(value) => caught_from_value(ctx, value),
        js::CaughtError::Error(error) => CaughtError {
            name: "Error".to_owned(),
            message: error.to_string(),
            display: error.to_string(),
            stack: None,
            is_error: false,
            code: None,
        },
    }
}

/// The CommonJS wrapper prefix, up to and including the space before the body.
///
/// It stays on line 1 so user line numbers are unchanged (Node's wrapper does the same); the
/// columns of line 1 are shifted by exactly this prefix, which the error renderer subtracts.
pub const CJS_WRAPPER_PREFIX: &str =
    "(function (exports, require, module, __filename, __dirname) { ";

/// Number of JS columns the CJS wrapper adds to line 1 (the prefix is ASCII).
pub fn cjs_wrapper_column_offset() -> usize {
    CJS_WRAPPER_PREFIX.len()
}

/// Strip a UTF-8 BOM and neutralise a leading `#!` line without changing line numbers.
///
/// QuickJS does not accept the hashbang grammar, so the two characters become `//`: the rest of
/// the line is a comment, the line count is unchanged, and stacks still match the file.
pub fn strip_source_prefix(source: &str) -> String {
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    match source.strip_prefix("#!") {
        Some(rest) => format!("//{rest}"),
        None => source.to_owned(),
    }
}

/// The CommonJS wrapper used for every `require`d file.
///
/// The trailing newline protects a trailing `//` comment.
pub fn cjs_wrapper(source: &str) -> String {
    let source = strip_source_prefix(source);
    format!("{CJS_WRAPPER_PREFIX}{source}\n}})")
}

/// Build `import.meta.resolve` for a module whose canonical name is `base`.
pub fn meta_resolve_function<'js>(ctx: &Ctx<'js>, base: &str) -> js::Result<js::Function<'js>> {
    let base = base.to_owned();
    js::Function::new(
        ctx.clone(),
        move |ctx: Ctx<'js>, specifier: String| -> js::Result<String> {
            let helper: js::Function = ctx.globals().get("__ln_meta_resolve")?;
            helper.call((specifier, base.clone()))
        },
    )
}

/// Convert a `js::Error` into owned data, consuming a pending exception when there is one.
fn caught_from_error<'js>(ctx: &Ctx<'js>, error: js::Error) -> CaughtError {
    match error {
        js::Error::Exception => {
            let value = ctx.catch();
            caught_from_value(ctx, value)
        }
        other => CaughtError {
            name: "Error".to_owned(),
            message: other.to_string(),
            display: other.to_string(),
            stack: None,
            is_error: false,
            code: None,
        },
    }
}

fn caught_from_value<'js>(ctx: &Ctx<'js>, value: js::Value<'js>) -> CaughtError {
    let display = stringify(ctx, value.clone());

    // A thrown value can be an `Error` (from a job, or from `throw` inside a callback), in which
    // case the runtime wants name/message/stack rather than `String(value)`. Property access can
    // itself throw (getters), so every read is fallible and the heuristic is "has a stack".
    if let Some(object) = value.as_object() {
        if let Ok(Some(stack)) = object.get::<_, Option<js::String>>("stack") {
            let read = |key: &str| -> Option<String> {
                object
                    .get::<_, Option<js::String>>(key)
                    .ok()
                    .flatten()
                    .and_then(|text| text.to_string().ok())
            };
            return CaughtError {
                name: read("name").unwrap_or_else(|| "Error".to_owned()),
                message: read("message").unwrap_or_default(),
                stack: stack.to_string().ok(),
                display,
                is_error: true,
                code: read("code").map(Into::into),
            };
        }
    }

    CaughtError {
        name: "Uncaught".to_owned(),
        message: display.clone(),
        stack: None,
        display,
        is_error: false,
        code: None,
    }
}
