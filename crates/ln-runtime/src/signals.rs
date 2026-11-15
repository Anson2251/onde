//! Signal delivery for the main isolate (M5, ADR-0008 §2.7).
//!
//! A signal is process-wide, so there is no per-handle table: one service per isolate, created on
//! the first `process.on("SIG…")`, and one reserved completion id that wakes the loop. The service
//! parks numbers and sends a completion from its pool thread; nothing else crosses (H1).
//!
//! Signals deliberately hold no loop ref: `process.on("SIGINT")` alone does not keep a Node process
//! alive, and matching that costs nothing here.

use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use ln_error::NodeError;
use ln_io::signal::{SignalService, SignalSink};
use ln_sched::{Completion, CompletionSender, Driver};

use crate::ops::OpBridge;

/// The completion id reserved for signal deliveries. Real ids come from the allocator and start
/// at 1, so `u64::MAX` can never collide; the router checks it before any table.
pub(crate) const SIGNAL_COMPLETION_ID: u64 = u64::MAX;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Owns the signal service and the deliveries that arrived since the last drain.
pub(crate) struct SignalBridge {
    sender: CompletionSender,
    driver: Rc<RefCell<Driver>>,
    parked: Arc<Mutex<Vec<i32>>>,
    /// Cleared by shutdown: after it, no delivery may wake the loop.
    open: Arc<AtomicBool>,
    /// Signals JavaScript currently listens to.
    subscribed: RefCell<HashSet<i32>>,
    /// One loop ref while any listener is installed, matching Node's signal watcher.
    refed: std::cell::Cell<bool>,
    /// Created on the first listener, never at boot.
    service: OnceLock<Result<SignalService, NodeError>>,
    ops: Rc<OpBridge>,
}

impl SignalBridge {
    pub(crate) fn new(
        driver: Rc<RefCell<Driver>>,
        sender: CompletionSender,
        ops: Rc<OpBridge>,
    ) -> Self {
        SignalBridge {
            sender,
            driver,
            parked: Arc::new(Mutex::new(Vec::new())),
            open: Arc::new(AtomicBool::new(true)),
            subscribed: RefCell::new(HashSet::new()),
            refed: std::cell::Cell::new(false),
            service: OnceLock::new(),
            ops,
        }
    }

    /// `host.signal(number, on)`: subscribe or unsubscribe. Idempotent per signal.
    pub(crate) fn subscribe(&self, number: i32, on: bool) -> Result<(), NodeError> {
        if !self.open.load(Ordering::SeqCst) {
            return Ok(());
        }
        if on {
            if self.subscribed.borrow_mut().insert(number) {
                let service = self.service()?;
                service.subscribe(number)?;
                self.take_ref();
            }
        } else if self.subscribed.borrow_mut().remove(&number) {
            if let Some(Ok(service)) = self.service.get() {
                service.unsubscribe(number);
            }
            if self.subscribed.borrow().is_empty() {
                self.release_ref();
            }
        }
        Ok(())
    }

    /// Take the signal numbers parked since the last drain.
    pub(crate) fn take(&self) -> Vec<i32> {
        std::mem::take(&mut *lock(&self.parked))
    }

    /// Stop delivering and restore the default dispositions.
    pub(crate) fn shutdown(&self) {
        self.open.store(false, Ordering::SeqCst);
        self.subscribed.borrow_mut().clear();
        self.release_ref();
        lock(&self.parked).clear();
        if let Some(Ok(service)) = self.service.get() {
            service.shutdown();
        }
    }

    fn take_ref(&self) {
        if !self.refed.replace(true) {
            self.driver.borrow_mut().ref_external();
        }
    }

    fn release_ref(&self) {
        if self.refed.replace(false) {
            self.driver.borrow_mut().unref_external();
        }
    }

    fn service(&self) -> Result<&SignalService, NodeError> {
        let result = self.service.get_or_init(|| {
            let pool = self.ops.pool()?;
            let parked = self.parked.clone();
            let sender = Mutex::new(self.sender.clone());
            let open = self.open.clone();
            let sink: SignalSink = Arc::new(move |number: i32| {
                if !open.load(Ordering::SeqCst) {
                    return;
                }
                lock(&parked).push(number);
                let _ = lock(&sender).send(Completion(SIGNAL_COMPLETION_ID));
            });
            Ok(SignalService::new(pool, sink))
        });
        result.as_ref().map_err(|error| error.clone())
    }
}

impl Drop for SignalBridge {
    fn drop(&mut self) {
        self.shutdown();
    }
}
