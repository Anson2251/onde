//! The process-handle bridge: children, their pipes and the forked child's IPC channel
//! (M5, ADR-0008 §2.6; `docs/m5-plan.md` §3.2/§3.5).
//!
//! One child is one id (`ln_io::proc::ChildId`) and one task. The task's events arrive through the
//! shared completion channel, exactly like a network handle's (ADR-0006 §2.3): the sink parks them
//! per id, sends one `Completion(id)`, and the loop drains that id's queue on the isolate thread.
//!
//! Two invariants are worth stating because they are easy to get wrong:
//!
//! * **The child holds one loop ref** (H3′) from `spawn` until `close`. A missing program emits
//!   `error` instead of `spawned`, and that path releases the ref too, or the process would hang.
//! * **No event after shutdown** (H4′): the sink gate is the same one the worker bridge uses, and
//!   `shutdown` drains the parked queues before the engine is dropped.
//!
//! The IPC channel of a forked child is a singleton process capability, not a family: it has a
//! reserved completion id, one session, and `process.send`/`message` in JS.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use ln_engine::{js, CaughtError, Engine};
use ln_error::NodeError;
use ln_io::proc::{
    channel_from_raw_fd, ChildId, ChildService, Command, Event, IpcChannel, IpcEvent, IpcSession,
    SpawnOptions,
};
use ln_sched::{Completion, CompletionSender, Driver};

use crate::host_error::node_error_value;
use crate::ops::OpBridge;

/// The reserved completion id for the forked child's IPC channel. Real ids start at 1 and signals
/// reserve `u64::MAX`, so this one is unambiguous (see `signals::SIGNAL_COMPLETION_ID`).
pub(crate) const IPC_COMPLETION_ID: u64 = u64::MAX - 1;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

type Parked = Arc<Mutex<HashMap<ChildId, VecDeque<Event>>>>;

/// Serializes `emit` against `shutdown` so no event is delivered after shutdown returns (H4′).
struct Gate {
    open: AtomicBool,
    barrier: Mutex<()>,
}

impl Gate {
    fn new() -> Self {
        Gate {
            open: AtomicBool::new(true),
            barrier: Mutex::new(()),
        }
    }

    fn close(&self) {
        let _barrier = lock(&self.barrier);
        self.open.store(false, Ordering::SeqCst);
    }
}

/// Owns the child processes of this isolate.
pub(crate) struct ProcBridge {
    ids: Arc<crate::ops::RequestIdAllocator>,
    driver: Rc<RefCell<Driver>>,
    parked: Parked,
    gate: Arc<Gate>,
    sink: ln_io::proc::EventSink,
    service: OnceLock<Result<ChildService, NodeError>>,
    ops: Rc<OpBridge>,
    live: RefCell<HashSet<ChildId>>,
    refs: RefCell<HashSet<ChildId>>,
    /// Children that emitted `spawned`; `error` before that releases the ref (no `close` follows).
    started: RefCell<HashSet<ChildId>>,
}

impl ProcBridge {
    pub(crate) fn new(
        driver: Rc<RefCell<Driver>>,
        sender: CompletionSender,
        ids: Arc<crate::ops::RequestIdAllocator>,
        ops: Rc<OpBridge>,
    ) -> Self {
        let parked: Parked = Arc::new(Mutex::new(HashMap::new()));
        let gate = Arc::new(Gate::new());
        let sink = {
            let parked = parked.clone();
            let sender = Mutex::new(sender);
            let gate = gate.clone();
            Arc::new(move |id: ChildId, event: Event| {
                let _barrier = lock(&gate.barrier);
                if !gate.open.load(Ordering::SeqCst) {
                    return;
                }
                lock(&parked).entry(id).or_default().push_back(event);
                let _ = lock(&sender).send(Completion(id));
            })
        };
        ProcBridge {
            ids,
            driver,
            parked,
            gate,
            sink,
            service: OnceLock::new(),
            ops,
            live: RefCell::new(HashSet::new()),
            refs: RefCell::new(HashSet::new()),
            started: RefCell::new(HashSet::new()),
        }
    }

