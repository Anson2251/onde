//! Shared-memory allocation for `SharedArrayBuffer` across isolates (ADR-0008 §2.3).
//!
//! QuickJS does not implement a `SharedArrayBuffer` allocator itself: unless
//! `JS_SetSharedArrayBufferFunctions` installs one, `new SharedArrayBuffer(n)` throws. The
//! allocator is process-global because the whole point is that buffers created by one runtime
//! remain valid in another, on another thread, for as long as any isolate holds a reference.
//!
//! # Ownership
//!
//! Every allocation is a refcounted block: a fixed-size header followed by the payload. The
//! engine calls `sab_alloc` once for a new buffer and `sab_free` from the finalizer; a clone
//! (a buffer reconstructed by `JS_ReadObject2`, or a message taking its own reference) calls
//! `sab_dup`. The count is atomic because two isolates can drop their references concurrently.
//!
//! The hooks are `extern "C"`: a panic unwinding through them would abort the process, so they
//! use `libc::malloc`/`libc::free` and contain no Rust allocations, no `Vec`, and no panics. The
//! only Rust state they touch is a diagnostic counter used by tests.
//!
//! # Why the header is 16 bytes
//!
//! `libc::malloc` returns memory aligned for any fundamental type. Placing the payload one
//! 16-byte header after the block keeps that alignment, so a `Float64Array`/`BigInt64Array` view
//! over the buffer is always naturally aligned on every platform onde supports.

use std::ffi::c_void;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

use crate::js;

/// Header size in bytes. Larger than the 8-byte refcount so the payload keeps 16-byte alignment.
const HEADER_SIZE: usize = 16;

/// The refcount header that precedes every shared allocation.
#[repr(C)]
struct Header {
    refs: AtomicU64,
}

/// Allocations currently alive (diagnostics and tests only).
static LIVE: AtomicUsize = AtomicUsize::new(0);

/// Serializes tests that assert on the process-global allocation count (only the count is global;
/// the engine itself is per-test).
#[cfg(test)]
pub(crate) static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Shared-memory blocks currently alive in this process.
///
/// Each block is counted once, regardless of how many isolates hold a reference to it.
pub fn live_allocations() -> usize {
    LIVE.load(Ordering::SeqCst)
}

unsafe extern "C" fn allocate(_opaque: *mut c_void, size: js::qjs::size_t) -> *mut c_void {
    let size = match usize::try_from(size) {
        Ok(size) => size,
        Err(_) => return std::ptr::null_mut(),
    };
    let Some(total) = HEADER_SIZE.checked_add(size) else {
        return std::ptr::null_mut();
    };
    // SAFETY: `malloc` has no preconditions beyond a non-zero-ish size; `total` is a checked
    // usize and cannot overflow. The header is written before the pointer is exposed.
    let base = unsafe { libc::malloc(total) } as *mut Header;
    if base.is_null() {
        return std::ptr::null_mut();
    }
    // SAFETY: the allocation is `total` bytes and `base` points at its start.
    unsafe {
        (*base).refs = AtomicU64::new(1);
        let payload = (base as *mut u8).add(HEADER_SIZE);
        std::ptr::write_bytes(payload, 0, size);
        LIVE.fetch_add(1, Ordering::SeqCst);
        payload.cast()
    }
}

/// The header for a payload pointer. `ptr` is always one returned by `allocate`.
unsafe fn header_of(ptr: *mut c_void) -> *mut Header {
    // SAFETY: the caller guarantees `ptr` came from `allocate`, which places the payload exactly
    // `HEADER_SIZE` bytes after the header.
    unsafe { (ptr as *mut u8).sub(HEADER_SIZE) as *mut Header }
}

