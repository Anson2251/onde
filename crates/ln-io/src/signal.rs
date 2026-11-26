//! Process signal delivery for `process.on("SIGINT")` (M5, ADR-0008 §2.7).
//!
//! Signals are process-wide, so this service is created only by the main isolate. It uses tokio's
//! signal driver, which installs one process-wide handler per signal and hands deliveries to the
//! task that registered the stream.
//!
//! # Default disposition
//!
//! Installing a tokio stream changes the disposition for the whole process and keeps it installed
//! for the life of the runtime. Node restores the default when the last listener is removed, so
//! this service keeps watching after `unsubscribe` and, when a signal arrives with no subscriber,
//! restores `SIG_DFL` and re-raises it. That reproduces "Ctrl-C with no listener terminates"
//! without a second signal-handling mechanism.
//!
//! The supported set is deliberately small (ADR-0008, D51): `SIGINT`, `SIGTERM`, `SIGHUP`,
//! `SIGQUIT`, `SIGUSR1`, `SIGUSR2`. `SIGKILL`/`SIGSTOP` cannot be caught.
//!
//! # Threading
//!
//! `SignalService` is `Send + Sync`; the sink runs on a pool thread and must not touch the engine.
//! The runtime's sink only parks a number and sends a completion, exactly like an op result.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use ln_error::NodeError;
use tokio::signal::unix::{signal, SignalKind};
use tokio::sync::Notify;

use crate::Pool;

/// Called on a pool thread for one delivery. Must not block.
pub type SignalSink = Arc<dyn Fn(i32) + Send + Sync>;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Node's catchable signals, and their numbers on this platform.
pub fn catchable_signals() -> &'static [(i32, &'static str)] {
    &[
        (libc::SIGINT, "SIGINT"),
        (libc::SIGTERM, "SIGTERM"),
        (libc::SIGHUP, "SIGHUP"),
        (libc::SIGQUIT, "SIGQUIT"),
        (libc::SIGUSR1, "SIGUSR1"),
        (libc::SIGUSR2, "SIGUSR2"),
    ]
}

/// The signal name for `number`, if this is one of Node's names.
pub fn signal_name(number: i32) -> Option<&'static str> {
    // `SIGKILL`/`SIGSTOP` are not catchable but still have names for `process.kill` and for
    // `child.exit` reporting; include them here, not in `catchable_signals`.
    let names: &[(i32, &'static str)] = &[
        (libc::SIGINT, "SIGINT"),
        (libc::SIGTERM, "SIGTERM"),
        (libc::SIGHUP, "SIGHUP"),
        (libc::SIGQUIT, "SIGQUIT"),
        (libc::SIGUSR1, "SIGUSR1"),
        (libc::SIGUSR2, "SIGUSR2"),
        (libc::SIGKILL, "SIGKILL"),
        (libc::SIGSTOP, "SIGSTOP"),
        (libc::SIGPIPE, "SIGPIPE"),
        (libc::SIGALRM, "SIGALRM"),
        (libc::SIGCHLD, "SIGCHLD"),
        (libc::SIGCONT, "SIGCONT"),
        (libc::SIGTSTP, "SIGTSTP"),
        (libc::SIGTTIN, "SIGTTIN"),
        (libc::SIGTTOU, "SIGTTOU"),
        (libc::SIGWINCH, "SIGWINCH"),
    ];
    names
        .iter()
        .find(|(candidate, _)| *candidate == number)
        .map(|(_, name)| *name)
}

