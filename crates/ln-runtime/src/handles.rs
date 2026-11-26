//! The handle bridge: the live-handle half of the host boundary (ADR-0006).
//!
//! An [`Op`](crate::ops) is bounded work with one settle; a **handle** is a live connection that
//! emits events until it closes. This module owns everything that makes handles fit into the
//! existing completion channel, mirroring [`crate::ops`]:
//!
//! 1. `host.net(id, name, args)` ([`host::net`](super::net)) turns the argument array into an
//!    [`ln_io::net::Command`] and hands it to [`HandleBridge::command`], which submits it to the
//!    lazily created [`NetService`] — never at boot, so cold start does not regress.
//! 2. The task calls the [`EventSink`] with one event at a time. The sink parks the event per
//!    handle and sends **one** `Completion(id)`; `ln-sched` still sees only `u64` (ADR-0006 §2.3).
//! 3. The completion phase drains that handle's queue, converts each event on the isolate thread
//!    and calls `__ln_handle_event(id, name, payload)`, then runs one checkpoint.
//!
//! Two invariants live here:
//!
//! * **H3** — a live handle holds at most one external loop ref. `listen`/`connect` take it,
//!   `unref` releases it, `ref` takes it back, and `closed` releases it at most once. The held set
//!   lives on the isolate thread, so a double `ref`/`unref` can never underflow the driver.
//! * **H4** — after [`HandleBridge::shutdown`] no event is dispatched and no ref is left behind.
//!
//! Events are converted to plain JS on the isolate thread; no `JSValue` is ever stored in a
//! handle slot, the parked queue or a task (H1).

use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use ln_engine::{js, CaughtError, Engine};
use ln_error::NodeError;
use ln_http::BodyMode;
use ln_io::net::{Addr, Command, Event, EventSink, HandleId, HandleIdSource, NetService};
use ln_sched::{Completion, CompletionSender, Driver};

use crate::host_error::node_error_value;
use crate::ops::{OpBridge, RequestIdAllocator};

/// A poisoned mutex means a thread panicked mid-update; both maps are consistent after every
/// mutation point, so recovering is safer than panicking the isolate thread (H5).
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Events parked for one handle, drained by its completion.
type Parked = Arc<Mutex<HashMap<HandleId, VecDeque<Event>>>>;

/// Owns the network service, the parked event queues and the loop refs of live handles.
pub(crate) struct HandleBridge {
    /// The isolate's single id sequence, shared with the op table (ADR-0006 §2.1).
    ids: Arc<RequestIdAllocator>,
    /// Filled by a task thread through the [`EventSink`], drained by the isolate thread.
    parked: Parked,
    driver: Rc<RefCell<Driver>>,
    /// Used only to reach the process-wide pool when the service is created.
    ops: Rc<OpBridge>,
    /// Handles JS knows about: created by `listen`/`connect`, plus accepted connections. A
    /// `ref`/`unref` for anything else is ignored (H5: an unknown id is never a panic).
    live: RefCell<HashSet<HandleId>>,
    /// Handles whose one external loop ref this bridge currently holds (H3).
    refs: RefCell<HashSet<HandleId>>,
    /// Created on the first `host.net` command, never at boot.
    service: OnceLock<Result<NetService, NodeError>>,
    /// Shared with the sink: once set, a task may no longer park or wake the loop.
    shutting_down: Arc<AtomicBool>,
    sink: EventSink,
}