unsafe extern "C" fn release(_opaque: *mut c_void, ptr: *mut c_void) {
    if ptr.is_null() {
        return;
    }
    // SAFETY: see `header_of`; the hook is only called with pointers from `allocate`.
    let base = unsafe { header_of(ptr) };
    // SAFETY: the header is initialized by `allocate` and lives until the last release.
    let previous = unsafe { (*base).refs.fetch_sub(1, Ordering::SeqCst) };
    if previous == 1 {
        // SAFETY: this was the last reference; both the header and the payload were allocated as
        // one `malloc` block, so the header address is the block address.
        unsafe {
            libc::free(base as *mut c_void);
            LIVE.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

unsafe extern "C" fn duplicate(_opaque: *mut c_void, ptr: *mut c_void) {
    if ptr.is_null() {
        return;
    }
    // SAFETY: see `header_of`; a duplicate is only requested while at least one reference exists.
    let base = unsafe { header_of(ptr) };
    // SAFETY: as above; an overflow would need 2^64 outstanding messages, not a real case.
    unsafe {
        (*base).refs.fetch_add(1, Ordering::SeqCst);
    }
}

/// Install the allocator and enable blocking atomics on this runtime.
///
/// Called once per engine, after the context exists and before any JavaScript runs. Every runtime
/// in the process (main isolate and workers) gets the same hooks; the buffer memory is shared, the
/// hooks are not per-runtime state.
pub fn install(ctx: &js::Ctx<'_>) {
    // SAFETY: the context is live for the duration of the call and belongs to a live runtime; the
    // hooks are `'static` functions with no captured state.
    unsafe {
        let raw = ctx.as_raw().as_ptr();
        let runtime = js::qjs::JS_GetRuntime(raw);
        if runtime.is_null() {
            return;
        }
        js::qjs::JS_SetCanBlock(runtime, true);
        let functions = js::qjs::JSSharedArrayBufferFunctions {
            sab_alloc: Some(allocate),
            sab_free: Some(release),
            sab_dup: Some(duplicate),
            sab_opaque: std::ptr::null_mut(),
        };
        js::qjs::JS_SetSharedArrayBufferFunctions(runtime, &functions);
    }
}

/// One owned reference to a shared allocation.
///
/// A `SabHandle` is the only way a shared block crosses a thread: the block is process-global and
/// its lifetime is the atomic refcount, not any isolate's heap. Mutation is synchronized by the JS
/// program through `Atomics`, exactly Node's contract, so `Send + Sync` is sound here.
#[derive(Debug)]
pub struct SabHandle {
    ptr: *mut u8,
}

// SAFETY: the pointer addresses memory that outlives the handle because the handle owns one
// reference in the process-global refcount. Concurrent access is the JS program's
// responsibility, as with `SharedArrayBuffer` in Node.
unsafe impl Send for SabHandle {}
// SAFETY: as above; sharing the handle only shares the right to release one reference.
unsafe impl Sync for SabHandle {}

impl SabHandle {
    /// Take a new reference to `ptr` and own it.
    ///
    /// # Safety
    ///
    /// `ptr` must be a live payload pointer from this module's allocator.
    pub(crate) unsafe fn duplicate(ptr: *mut u8) -> Self {
        // SAFETY: the caller guarantees the pointer is live; `duplicate` only bumps the count.
        unsafe { duplicate(std::ptr::null_mut(), ptr.cast()) };
        SabHandle { ptr }
    }

    /// The raw payload address, for the engine's SAB table.
    pub fn as_ptr(&self) -> *mut u8 {
        self.ptr
    }
}

impl Drop for SabHandle {
    fn drop(&mut self) {
        // SAFETY: the handle owns exactly one reference, which is released once here.
        unsafe { release(std::ptr::null_mut(), self.ptr.cast()) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Engine;

    #[test]
    fn shared_array_buffer_works_after_install() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let engine = Engine::new().expect("engine");
        let value = engine
            .with_ctx(|ctx| {
                ctx.eval::<f64, _>(
                    "const sab = new SharedArrayBuffer(16); const ta = new Int32Array(sab); \
                     Atomics.store(ta, 0, 41); Atomics.add(ta, 0, 1); Atomics.load(ta, 0)",
                )
            })
            .expect("eval");
        assert_eq!(value, 42.0);
    }

    #[test]
    fn blocking_atomics_are_enabled() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let engine = Engine::new().expect("engine");
        let result = engine
            .with_ctx(|ctx| {
                ctx.eval::<String, _>(
                    "const ta = new Int32Array(new SharedArrayBuffer(4)); \
                     Atomics.wait(ta, 0, 0, 5)",
                )
            })
            .expect("eval");
        assert_eq!(result, "timed-out");
    }

    #[test]
    fn allocations_are_referenced_counted() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let baseline = live_allocations();
        let engine = Engine::new().expect("engine");
        let message = engine.with_ctx(|ctx| {
            // Keep the buffer reachable from the context: a bare completion value is freed
            // as soon as `value` drops, and its finalizer releases the JS reference.
            let value: js::Value = ctx
                .eval("globalThis.__keep = new Int32Array(new SharedArrayBuffer(16)); __keep")
                .expect("eval");
            crate::serialize::serialize(&ctx, &value).expect("serialize")
        });
        // The JS buffer and the message each hold a reference, but the block is counted once.
        assert_eq!(live_allocations(), baseline + 1);
        drop(message);
        assert_eq!(
            live_allocations(),
            baseline + 1,
            "the JS buffer still owns it"
        );
        drop(engine);
        assert_eq!(
            live_allocations(),
            baseline,
            "the engine released its buffer"
        );
    }
}