    /// Start a child. `ipc` is the parent end for `fork`; `ipc_child` is the descriptor the child
    /// gets on fd 3.
    pub(crate) fn spawn(
        &self,
        id: ChildId,
        options: SpawnOptions,
        ipc: Option<IpcChannel>,
        ipc_child: Option<std::os::fd::OwnedFd>,
    ) -> Result<(), NodeError> {
        if id == 0 {
            return Ok(());
        }
        self.ids.observe(id);
        if !self.gate.open.load(Ordering::SeqCst) {
            return Ok(());
        }
        let service = self.service()?;
        self.activate(id);
        // The service starts the task; a synchronous failure means nothing was spawned, so the
        // ref must come back.
        if let Err(error) = service.spawn_with_ipc_child(id, options, ipc, ipc_child) {
            self.release_ref(id);
            self.live.borrow_mut().remove(&id);
            return Err(error);
        }
        Ok(())
    }

    pub(crate) fn command(&self, id: ChildId, command: Command) {
        if id == 0 {
            return;
        }
        if let Some(Ok(service)) = self.service.get() {
            service.command(id, command);
        }
    }

    pub(crate) fn take(&self, id: ChildId) -> Option<VecDeque<Event>> {
        lock(&self.parked).remove(&id)
    }

    /// Bookkeeping before dispatch: `spawned` marks a live child; `close` (or an `error` before
    /// `spawned`) is the end of its life and releases the loop ref exactly once.
    pub(crate) fn observe(&self, id: ChildId, events: &VecDeque<Event>) {
        for event in events {
            match event {
                Event::Spawned { .. } => {
                    self.started.borrow_mut().insert(id);
                }
                Event::Close { .. } => {
                    self.started.borrow_mut().remove(&id);
                    self.live.borrow_mut().remove(&id);
                    self.release_ref(id);
                }
                Event::Error { .. } if !self.started.borrow().contains(&id) => {
                    self.live.borrow_mut().remove(&id);
                    self.release_ref(id);
                }
                _ => {}
            }
        }
    }

    pub(crate) fn ref_child(&self, id: ChildId) {
        if self.live.borrow().contains(&id) {
            self.take_ref(id);
        }
    }

    pub(crate) fn unref_child(&self, id: ChildId) {
        self.release_ref(id);
    }

    pub(crate) fn shutdown(&self) {
        self.gate.close();
        if let Some(Ok(service)) = self.service.get() {
            service.shutdown();
        }
        lock(&self.parked).clear();
        self.live.borrow_mut().clear();
        self.started.borrow_mut().clear();
        let released: Vec<ChildId> = self.refs.borrow_mut().drain().collect();
        let mut driver = self.driver.borrow_mut();
        for _ in released {
            driver.unref_external();
        }
    }

    pub(crate) fn live_children(&self) -> usize {
        self.live.borrow().len()
    }

    pub(crate) fn held_refs(&self) -> usize {
        self.refs.borrow().len()
    }

    fn activate(&self, id: ChildId) {
        self.live.borrow_mut().insert(id);
        self.take_ref(id);
    }

    fn take_ref(&self, id: ChildId) {
        if self.refs.borrow_mut().insert(id) {
            self.driver.borrow_mut().ref_external();
        }
    }

    fn release_ref(&self, id: ChildId) {
        if self.refs.borrow_mut().remove(&id) {
            self.driver.borrow_mut().unref_external();
        }
    }

    fn service(&self) -> Result<&ChildService, NodeError> {
        let result = self.service.get_or_init(|| {
            let pool = self.ops.pool()?;
            let ids = self.ids.clone();
            let source: ln_io::proc::ChildIdSource = Arc::new(move || ids.allocate());
            Ok(ChildService::new(
                pool,
                self.sink.clone(),
                source,
                self.ops.permit().clone(),
            ))
        });
        result.as_ref().map_err(|error| error.clone())
    }
}