impl HandleBridge {
    pub(crate) fn new(
        driver: Rc<RefCell<Driver>>,
        sender: CompletionSender,
        ops: Rc<OpBridge>,
    ) -> Self {
        let parked: Parked = Arc::new(Mutex::new(HashMap::new()));
        let shutting_down = Arc::new(AtomicBool::new(false));
        let sink: EventSink = {
            let parked = parked.clone();
            let sender = Mutex::new(sender);
            let shutting_down = shutting_down.clone();
            Arc::new(move |id: HandleId, event: Event| {
                if shutting_down.load(Ordering::SeqCst) {
                    return;
                }
                lock(&parked).entry(id).or_default().push_back(event);
                // The receiver may be gone if the isolate was dropped; nothing to wake then.
                let _ = lock(&sender).send(Completion(id));
            })
        };

        HandleBridge {
            ids: ops.ids().clone(),
            parked,
            driver,
            ops,
            live: RefCell::new(HashSet::new()),
            refs: RefCell::new(HashSet::new()),
            service: OnceLock::new(),
            shutting_down,
            sink,
        }
    }

    /// Submit one command for `id`.
    ///
    /// `Ref`/`Unref` never reach the task: loop refs are owned here (ADR-0006 §2.4, H3).
    /// `Listen`/`Connect` take the handle's ref synchronously, before the task can emit
    /// `listening`/`connected`, so the loop cannot exit between the command and the event.
    pub(crate) fn command(&self, id: HandleId, command: Command) -> Result<(), NodeError> {
        if id == 0 {
            // 0 means "no handle" (ADR-0006 §2.1); never take a ref for it.
            return Ok(());
        }
        // Keep the sequence ahead of an id that reached us from outside the allocator. JS always
        // mints ids with `host.nextRequestId()`, but a literal id must never collide with a
        // handle the accept task mints.
        self.ids.observe(id);
        if self.shutting_down.load(Ordering::SeqCst) {
            // The isolate is tearing down; a late command must not resurrect a ref.
            return Ok(());
        }
        match command {
            Command::Ref => {
                self.ref_handle(id);
                Ok(())
            }
            Command::Unref => {
                self.unref_handle(id);
                Ok(())
            }
            Command::Listen(_) | Command::Connect(_) => {
                // Create the service first: if the pool cannot be created there is no task to
                // hold the ref, so taking it before this `?` would leak one forever.
                let service = self.service()?;
                self.activate(id);
                service.command(id, command);
                Ok(())
            }
            command => {
                // Do not create the pool for a command addressed to a handle that never existed.
                if let Some(Ok(service)) = self.service.get() {
                    service.command(id, command);
                }
                Ok(())
            }
        }
    }

    /// Drain the events parked for `id`, in task order. The completion phase calls this exactly
    /// once per `Completion`; an empty/missing queue means the completion was a duplicate or the
    /// id is unknown, and both are ignored.
    pub(crate) fn take(&self, id: HandleId) -> Option<VecDeque<Event>> {
        lock(&self.parked).remove(&id)
    }

    /// Bookkeeping for one event batch, before any JS runs: an accepted connection becomes a live
    /// handle, and a `closed` event releases that handle's loop ref at most once.
    pub(crate) fn observe_event(&self, id: HandleId, event: &Event) {
        match event {
            Event::Connection { handle, .. } => {
                // JS will issue `read`/`httpAttach` for the child from the event handler, so the
                // id must be known before dispatch.
                self.live.borrow_mut().insert(*handle);
            }
            Event::Closed { .. } => {
                self.live.borrow_mut().remove(&id);
                self.release_ref(id);
            }
            _ => {}
        }
    }

    /// `host.net(id, "ref")`: take the handle's loop ref back, idempotently.
    pub(crate) fn ref_handle(&self, id: HandleId) {
        if self.live.borrow().contains(&id) {
            self.take_ref(id);
        }
    }

    /// `host.net(id, "unref")`: release the handle's loop ref early, idempotently. The task keeps
    /// running; an unref'd socket still reads, it just does not keep the process alive.
    pub(crate) fn unref_handle(&self, id: HandleId) {
        self.release_ref(id);
    }