/// The number for a Node signal name (`"SIGINT"`, or `"9"` for a numeric string).
pub fn signal_number(name: &str) -> Option<i32> {
    if !name.starts_with("SIG") {
        // Node accepts numeric strings for `process.kill` but not for listener names.
        return name.parse::<i32>().ok();
    }
    let names: &[(i32, &'static str)] = &[
        (libc::SIGINT, "SIGINT"),
        (libc::SIGTERM, "SIGTERM"),
        (libc::SIGHUP, "SIGHUP"),
        (libc::SIGQUIT, "SIGQUIT"),
        (libc::SIGUSR1, "SIGUSR1"),
        (libc::SIGUSR2, "SIGUSR2"),
        (libc::SIGKILL, "SIGKILL"),
        (libc::SIGSTOP, "SIGSTOP"),
        (libc::SIGPIPE, "SIGPIPE"),
        (libc::SIGALRM, "SIGALRM"),
        (libc::SIGCHLD, "SIGCHLD"),
        (libc::SIGCONT, "SIGCONT"),
        (libc::SIGTSTP, "SIGTSTP"),
        (libc::SIGTTIN, "SIGTTIN"),
        (libc::SIGTTOU, "SIGTTOU"),
        (libc::SIGWINCH, "SIGWINCH"),
    ];
    names
        .iter()
        .find(|(_, candidate)| *candidate == name)
        .map(|(number, _)| *number)
}

/// True when a signal may be observed by JavaScript at all.
fn is_catchable(number: i32) -> bool {
    catchable_signals()
        .iter()
        .any(|(candidate, _)| *candidate == number)
}

/// Restore the default action and re-raise, so a signal with no JS listener has its OS effect.
fn restore_and_raise(number: i32) {
    // SAFETY: both calls take plain integers and are async-signal-safe; this runs on a pool
    // thread, not inside a signal handler.
    unsafe {
        libc::signal(number, libc::SIG_DFL);
        libc::raise(number);
    }
}

/// Owns the per-signal tokio streams for one isolate.
pub struct SignalService {
    sink: SignalSink,
    wanted: Arc<Mutex<HashSet<i32>>>,
    /// One stop handle per installed signal, so `unsubscribe` can stop just that stream.
    tasks: Mutex<HashMap<i32, Arc<Notify>>>,
    installed: Mutex<HashSet<i32>>,
    started: AtomicBool,
    _pool: Arc<Pool>,
}

impl SignalService {
    pub fn new(pool: Arc<Pool>, sink: SignalSink) -> Self {
        SignalService {
            sink,
            wanted: Arc::new(Mutex::new(HashSet::new())),
            tasks: Mutex::new(HashMap::new()),
            installed: Mutex::new(HashSet::new()),
            started: AtomicBool::new(false),
            _pool: pool,
        }
    }

    /// Start watching `number`. Idempotent; only catchable signals are accepted.
    pub fn subscribe(&self, number: i32) -> Result<(), NodeError> {
        if !is_catchable(number) {
            return Err(NodeError::new(
                "ERR_UNSUPPORTED_SIGNAL",
                format!(
                    "Signal {} cannot be caught by onde",
                    signal_name(number).unwrap_or("unknown")
                ),
            ));
        }
        lock(&self.wanted).insert(number);
        if !lock(&self.installed).insert(number) {
            return Ok(());
        }

        // `signal()` registers with the runtime's signal driver, which requires a runtime context
        // even though the caller is the isolate thread.
        let _guard = self._pool.handle().enter();
        let kind = SignalKind::from_raw(number);
        let mut stream = signal(kind).map_err(|error| {
            NodeError::new(
                "ERR_UNSUPPORTED_SIGNAL",
                format!(
                    "Could not install a handler for {}: {error}",
                    signal_name(number).unwrap_or("signal")
                ),
            )
        })?;

        let wanted = self.wanted.clone();
        let stop = Arc::new(Notify::new());
        lock(&self.tasks).insert(number, stop.clone());
        let sink = self.sink.clone();
        self.started.store(true, Ordering::SeqCst);
        self._pool.handle().spawn(async move {
            loop {
                tokio::select! {
                    _ = stop.notified() => break,
                    received = stream.recv() => {
                        if received.is_none() {
                            break;
                        }
                        if lock(&wanted).contains(&number) {
                            // The sink parks the number; it never touches the engine.
                            sink(number);
                        } else {
                            // A delivery raced the last unsubscribe: behave as though no handler
                            // had ever been installed.
                            restore_and_raise(number);
                        }
                    }
                }
            }
        });
        Ok(())
    }

    /// Stop delivering `number` and restore its default action.
    ///
    /// The tokio driver keeps a process-wide handler installed, so restoring `SIG_DFL` explicitly
    /// is what makes "remove the last listener, signal terminates" true again.
    pub fn unsubscribe(&self, number: i32) {
        lock(&self.wanted).remove(&number);
        if lock(&self.tasks).contains_key(&number) {
            if let Some(stop) = lock(&self.tasks).remove(&number) {
                stop.notify_waiters();
            }
            lock(&self.installed).remove(&number);
            // SAFETY: plain integers; restoring the default has no memory preconditions.
            unsafe {
                libc::signal(number, libc::SIG_DFL);
            }
        }
    }

    /// Stop every task and restore the default dispositions. Called when the isolate goes away.
    pub fn shutdown(&self) {
        if !self.started.load(Ordering::SeqCst) {
            return;
        }
        lock(&self.wanted).clear();
        let tasks: HashMap<i32, Arc<Notify>> = {
            let mut tasks = lock(&self.tasks);
            std::mem::take(&mut *tasks)
        };
        for stop in tasks.values() {
            stop.notify_waiters();
        }
        for number in lock(&self.installed).drain() {
            // SAFETY: as in `unsubscribe`; no JS will observe a later delivery.
            unsafe {
                libc::signal(number, libc::SIG_DFL);
            }
        }
    }
}

impl Drop for SignalService {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Diagnostic: was the service used at all? (Created lazily by the runtime.)
pub fn is_installed(installed: &OnceLock<()>) -> bool {
    installed.get().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_numbers_round_trip() {
        for (number, name) in catchable_signals() {
            assert_eq!(signal_number(name), Some(*number));
            assert_eq!(signal_name(*number), Some(*name));
        }
        assert_eq!(signal_number("SIGKILL"), Some(libc::SIGKILL));
        assert_eq!(signal_number("9"), Some(9));
        assert_eq!(signal_number("SIGDEFINITELYNOT"), None);
    }

    #[test]
    fn uncatchable_signals_are_rejected() {
        let pool = Arc::new(Pool::new_unconfined(1).expect("pool"));
        let service = SignalService::new(pool, Arc::new(|_| {}));
        let error = service.subscribe(libc::SIGKILL).expect_err("SIGKILL");
        assert_eq!(error.code, "ERR_UNSUPPORTED_SIGNAL");
        service.shutdown();
    }
}