/// One IPC channel for the forked child, attached on the first `process.send`/listener.
pub(crate) struct IpcBridge {
    driver: Rc<RefCell<Driver>>,
    sender: CompletionSender,
    parked: Arc<Mutex<VecDeque<IpcEvent>>>,
    session: OnceLock<Result<IpcSession, NodeError>>,
    open: Arc<AtomicBool>,
    ops: Rc<OpBridge>,
    refed: std::cell::Cell<bool>,
}

impl IpcBridge {
    pub(crate) fn new(
        driver: Rc<RefCell<Driver>>,
        sender: CompletionSender,
        ops: Rc<OpBridge>,
    ) -> Self {
        IpcBridge {
            driver,
            sender,
            parked: Arc::new(Mutex::new(VecDeque::new())),
            session: OnceLock::new(),
            open: Arc::new(AtomicBool::new(true)),
            ops,
            refed: std::cell::Cell::new(false),
        }
    }

    /// Attach fd 3 (the `fork` protocol). Returns false when this process is not a forked child.
    pub(crate) fn attach(&self, fd: Option<i32>) -> Result<bool, NodeError> {
        let Some(fd) = fd else {
            return Ok(false);
        };
        if self.session.get().is_some() {
            return Ok(true);
        }
        let result = self.session.get_or_init(|| {
            let pool = self.ops.pool()?;
            let channel = channel_from_raw_fd(fd)?;
            let parked = self.parked.clone();
            let sender = Mutex::new(self.sender.clone());
            let open = self.open.clone();
            let sink: ln_io::proc::IpcSink = Arc::new(move |event: IpcEvent| {
                if !open.load(Ordering::SeqCst) {
                    return;
                }
                lock(&parked).push_back(event);
                let _ = lock(&sender).send(Completion(IPC_COMPLETION_ID));
            });
            IpcSession::attach(pool, channel, sink)
        });
        match result {
            Ok(_) => {
                self.take_ref();
                Ok(true)
            }
            Err(error) => Err(error.clone()),
        }
    }

    pub(crate) fn send(&self, payload: String) -> Result<(), NodeError> {
        let session = self
            .session
            .get()
            .ok_or_else(|| NodeError::new("ERR_IPC_CHANNEL_CLOSED", "Channel closed"))?;
        session
            .as_ref()
            .map_err(|error| error.clone())?
            .send(payload.into_bytes())
    }

    pub(crate) fn disconnect(&self) {
        if let Some(Ok(session)) = self.session.get() {
            session.disconnect();
        }
    }

    /// `process.channel.ref()`: take the IPC channel's loop ref back.
    pub(crate) fn ref_channel(&self) {
        if self.session.get().is_some() {
            self.take_ref();
        }
    }

    /// `process.channel.unref()`: let the loop exit while the channel stays open.
    pub(crate) fn unref_channel(&self) {
        self.release_ref();
    }

    /// Bookkeeping before dispatch: the channel no longer keeps the loop alive once it closes.
    pub(crate) fn observe(&self, events: &[IpcEvent]) {
        if events
            .iter()
            .any(|event| matches!(event, IpcEvent::Disconnect | IpcEvent::Error(_)))
        {
            self.release_ref();
        }
    }

    pub(crate) fn take(&self) -> Vec<IpcEvent> {
        lock(&self.parked).drain(..).collect()
    }