    /// Stop every task, drop parked events and release every held ref. Idempotent, and the last
    /// point at which an event may be delivered (H4).
    pub(crate) fn shutdown(&self) {
        if self.shutting_down.swap(true, Ordering::SeqCst) {
            return;
        }
        // The service gate makes `emit` a no-op and waits for an in-flight `emit` before
        // returning, so clearing the queues afterwards cannot race a late park.
        if let Some(Ok(service)) = self.service.get() {
            service.shutdown();
        }
        lock(&self.parked).clear();
        let released: Vec<HandleId> = self.refs.borrow_mut().drain().collect();
        self.live.borrow_mut().clear();
        let mut driver = self.driver.borrow_mut();
        for _ in released {
            driver.unref_external();
        }
    }

    /// Handles JS currently knows about (diagnostics/tests).
    pub(crate) fn live_handles(&self) -> usize {
        self.live.borrow().len()
    }

    /// Loop refs this bridge holds (diagnostics/tests): always 0 or 1 per live handle.
    pub(crate) fn held_refs(&self) -> usize {
        self.refs.borrow().len()
    }

    fn activate(&self, id: HandleId) {
        self.live.borrow_mut().insert(id);
        self.take_ref(id);
    }

    fn take_ref(&self, id: HandleId) {
        // The set makes this idempotent: H3 says at most one ref per live handle.
        if self.refs.borrow_mut().insert(id) {
            self.driver.borrow_mut().ref_external();
        }
    }

    fn release_ref(&self, id: HandleId) {
        // Only a ref we actually hold can be released, so the driver can never underflow.
        if self.refs.borrow_mut().remove(&id) {
            self.driver.borrow_mut().unref_external();
        }
    }

    /// The lazily created service. The first `listen`/`connect` pays for the pool and the runtime
    /// handle; boot pays nothing.
    fn service(&self) -> Result<&NetService, NodeError> {
        let result = self.service.get_or_init(|| {
            let pool = self.ops.pool()?;
            let ids = self.ids.clone();
            let source: HandleIdSource = Arc::new(move || ids.allocate());
            Ok(NetService::new(
                pool,
                self.sink.clone(),
                source,
                self.ops.permit().clone(),
            ))
        });
        result.as_ref().map_err(|error| error.clone())
    }
}

// --- event conversion (isolate thread only) --------------------------------------------------

/// Convert one protocol event into the `(name, payload)` pair `__ln_handle_event` receives.
///
/// The payload contract is `docs/m4-plan.md` §2.3: `headers` and `trailers` are flat
/// `[name, value, ...]` arrays in wire order with the original case, `body` is
/// `{ kind, length }`, and errors are real JS `Error` objects carrying `code`/`errno`/`syscall`.
pub(crate) fn event_to_js<'js>(
    ctx: &js::Ctx<'js>,
    event: &Event,
) -> js::Result<(&'static str, js::Value<'js>)> {
    let undefined = || js::Value::new_undefined(ctx.clone());
    Ok(match event {
        Event::Listening { local } => ("listening", addr_object(ctx, local)?.into_value()),
        Event::Connection {
            handle,
            remote,
            alpn,
            protocol,
        } => {
            let object = addr_object(ctx, remote)?;
            object.set("handle", *handle as f64)?;
            match alpn {
                Some(alpn) => object.set("alpn", alpn.as_str())?,
                None => object.set("alpn", js::Value::new_null(ctx.clone()))?,
            }
            match protocol {
                Some(protocol) => object.set("protocol", protocol.as_str())?,
                None => object.set("protocol", js::Value::new_null(ctx.clone()))?,
            }
            ("connection", object.into_value())
        }
        Event::Connected {
            local,
            remote,
            alpn,
            protocol,
        } => {
            let object = js::Object::new(ctx.clone())?;
            object.set("local", addr_object(ctx, local)?)?;
            object.set("remote", addr_object(ctx, remote)?)?;
            match alpn {
                Some(alpn) => object.set("alpn", alpn.as_str())?,
                None => object.set("alpn", js::Value::new_null(ctx.clone()))?,
            }
            // `socket.getProtocol()`: `"TLSv1.3"` for a TLS transport, `null` for a plain one.
            match protocol {
                Some(protocol) => object.set("protocol", protocol.as_str())?,
                None => object.set("protocol", js::Value::new_null(ctx.clone()))?,
            }
            ("connected", object.into_value())
        }
        Event::Data { bytes } => ("data", bytes_value(ctx, bytes)?),
        Event::End => ("end", undefined()),
        Event::Drain => ("drain", undefined()),
        Event::Timeout => ("timeout", undefined()),
        // A real JS `Error`: the same conversion the op path uses (`host_error`), so `.code`,
        // `.errno` (negative) and `.syscall` have Node's shape.
        Event::Error { error } => ("error", node_error_value(ctx, error)?),
        Event::Closed { had_error } => {
            let object = js::Object::new(ctx.clone())?;
            object.set("hadError", *had_error)?;
            ("closed", object.into_value())
        }
        Event::Http(http) => http_event_to_js(ctx, http)?,
        Event::ClientError { error } => ("clientError", node_error_value(ctx, error)?),
    })
}

