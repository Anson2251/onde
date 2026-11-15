//! [`NetService`]: the isolate thread's only handle on the network tasks.
//!
//! One instance per isolate, created with the pool id source and the event sink the runtime owns.
//! It is `Send + Sync` and cheap to call: a command is one channel send.

use std::sync::Arc;

use tokio::sync::mpsc;

use super::connection::Connection;
use super::listener;
use super::registry::Shared;
use crate::Pool;

use super::{Command, EventSink, HandleId, HandleIdSource};

/// The owner of every live network handle.
///
/// The runtime calls [`command`](NetService::command) for `host.net(id, name, args)` and
/// [`shutdown`](NetService::shutdown) when the isolate goes away. Events come back through the
/// [`EventSink`] the service was built with; `ln-io` never touches the scheduler (ADR-0006 §2.3).
pub struct NetService {
    shared: Arc<Shared>,
    /// Keeps the runtime alive for as long as the service exists. The tasks do not hold it (they
    /// hold a `Handle`), so the last drop happens on the isolate thread, never on a worker.
    _pool: Arc<Pool>,
}

impl NetService {
    /// `pool` must be the process-wide pool (ADR-0006 §5): one tokio runtime for ops and handles.
    pub fn new(pool: Arc<Pool>, sink: EventSink, ids: HandleIdSource) -> Self {
        NetService {
            shared: Arc::new(Shared::new(pool.handle(), sink, ids)),
            _pool: pool,
        }
    }

    /// Submit one command for a handle.
    ///
    /// `Listen` and `Connect` create the task for an unknown id; every other command is forwarded
    /// to that handle's task channel, and silently ignored when the id is unknown (H5: an unknown
    /// id is never a panic). `0` means "no handle" and is always ignored (ADR-0006 §2.1).
    ///
    /// [`Command::Ref`] and [`Command::Unref`] are accepted and ignored here and in the task: loop
    /// refcounts belong to the handle table in `ln-runtime` (WP3), which owns the one loop ref a
    /// live handle holds (H3). The task keeps reading and writing after an `unref`; it is not a
    /// read stop.
    pub fn command(&self, id: HandleId, command: Command) {
        if id == 0 {
            return;
        }
        match command {
            Command::Listen(target) => self.spawn_listener(id, target),
            Command::Connect(target) => self.spawn_connect(id, target),
            command => {
                if let Some(sender) = self.shared.sender(id) {
                    // The task may have finished between the lookup and the send; that is the
                    // same "unknown id" case, not an error.
                    let _ = sender.send(command);
                }
            }
        }
    }

    /// Stop every task. Once this returns no further event is delivered to the sink (H4).
    ///
    /// It is deliberately non-blocking: tasks release their sockets as they observe the `destroy`
    /// command, and the event gate makes the no-events guarantee immediate.
    pub fn shutdown(&self) {
        self.shared.shutdown();
    }

    fn spawn_listener(&self, id: HandleId, target: super::ListenTarget) {
        if !self.shared.is_open() || self.shared.contains(id) {
            return;
        }
        let (sender, receiver) = mpsc::unbounded_channel();
        if !self.shared.register(id, sender) {
            return;
        }
        self.shared
            .spawn_task(listener::run(self.shared.clone(), id, target, receiver));
    }

    fn spawn_connect(&self, id: HandleId, target: super::ConnectTarget) {
        if !self.shared.is_open() || self.shared.contains(id) {
            return;
        }
        let (sender, receiver) = mpsc::unbounded_channel();
        if !self.shared.register(id, sender) {
            return;
        }
        self.shared.spawn_task(Connection::connect(
            self.shared.clone(),
            id,
            target,
            receiver,
        ));
    }
}

impl Drop for NetService {
    fn drop(&mut self) {
        // A dropped service must not keep delivering into a sink whose isolate is gone.
        self.shared.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::{ConnectOptions, ConnectTarget, ListenOptions, ListenTarget, MAX_CHUNK};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn service() -> (NetService, Arc<AtomicUsize>) {
        let pool = Arc::new(Pool::new(1).expect("pool"));
        let delivered = Arc::new(AtomicUsize::new(0));
        let counter = delivered.clone();
        let sink: EventSink = Arc::new(move |_id, _event| {
            counter.fetch_add(1, Ordering::SeqCst);
        });
        let next = Arc::new(AtomicUsize::new(1));
        let ids: HandleIdSource = {
            let next = next.clone();
            Arc::new(move || next.fetch_add(1, Ordering::SeqCst) as HandleId)
        };
        (NetService::new(pool, sink, ids), delivered)
    }

    /// The service crosses the isolate/worker boundary and is shared by every handle.
    #[test]
    fn the_service_is_send_and_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<NetService>();
        assert_send_sync::<Command>();
    }

    /// H5: commands addressed to handles that do not exist are ignored, never a panic. This test
    /// fails loudly if any of the calls panics.
    #[test]
    fn commands_to_unknown_handles_are_ignored() {
        let (service, _delivered) = service();
        for command in [
            Command::Read { max: MAX_CHUNK },
            Command::ReadStop,
            Command::Write {
                data: b"lost".to_vec(),
            },
            Command::End,
            Command::Destroy,
            Command::Reset,
            Command::Detach,
            Command::SetNoDelay(true),
            Command::SetKeepAlive {
                enable: true,
                initial_delay_ms: 1000,
            },
            Command::Ref,
            Command::Unref,
        ] {
            service.command(404, command);
        }
        service.command(0, Command::Destroy);
        service.shutdown();
    }

    /// H4 at the service boundary: after `shutdown`, `Listen` and `Connect` start no task.
    #[test]
    fn no_handle_starts_after_shutdown() {
        let (service, delivered) = service();
        service.shutdown();
        service.command(
            7,
            Command::Listen(ListenTarget::Tcp {
                host: "127.0.0.1".into(),
                port: 0,
                options: ListenOptions::default(),
            }),
        );
        service.command(
            8,
            Command::Connect(ConnectTarget::Tcp {
                host: "127.0.0.1".into(),
                port: 9,
                options: ConnectOptions::default(),
            }),
        );
        // Nothing is emitted, and no `Event` value is even constructed by a task.
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert_eq!(delivered.load(Ordering::SeqCst), 0);
    }
}