    pub(crate) fn shutdown(&self) {
        self.open.store(false, Ordering::SeqCst);
        if let Some(Ok(session)) = self.session.get() {
            session.disconnect();
        }
        lock(&self.parked).clear();
        self.release_ref();
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
}

// --- event conversion (isolate thread only) --------------------------------------------------

/// Dispatch one child's event batch through `__ln_proc_event`, in task order.
pub(crate) fn dispatch_proc_events(
    engine: &Engine,
    id: ChildId,
    events: VecDeque<Event>,
) -> Result<(), CaughtError> {
    engine.with_ctx(|ctx| {
        let result: js::Result<()> = (|| {
            let callback: js::Function = ctx.globals().get("__ln_proc_event")?;
            for event in events {
                let (name, payload) = proc_event_to_js(&ctx, &event)?;
                callback.call::<_, ()>((id, name, payload))?;
            }
            Ok(())
        })();
        js::CatchResultExt::catch(result, &ctx)
            .map_err(|error| ln_engine::caught_to_owned(&ctx, error))
    })
}

fn proc_event_to_js<'js>(
    ctx: &js::Ctx<'js>,
    event: &Event,
) -> js::Result<(&'static str, js::Value<'js>)> {
    let undefined = || js::Value::new_undefined(ctx.clone());
    Ok(match event {
        Event::Spawned { pid } => {
            let payload = js::Object::new(ctx.clone())?;
            payload.set("pid", *pid)?;
            ("spawn", payload.into_value())
        }
        Event::Data { stream, bytes } => {
            let payload = js::Object::new(ctx.clone())?;
            payload.set("stream", stream.as_str())?;
            payload.set(
                "bytes",
                js::TypedArray::<u8>::new(ctx.clone(), bytes.clone())?,
            )?;
            ("data", payload.into_value())
        }
        Event::End { stream } => {
            let payload = js::Object::new(ctx.clone())?;
            payload.set("stream", stream.as_str())?;
            ("end", payload.into_value())
        }
        Event::Drain { stream } => {
            let payload = js::Object::new(ctx.clone())?;
            payload.set("stream", stream.as_str())?;
            ("drain", payload.into_value())
        }
        Event::Exit { code, signal } | Event::Close { code, signal } => {
            let name = if matches!(event, Event::Exit { .. }) {
                "exit"
            } else {
                "close"
            };
            let payload = js::Object::new(ctx.clone())?;
            match code {
                Some(code) => payload.set("code", *code)?,
                None => payload.set("code", js::Value::new_null(ctx.clone()))?,
            }
            match signal {
                Some(signal) => payload.set(
                    "signal",
                    ln_io::signal::signal_name(*signal).unwrap_or("SIGUNKNOWN"),
                )?,
                None => payload.set("signal", js::Value::new_null(ctx.clone()))?,
            }
            (name, payload.into_value())
        }
        Event::Error { error } => ("error", node_error_value(ctx, error)?),
        Event::Message { bytes } => {
            let payload = js::Object::new(ctx.clone())?;
            payload.set("text", String::from_utf8_lossy(bytes).into_owned())?;
            ("message", payload.into_value())
        }
        Event::Disconnect => ("disconnect", undefined()),
    })
}

/// Dispatch the forked child's IPC events through `__ln_ipc_event`.
pub(crate) fn dispatch_ipc_events(
    engine: &Engine,
    events: Vec<IpcEvent>,
) -> Result<(), CaughtError> {
    engine.with_ctx(|ctx| {
        let result: js::Result<()> = (|| {
            let callback: js::Function = ctx.globals().get("__ln_ipc_event")?;
            for event in events {
                match event {
                    IpcEvent::Message(bytes) => {
                        callback.call::<_, ()>((
                            "message",
                            String::from_utf8_lossy(&bytes).into_owned(),
                        ))?;
                    }
                    IpcEvent::Disconnect => callback
                        .call::<_, ()>(("disconnect", js::Value::new_undefined(ctx.clone())))?,
                    IpcEvent::Error(error) => {
                        callback.call::<_, ()>(("error", node_error_value(&ctx, &error)?))?
                    }
                }
            }
            Ok(())
        })();
        js::CatchResultExt::catch(result, &ctx)
            .map_err(|error| ln_engine::caught_to_owned(&ctx, error))
    })
}