fn http_event_to_js<'js>(
    ctx: &js::Ctx<'js>,
    event: &ln_http::Event,
) -> js::Result<(&'static str, js::Value<'js>)> {
    Ok(match event {
        ln_http::Event::Request {
            method,
            target,
            version,
            headers,
            keep_alive,
            expect_continue,
            body,
        } => {
            let object = js::Object::new(ctx.clone())?;
            object.set("method", method.as_str())?;
            object.set("target", target.as_str())?;
            object.set("version", i32::from(*version))?;
            object.set("headers", headers_array(ctx, headers)?)?;
            object.set("keepAlive", *keep_alive)?;
            object.set("expectContinue", *expect_continue)?;
            object.set("body", body_object(ctx, *body)?)?;
            ("request", object.into_value())
        }
        ln_http::Event::Response {
            status,
            reason,
            version,
            headers,
            keep_alive,
            body,
        } => {
            let object = js::Object::new(ctx.clone())?;
            object.set("status", *status)?;
            object.set("reason", reason.as_str())?;
            object.set("version", i32::from(*version))?;
            object.set("headers", headers_array(ctx, headers)?)?;
            object.set("keepAlive", *keep_alive)?;
            object.set("body", body_object(ctx, *body)?)?;
            ("response", object.into_value())
        }
        ln_http::Event::Body { bytes } => ("body", bytes_value(ctx, bytes)?),
        ln_http::Event::MessageEnd { trailers } => {
            let object = js::Object::new(ctx.clone())?;
            object.set("trailers", headers_array(ctx, trailers)?)?;
            ("messageEnd", object.into_value())
        }
        ln_http::Event::Upgrade { bytes } => ("upgrade", bytes_value(ctx, bytes)?),
    })
}

/// `{ address, family, port }` as Node's `server.address()` / `socket.address()` report it.
fn addr_object<'js>(ctx: &js::Ctx<'js>, addr: &Addr) -> js::Result<js::Object<'js>> {
    let object = js::Object::new(ctx.clone())?;
    match addr {
        Addr::Ip(socket) => object.set("address", socket.ip().to_string())?,
        Addr::Unix(path) => object.set("address", path.to_string_lossy().into_owned())?,
    }
    object.set("family", addr.family())?;
    object.set("port", addr.port())?;
    Ok(object)
}

/// `{ kind: "none" | "length" | "chunked" | "eof", length: number | null }`.
fn body_object<'js>(ctx: &js::Ctx<'js>, body: BodyMode) -> js::Result<js::Object<'js>> {
    let object = js::Object::new(ctx.clone())?;
    let (kind, length) = match body {
        BodyMode::None => ("none", None),
        BodyMode::Length(length) => ("length", Some(length as f64)),
        BodyMode::Chunked => ("chunked", None),
        BodyMode::Eof => ("eof", None),
    };
    object.set("kind", kind)?;
    match length {
        Some(length) => object.set("length", length)?,
        None => object.set("length", js::Value::new_null(ctx.clone()))?,
    }
    Ok(object)
}

