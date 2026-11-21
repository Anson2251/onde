//! Host-owned job queue (M6).
//!
//! Before the engine patch the scheduler could only say "run the next engine job": the queue
//! lived in `rt->job_list`, jobs had no identity, and `JS_ExecutePendingJob` was the whole
//! interface. The patch hands every job to [`JobQueue::hook`] before it reaches that list, with an
//! opaque pointer the host owns and an `int64_t` tag, which is what `async_hooks` needs to know
//! *which* async resource a promise reaction belongs to.
//!
//! # Ownership
//!
//! A job is moved, never copied:
//!
//! ```text
//! engine enqueues ──▶ hook ──▶ JobQueue (VecDeque<*mut JSJob>) ──▶ pop ──▶ JS_JobRun
//!                                                                         │
//!                                                                     JS_JobFree
//! ```
//!
//! [`JobQueue::pop`] hands out a raw pointer and [`JobQueue::free_job`] releases it; both are
//! wrapped by [`crate::Engine`], which is the only caller. The queue never frees a job it did not
//! pop, so a job can only be freed once, after it ran or when the engine tears the queue down.
//!
//! # Ordering
//!
//! The hook runs where `list_add_tail` used to, so jobs are appended in the engine's own order. No
//! reordering happens here; the scheduler's policy (ticks before microtasks) is applied by the
//! runtime around the queue, never inside it.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::ffi::c_void;
use std::rc::Rc;

use crate::ffi;

/// The engine's pending jobs, in enqueue order.
pub(crate) struct JobQueue {
    rt: *mut ffi::JSRuntime,
    jobs: RefCell<VecDeque<ffi::JSJobPtr>>,
    /// Jobs taken by the host and not yet freed. Debug builds assert it reaches zero.
    taken: Cell<u64>,
    /// Jobs freed so far. Exposed for the leak assertions in tests and `--trace-events`.
    freed: Cell<u64>,
}

impl JobQueue {
    pub(crate) fn new(rt: *mut ffi::JSRuntime) -> Rc<Self> {
        Rc::new(JobQueue {
            rt,
            jobs: RefCell::new(VecDeque::new()),
            taken: Cell::new(0),
            freed: Cell::new(0),
        })
    }

    /// Take the engine's queue. Must be called before any JavaScript runs.
    pub(crate) fn install(self: &Rc<Self>) {
        // SAFETY: `rt` belongs to the engine that owns this queue, and the opaque pointer is the
        // address of an `Rc` the hook only uses while it is installed. `uninstall` drops it first.
        unsafe {
            ffi::JS_SetJobQueueHook(self.rt, Some(Self::hook), Rc::as_ptr(self) as *mut c_void);
        }
    }

    /// Return the queue to the engine. Jobs left in it are *not* freed here; the caller frees them
    /// first so the order (free, then uninstall) is explicit.
    pub(crate) fn uninstall(self: &Rc<Self>) {
        // SAFETY: same runtime, and the hook was installed by `install`.
        unsafe {
            ffi::JS_SetJobQueueHook(self.rt, None, std::ptr::null_mut());
        }
    }

    /// The C callback. Returning `true` means the host owns the job.
    ///
    /// A panic must never cross the FFI boundary. The only fallible step is the borrow (the queue
    /// is never borrowed across a call into JavaScript, so contention means a bug); on failure the
    /// job stays with the engine, which is safe, and debug builds notice at the next
    /// [`crate::Engine::has_jobs`] assertion.
    unsafe extern "C" fn hook(
        _rt: *mut ffi::JSRuntime,
        job: ffi::JSJobPtr,
        opaque: *mut c_void,
    ) -> bool {
        let queue = &*(opaque as *const JobQueue);
        match queue.jobs.try_borrow_mut() {
            Ok(mut jobs) => {
                jobs.push_back(job);
                queue.taken.set(queue.taken.get() + 1);
                true
            }
            Err(_) => false,
        }
    }

    fn next(&self) -> Option<ffi::JSJobPtr> {
        self.jobs.borrow_mut().pop_front()
    }

    /// The tag of the job at the head of the queue, without running it.
    pub(crate) fn next_tag(&self) -> Option<i64> {
        let job = *self.jobs.borrow().front()?;
        // SAFETY: the pointer came from the hook, is owned by this queue, and has not been freed.
        Some(unsafe { ffi::JS_JobTag(job) })
    }

    /// Pop the head job. The caller must run it exactly once and then call [`Self::free`].
    pub(crate) fn pop(&self) -> Option<ffi::JSJobPtr> {
        self.next()
    }

    /// Run one job. Returns `true` when it ran without throwing.
    ///
    /// The pending exception is deliberately *not* inspected here: the engine's context is needed
    /// for that, and taking it is the caller's job so the exception can be converted into the
    /// project's `CaughtError` on the same thread.
    pub(crate) fn run(&self, job: ffi::JSJobPtr) -> bool {
        let mut pctx: *mut ffi::JSContext = std::ptr::null_mut();
        // SAFETY: the job belongs to this runtime and is run once.
        let result = unsafe { ffi::JS_JobRun(self.rt, job, &mut pctx) };
        result > 0
    }

    /// Release a job that was popped (or held) by the host.
    pub(crate) fn free(&self, job: ffi::JSJobPtr) {
        // SAFETY: the pointer is owned by this queue, has not been freed, and the runtime is still
        // alive (the queue is torn down before the engine drops it).
        unsafe { ffi::JS_JobFree(self.rt, job) };
        self.freed.set(self.freed.get() + 1);
        self.taken.set(self.taken.get().saturating_sub(1));
    }

    pub(crate) fn len(&self) -> usize {
        self.jobs.borrow().len()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.jobs.borrow().is_empty()
    }

    /// Free every queued job. Used at teardown only.
    pub(crate) fn clear(&self) {
        while let Some(job) = self.pop() {
            self.free(job);
        }
    }

    /// Jobs the host adopted but has not freed. Zero between loop turns; a non-zero value at
    /// teardown would be a leak.
    pub(crate) fn outstanding(&self) -> u64 {
        self.taken.get()
    }

    pub(crate) fn freed(&self) -> u64 {
        self.freed.get()
    }
}

impl std::fmt::Debug for JobQueue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JobQueue")
            .field("pending", &self.len())
            .field("outstanding", &self.outstanding())
            .field("freed", &self.freed())
            .finish_non_exhaustive()
    }
}
