//! `errno`, read at the C boundary.
//!
//! `errno` is thread-local and each isolate runs on one thread, so the host reads it immediately
//! after `ffi_call` and stores the number with the isolate. The JavaScript `errno()` accessor
//! returns and clears that stored value, which is why the read cannot be deferred to the next
//! host call.

/// The calling thread's `errno`.
pub fn last_errno() -> i32 {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    unsafe {
        *libc::__error()
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    unsafe {
        *libc::__errno_location()
    }
}

/// Set the calling thread's `errno` (used by tests and by an embedder that wants a clean slate).
pub fn set_errno(value: i32) {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    unsafe {
        *libc::__error() = value;
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    unsafe {
        *libc::__errno_location() = value;
    }
}