/// Wire-order headers as the flat `[name, value, ...]` array `rawHeaders` slices directly.
fn headers_array<'js>(
    ctx: &js::Ctx<'js>,
    headers: &[(String, String)],
) -> js::Result<js::Array<'js>> {
    let array = js::Array::new(ctx.clone())?;
    for (index, (name, value)) in headers.iter().enumerate() {
        array.set(index * 2, name.as_str())?;
        array.set(index * 2 + 1, value.as_str())?;
    }
    Ok(array)
}

fn bytes_value<'js>(ctx: &js::Ctx<'js>, bytes: &[u8]) -> js::Result<js::Value<'js>> {
    Ok(js::TypedArray::<u8>::new(ctx.clone(), bytes.to_vec())?.into_value())
}

/// Dispatch one handle's event batch through `__ln_handle_event`, in task order.
///
/// A throw from a JS sink stops the batch and is reported by the scheduler exactly like a throw
/// from an op callback (`uncaughtException`).
pub(crate) fn dispatch_handle_events(
    engine: &Engine,
    id: HandleId,
    events: &VecDeque<Event>,
) -> Result<(), CaughtError> {
    engine.with_ctx(|ctx| {
        let result: js::Result<()> = (|| {
            let callback: js::Function = ctx.globals().get("__ln_handle_event")?;
            for event in events {
                let (name, payload) = event_to_js(&ctx, event)?;
                callback.call::<_, ()>((id, name, payload))?;
            }
            Ok(())
        })();
        js::CatchResultExt::catch(result, &ctx)
            .map_err(|error| ln_engine::caught_to_owned(&ctx, error))
    })
}

#[cfg(test)]
mod tests {
    use crate::{Config, Isolate};

    /// Run `source` to completion and report the exit code plus the handle bookkeeping that must
    /// be empty after teardown.
    fn run(source: &str) -> (i32, usize, usize) {
        let mut isolate = Isolate::new(Config::new(vec!["onde".to_owned()])).expect("isolate");
        let outcome = isolate.run(source, "[eval]").expect("run");
        (
            outcome.exit_code,
            isolate.handle_refs(),
            isolate.live_handles(),
        )
    }

    /// H3, keep-alive half: a listening handle holds one loop ref, so the loop stays alive after
    /// the script returns; `destroy` produces `closed`, which releases the ref and lets the
    /// process exit 0 with no timers and nothing else keeping it alive.
    ///
    /// The script also churns `ref`/`unref` (including double calls) before destroying: the held
    /// set must make both idempotent, and the final `ref` must re-take the released ref, or
    /// `closed` would never be dispatched.
    #[test]
    fn a_listening_handle_keeps_the_loop_alive_until_it_is_destroyed() {
        let script = r#"
const host = __ln_host;
const id = 1;
const seen = [];
host.handles.register(id, (name, payload) => {
  seen.push(name);
  if (name === "listening") {
    // The same handle's ref must never go above one, and unref must not underflow.
    host.net(id, "ref", []);
    host.net(id, "ref", []);
    host.net(id, "unref", []);
    host.net(id, "unref", []);
    host.net(id, "ref", []);
    host.net(id, "destroy", []);
  } else if (name === "closed") {
    if (payload.hadError !== false) process.exit(31);
  } else {
    process.exit(32);
  }
});
host.net(id, "listen", ["127.0.0.1", 0, null, null, null, null, null]);
process.on("exit", () => {
  if (seen.join(",") !== "listening,closed") process.exitCode = 33;
});
"#;
        let (exit_code, refs, live) = run(script);
        assert_eq!(exit_code, 0);
        assert_eq!(refs, 0, "every loop ref must be released at teardown");
        assert_eq!(live, 0, "every handle must be forgotten at teardown");
    }

