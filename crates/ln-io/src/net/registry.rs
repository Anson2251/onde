//! The state every task of one [`NetService`](super::NetService) shares: the pool, the sink, the
//! id source, the live-handle table, and the shutdown gate.
//!
//! Two invariants live here because they are the only ones that need cross-task state:
//!
//! - **H4** (no event after shutdown): [`Shared::emit`] takes a small barrier and checks the open
//!   flag, and [`Shared::shutdown`] flips the flag under the same barrier before draining the
//!   handle table. Once `shutdown` returns, every later `emit` is dropped and every in-flight
//!   `emit` has already finished. No sleep and no per-task join is needed, which is what makes the
//!   guarantee testable without wall-clock timing.
//! - **H5** (an unknown id is never a panic): sending to a handle looks its channel up in the
//!   table; a missing id is `None`, not an error.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};

use tokio::runtime::Handle;
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};

use super::{Command, Event, EventSink, HandleId, HandleIdSource};

use super::connection::Connection;

pub(crate) struct Shared {
    /// The runtime to spawn tasks on. A `Handle` rather than the `Pool` itself: see
    /// `Pool::handle`.
    runtime: Handle,
    sink: EventSink,
    ids: HandleIdSource,
    tasks: Mutex<HashMap<HandleId, UnboundedSender<Command>>>,
    /// Serializes `emit` against `shutdown`; see the module docs.
    barrier: Mutex<()>,
    open: AtomicBool,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // Poisoning only means some other task panicked mid-update; the maps and the barrier are
    // consistent after every mutation point, so recover instead of panicking a second time (H5).
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Shared {
    pub(crate) fn new(runtime: Handle, sink: EventSink, ids: HandleIdSource) -> Self {
        Shared {
            runtime,
            sink,
            ids,
            tasks: Mutex::new(HashMap::new()),
            barrier: Mutex::new(()),
            open: AtomicBool::new(true),
        }
    }

    /// Spawn a task on the shared runtime. `None` means the runtime is gone, which can only
    /// happen while the process (or a test) is tearing down.
    pub(crate) fn spawn_task<F>(&self, task: F)
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        self.runtime.spawn(task);
    }

    /// Mint a handle id for a connection this side accepted. Same sequence as the op ids.
    pub(crate) fn mint(&self) -> HandleId {
        (self.ids)()
    }

    pub(crate) fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }

    pub(crate) fn contains(&self, id: HandleId) -> bool {
        lock(&self.tasks).contains_key(&id)
    }

    /// The command channel of a live handle, if it has not finished yet (H5: `None` is normal).
    pub(crate) fn sender(&self, id: HandleId) -> Option<UnboundedSender<Command>> {
        lock(&self.tasks).get(&id).cloned()
    }

    /// Add a handle to the table. `false` means the id is already live or the service is shutting
    /// down; the caller must not spawn a task in that case.
    pub(crate) fn register(&self, id: HandleId, sender: UnboundedSender<Command>) -> bool {
        let mut tasks = lock(&self.tasks);
        // Checked under the table lock so `shutdown` cannot drain between the check and the insert.
        if !self.open.load(Ordering::SeqCst) {
            return false;
        }
        tasks.insert(id, sender).is_none()
    }

    pub(crate) fn unregister(&self, id: HandleId) {
        lock(&self.tasks).remove(&id);
    }

    /// Deliver one event, unless the service has been shut down (H4).
    ///
    /// `closed` is emitted from here too, after the socket has been dropped: the sink is the only
    /// path to the isolate thread, so event order is the task's order by construction (H2).
    pub(crate) fn emit(&self, id: HandleId, event: Event) {
        let _barrier = lock(&self.barrier);
        if !self.open.load(Ordering::SeqCst) {
            return;
        }
        (self.sink)(id, event);
    }

    /// Spawn a connection task and make it addressable. Returns `false` when the id is taken.
    ///
    /// The registered channel exists *before* the task starts, so commands JS issues while the
    /// task is still handshaking queue up instead of being dropped.
    pub(crate) fn spawn_connection(&self, id: HandleId, connection: Connection) -> bool {
        self.spawn_connection_task(id, move |receiver| connection.run(receiver))
    }

    /// The general form of [`Shared::spawn_connection`]: a task that needs the handle's command
    /// receiver, typically because a TLS handshake runs before the connection's run loop.
    pub(crate) fn spawn_connection_task<F, Fut>(&self, id: HandleId, task: F) -> bool
    where
        F: FnOnce(UnboundedReceiver<Command>) -> Fut,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        let (sender, receiver) = mpsc::unbounded_channel();
        if !self.register(id, sender) {
            return false;
        }
        self.spawn_task(task(receiver));
        true
    }

    /// Stop every task and close the event gate (H4).
    ///
    /// The gate is closed before the `destroy` commands go out, so a task cannot sneak a `closed`
    /// event past a returning `shutdown`. Tasks release their sockets as they observe the command;
    /// `shutdown` itself does not wait for that (it runs on the isolate thread and must not block).
    pub(crate) fn shutdown(&self) {
        let senders: Vec<UnboundedSender<Command>> = {
            let _barrier = lock(&self.barrier);
            self.open.store(false, Ordering::SeqCst);
            let mut tasks = lock(&self.tasks);
            tasks.drain().map(|(_, sender)| sender).collect()
        };
        for sender in senders {
            // A task that already finished its loop dropped its receiver; that is not an error.
            let _ = sender.send(Command::Destroy);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    use crate::Pool;

    fn shared(sink: EventSink) -> (Arc<Pool>, Arc<Shared>) {
        let pool = Arc::new(Pool::new(1).expect("pool"));
        let ids: HandleIdSource = Arc::new(|| 1);
        let shared = Arc::new(Shared::new(pool.handle(), sink, ids));
        (pool, shared)
    }

    #[test]
    fn the_event_gate_drops_everything_after_shutdown() {
        let delivered = Arc::new(AtomicUsize::new(0));
        let counter = delivered.clone();
        let sink: EventSink = Arc::new(move |_id, _event| {
            counter.fetch_add(1, Ordering::SeqCst);
        });
        let (_pool, shared) = shared(sink);

        shared.emit(1, Event::End);
        assert_eq!(delivered.load(Ordering::SeqCst), 1);

        shared.shutdown();
        shared.emit(1, Event::End);
        shared.emit(2, Event::End);
        assert_eq!(delivered.load(Ordering::SeqCst), 1, "H4");
        assert!(!shared.is_open());
    }

    #[test]
    fn shutdown_destroys_every_registered_task() {
        let sink: EventSink = Arc::new(|_id, _event| {});
        let (_pool, shared) = shared(sink);
        let (sender, mut receiver) = mpsc::unbounded_channel();
        assert!(shared.register(7, sender));
        assert!(shared.contains(7));

        shared.shutdown();
        assert_eq!(receiver.try_recv(), Ok(Command::Destroy));
        assert!(!shared.contains(7), "the table is drained");
    }

    #[test]
    fn an_id_cannot_be_registered_twice_or_after_shutdown() {
        let sink: EventSink = Arc::new(|_id, _event| {});
        let (_pool, shared) = shared(sink);
        let (first, _first_receiver) = mpsc::unbounded_channel();
        let (second, _second_receiver) = mpsc::unbounded_channel();
        assert!(shared.register(3, first));
        assert!(!shared.register(3, second), "duplicate id");

        shared.shutdown();
        let (late, _late_receiver) = mpsc::unbounded_channel();
        assert!(!shared.register(4, late), "no new handles after shutdown");
        assert!(shared.sender(4).is_none());
    }
}
