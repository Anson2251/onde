//! Hand-written declarations for the job-queue patch in `vendor/job-queue-hook.patch`.
//!
//! These symbols are not in the committed `rquickjs-sys` bindings (they are added by the vendored
//! patch), so they are declared here instead of running bindgen. The signatures mirror
//! `vendor/rquickjs-sys/quickjs/quickjs.h` exactly; `JSValue` is the binding's `#[repr(C)]` struct,
//! so passing it by value matches the C ABI.
//!
//! Everything here is `unsafe`: a raw pointer from the wrong runtime, a job run twice, or a job
//! freed while the runtime is gone is undefined behaviour. The only caller is [`crate::jobs`],
//! which owns the invariants:
//!
//! * one [`RuntimePtr`] per live [`crate::Engine`], derived from its context;
//! * a job is run at most once and freed exactly once, by this crate;
//! * the hook is uninstalled before the runtime is dropped.

use rquickjs::qjs;

pub(crate) use qjs::{JSContext, JSRuntime, JSValue};

/// The engine's opaque job handle (`struct JSJob *`).
pub(crate) type JSJobPtr = *mut std::ffi::c_void;

/// Return `true` to take ownership of `job`, `false` to let the engine queue it.
pub(crate) type JobQueueHook =
    unsafe extern "C" fn(rt: *mut JSRuntime, job: JSJobPtr, opaque: *mut std::ffi::c_void) -> bool;

extern "C" {
    pub(crate) fn JS_SetJobQueueHook(
        rt: *mut JSRuntime,
        hook: Option<JobQueueHook>,
        opaque: *mut std::ffi::c_void,
    );

    pub(crate) fn JS_JobContext(job: JSJobPtr) -> *mut JSContext;
    pub(crate) fn JS_JobTag(job: JSJobPtr) -> i64;
    /// Tag a job the host created itself (rather than one the engine tagged from a promise).
    /// Part of the patch's public surface; onde's jobs all come from promises today, so this is
    /// unused until a host task needs its own async id.
    #[allow(dead_code)]
    pub(crate) fn JS_JobSetTag(job: JSJobPtr, tag: i64);

    /// 1 = ran, -1 = exception pending in `*pctx`.
    pub(crate) fn JS_JobRun(rt: *mut JSRuntime, job: JSJobPtr, pctx: *mut *mut JSContext) -> i32;
    pub(crate) fn JS_JobFree(rt: *mut JSRuntime, job: JSJobPtr);

    pub(crate) fn JS_SetPromiseTag(ctx: *mut JSContext, promise: JSValue, tag: i64);
    pub(crate) fn JS_GetPromiseTag(ctx: *mut JSContext, promise: JSValue) -> i64;

    /// One stack frame as "name (file:line:col)"; NULL when there is no JS frame at `level`.
    pub(crate) fn JS_DescribeStackFrame(
        ctx: *mut JSContext,
        level: i32,
    ) -> *mut std::os::raw::c_char;
    /// Free a buffer returned by `JS_DescribeStackFrame`.
    pub(crate) fn JS_FreeStackFrameDesc(ctx: *mut JSContext, desc: *mut std::os::raw::c_char);

    /// The runtime's allocator. Host buffers handed back to the engine must use these.
    pub(crate) fn JS_Malloc(ctx: *mut JSContext, size: usize) -> *mut std::ffi::c_void;
    /// Release a buffer from `JS_Malloc`. Kept next to it: the pair is the allocation contract
    /// for host buffers the engine takes ownership of.
    #[allow(dead_code)]
    pub(crate) fn JS_Free(ctx: *mut JSContext, ptr: *mut std::ffi::c_void);

    /// Called while an Error's stack is being built; returns an owned NUL-terminated block to
    /// append, allocated with the runtime's allocator (freed by the engine).
    pub(crate) fn JS_SetAsyncStackHook(
        rt: *mut JSRuntime,
        hook: Option<AsyncStackHook>,
        opaque: *mut std::ffi::c_void,
    );
}

pub(crate) type AsyncStackHook = unsafe extern "C" fn(
    ctx: *mut JSContext,
    opaque: *mut std::ffi::c_void,
) -> *mut std::os::raw::c_char;

extern "C" {
    /// Called around every async-function body with the promise for the invocation.
    pub(crate) fn JS_SetAsyncFunctionHook(
        rt: *mut JSRuntime,
        hook: Option<AsyncFunctionHook>,
        opaque: *mut std::ffi::c_void,
    );
}

pub(crate) type AsyncFunctionHook = unsafe extern "C" fn(
    ctx: *mut JSContext,
    tag: i64,
    entering: bool,
    opaque: *mut std::ffi::c_void,
);