    /// H3, exit half: `unref` releases the listener's only ref, so the process exits **while the
    /// listener is still live**. If `unref` were ignored this test would block forever; if it
    /// closed the handle there would be a `closed` event.
    #[test]
    fn an_unrefed_listening_handle_lets_the_process_exit() {
        let script = r#"
const host = __ln_host;
const id = 1;
let listening = false;
let closed = false;
host.handles.register(id, (name) => {
  if (name === "listening") {
    listening = true;
    host.net(id, "unref", []);
  } else if (name === "closed") {
    closed = true;
  }
});
host.net(id, "listen", ["127.0.0.1", 0, null, null, null, null, null]);
process.on("exit", () => {
  if (!listening) process.exitCode = 41;
  if (closed) process.exitCode = 42;
});
"#;
        let (exit_code, refs, live) = run(script);
        assert_eq!(exit_code, 0);
        assert_eq!(refs, 0);
        assert_eq!(live, 0);
    }

    /// The event contract WP4/WP5 code against: `listening` carries the bound address as
    /// `{ address, family, port }`, `closed` carries `{ hadError }`, and `__ln_handle_event`
    /// reaches the sink registered for the id.
    #[test]
    fn handle_events_reach_the_js_registry_with_the_documented_payloads() {
        let script = r#"
const host = __ln_host;
const id = 1;
const seen = [];
host.handles.register(id, (name, payload) => {
  seen.push(name);
  if (name === "listening") {
    if (payload.address !== "127.0.0.1") process.exit(51);
    if (payload.family !== "IPv4") process.exit(52);
    if (typeof payload.port !== "number" || payload.port <= 0) process.exit(53);
    host.net(id, "destroy", []);
  } else if (name === "closed") {
    if (payload.hadError !== false) process.exit(54);
    host.handles.release(id);
  } else {
    process.exit(55);
  }
});
host.net(id, "listen", ["127.0.0.1", 0, null, null, null, null, null]);
process.on("exit", () => {
  if (seen.join(",") !== "listening,closed") process.exitCode = 56;
});
"#;
        let (exit_code, refs, live) = run(script);
        assert_eq!(exit_code, 0);
        assert_eq!(refs, 0);
        assert_eq!(live, 0);
    }

    /// H5: commands addressed to an id that never existed are ignored, and `0` means "no handle".
    /// This must not create the pool either (`host.net` is a no-op for an unknown handle).
    #[test]
    fn commands_to_unknown_handles_are_ignored() {
        let script = r#"
const host = __ln_host;
host.net(0, "destroy", []);
host.net(99, "read", [1024]);
host.net(99, "write", [new Uint8Array([1])]);
host.net(99, "unref", []);
"#;
        let (exit_code, refs, live) = run(script);
        assert_eq!(exit_code, 0);
        assert_eq!(refs, 0);
        assert_eq!(live, 0);
    }
}

#[cfg(test)]
mod conversion_tests {
    //! The event payload contract WP4/WP5 code against (`docs/m4-plan.md` §2.3). These are pure
    //! conversions: no sockets, no loop.

    use super::event_to_js;
    use ln_engine::{js, Engine};
    use ln_error::NodeError;
    use ln_http::{BodyMode, Event as HttpEvent};
    use ln_io::net::{Addr, Event};

    fn with_ctx<R>(f: impl FnOnce(js::Ctx<'_>) -> R) -> R {
        let engine = Engine::new().expect("engine");
        engine.with_ctx(f)
    }

    fn address(value: &str) -> Addr {
        value
            .parse::<std::net::SocketAddr>()
            .expect("address")
            .into()
    }

    #[test]
    fn listening_and_connection_carry_node_address_fields() {
        with_ctx(|ctx| {
            let (name, payload) = event_to_js(
                &ctx,
                &Event::Listening {
                    local: address("127.0.0.1:9000"),
                },
            )
            .expect("event");
            assert_eq!(name, "listening");
            let object = payload.as_object().expect("object");
            assert_eq!(
                object.get::<_, String>("address").expect("address"),
                "127.0.0.1"
            );
            assert_eq!(object.get::<_, String>("family").expect("family"), "IPv4");
            assert_eq!(object.get::<_, u16>("port").expect("port"), 9000);

            let (name, payload) = event_to_js(
                &ctx,
                &Event::Connection {
                    handle: 7,
                    remote: address("[::1]:1234"),
                    alpn: None,
                    protocol: None,
                },
            )
            .expect("event");
            assert_eq!(name, "connection");
            let object = payload.as_object().expect("object");
            assert_eq!(object.get::<_, f64>("handle").expect("handle"), 7.0);
            assert_eq!(object.get::<_, String>("family").expect("family"), "IPv6");
            assert_eq!(object.get::<_, u16>("port").expect("port"), 1234);
        });
    }

    #[test]
    fn connected_reports_both_endpoints_and_alpn() {
        with_ctx(|ctx| {
            let event = Event::Connected {
                local: address("127.0.0.1:1000"),
                remote: address("127.0.0.1:2000"),
                alpn: Some("http/1.1".to_owned()),
                protocol: Some("TLSv1.3".to_owned()),
            };
            let (name, payload) = event_to_js(&ctx, &event).expect("event");
            assert_eq!(name, "connected");
            let object = payload.as_object().expect("object");
            let local: js::Object = object.get("local").expect("local");
            assert_eq!(local.get::<_, u16>("port").expect("port"), 1000);
            let remote: js::Object = object.get("remote").expect("remote");
            assert_eq!(remote.get::<_, u16>("port").expect("port"), 2000);
            assert_eq!(object.get::<_, String>("alpn").expect("alpn"), "http/1.1");
            assert_eq!(
                object.get::<_, String>("protocol").expect("protocol"),
                "TLSv1.3"
            );

            let event = Event::Connected {
                local: address("127.0.0.1:1000"),
                remote: address("127.0.0.1:2000"),
                alpn: None,
                protocol: None,
            };
            let (_, payload) = event_to_js(&ctx, &event).expect("event");
            let object = payload.as_object().expect("object");
            let alpn: js::Value = object.get("alpn").expect("alpn");
            assert!(alpn.is_null());
            let protocol: js::Value = object.get("protocol").expect("protocol");
            assert!(protocol.is_null());
        });
    }

    #[test]
    fn data_and_closed_have_the_documented_shapes() {
        with_ctx(|ctx| {
            let (name, payload) = event_to_js(
                &ctx,
                &Event::Data {
                    bytes: vec![1, 2, 3],
                },
            )
            .expect("event");
            assert_eq!(name, "data");
            let array = payload
                .as_object()
                .and_then(|object| object.as_typed_array::<u8>())
                .expect("Uint8Array");
            // SAFETY: the array is owned by this context and nothing runs between the borrow and
            // the copy.
            assert_eq!(unsafe { array.as_slice() }, &[1, 2, 3]);

            let (name, payload) =
                event_to_js(&ctx, &Event::Closed { had_error: true }).expect("event");
            assert_eq!(name, "closed");
            let object = payload.as_object().expect("object");
            assert!(object.get::<_, bool>("hadError").expect("hadError"));

            for event in [Event::End, Event::Drain, Event::Timeout] {
                let (name, payload) = event_to_js(&ctx, &event).expect("event");
                assert!(["end", "drain", "timeout"].contains(&name));
                assert!(payload.is_undefined());
            }
        });
    }

    #[test]
    fn errors_are_real_js_errors_with_node_properties() {
        with_ctx(|ctx| {
            let error = NodeError::from_errno(libc::EACCES, "connect", None);
            let (name, payload) = event_to_js(&ctx, &Event::Error { error }).expect("event");
            assert_eq!(name, "error");
            let object = payload.as_object().expect("Error object");
            // A real Error: its prototype chain has `message`.
            assert_eq!(object.get::<_, String>("code").expect("code"), "EACCES");
            assert_eq!(object.get::<_, i32>("errno").expect("errno"), -libc::EACCES);
            assert_eq!(
                object.get::<_, String>("syscall").expect("syscall"),
                "connect"
            );

            let error = NodeError::new("ERR_HTTP_PARSE", "bad request");
            let (name, payload) = event_to_js(&ctx, &Event::ClientError { error }).expect("event");
            assert_eq!(name, "clientError");
            let object = payload.as_object().expect("Error object");
            assert_eq!(
                object.get::<_, String>("code").expect("code"),
                "ERR_HTTP_PARSE"
            );
        });
    }

    #[test]
    fn request_and_response_carry_flat_headers_a_version_and_a_body_mode() {
        with_ctx(|ctx| {
            let event = Event::Http(HttpEvent::Request {
                method: "POST".to_owned(),
                target: "/x".to_owned(),
                version: 0x11,
                headers: vec![
                    ("Host".to_owned(), "example.com".to_owned()),
                    ("Content-Length".to_owned(), "5".to_owned()),
                ],
                keep_alive: true,
                expect_continue: true,
                body: BodyMode::Length(5),
            });
            let (name, payload) = event_to_js(&ctx, &event).expect("event");
            assert_eq!(name, "request");
            let object = payload.as_object().expect("object");
            assert_eq!(object.get::<_, String>("method").expect("method"), "POST");
            assert_eq!(object.get::<_, String>("target").expect("target"), "/x");
            assert_eq!(object.get::<_, i32>("version").expect("version"), 0x11);
            assert!(object.get::<_, bool>("keepAlive").expect("keepAlive"));
            assert!(object
                .get::<_, bool>("expectContinue")
                .expect("expectContinue"));

            let headers: js::Array = object.get("headers").expect("headers");
            assert_eq!(headers.len(), 4, "two flat name/value pairs");
            assert_eq!(headers.get::<String>(0).expect("name"), "Host");
            assert_eq!(headers.get::<String>(1).expect("value"), "example.com");
            assert_eq!(
                headers.get::<String>(3).expect("value"),
                "5",
                "wire order and case survive"
            );

            let body: js::Object = object.get("body").expect("body");
            assert_eq!(body.get::<_, String>("kind").expect("kind"), "length");
            assert_eq!(body.get::<_, f64>("length").expect("length"), 5.0);

            let event = Event::Http(HttpEvent::Response {
                status: 204,
                reason: "No Content".to_owned(),
                version: 0x10,
                headers: Vec::new(),
                keep_alive: false,
                body: BodyMode::None,
            });
            let (name, payload) = event_to_js(&ctx, &event).expect("event");
            assert_eq!(name, "response");
            let object = payload.as_object().expect("object");
            assert_eq!(object.get::<_, u16>("status").expect("status"), 204);
            assert_eq!(object.get::<_, i32>("version").expect("version"), 0x10);
            let body: js::Object = object.get("body").expect("body");
            assert_eq!(body.get::<_, String>("kind").expect("kind"), "none");
            let length: js::Value = body.get("length").expect("length");
            assert!(length.is_null());
        });
    }

    #[test]
    fn message_end_and_upgrade_match_the_contract() {
        with_ctx(|ctx| {
            let event = Event::Http(HttpEvent::MessageEnd {
                trailers: vec![("X-Sum".to_owned(), "abc".to_owned())],
            });
            let (name, payload) = event_to_js(&ctx, &event).expect("event");
            assert_eq!(name, "messageEnd");
            let object = payload.as_object().expect("object");
            let trailers: js::Array = object.get("trailers").expect("trailers");
            assert_eq!(trailers.len(), 2);
            assert_eq!(trailers.get::<String>(0).expect("name"), "X-Sum");

            let event = Event::Http(HttpEvent::Upgrade { bytes: vec![42] });
            let (name, payload) = event_to_js(&ctx, &event).expect("event");
            assert_eq!(name, "upgrade");
            assert!(payload
                .as_object()
                .and_then(|object| object.as_typed_array::<u8>())
                .is_some());
        });
    }
}
