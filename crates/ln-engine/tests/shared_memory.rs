//! Cross-isolate shared memory on two OS threads (ADR-0008 §2.3–2.4, M5 WP0).
//!
//! These are the engine-level acceptance tests for worker messaging: the same mechanisms
//! `worker_threads` builds on, without the runtime in the way. Each isolate is constructed on the
//! thread that uses it, mirroring the real worker lifecycle.

use std::sync::mpsc;
use std::sync::{Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

use ln_engine::sab;
use ln_engine::{deserialize, js, serialize, Engine, Serialized};

/// The live-allocation counter is process-global, so tests that assert on it must not overlap.
static LOCK: Mutex<()> = Mutex::new(());

fn guard() -> MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn message(engine: &Engine, source: &str) -> Serialized {
    engine.with_ctx(|ctx| {
        let value: js::Value = ctx.eval(source).expect("eval");
        serialize(&ctx, &value).expect("serialize")
    })
}

#[test]
fn two_engines_on_two_threads_share_a_buffer() {
    let _guard = guard();
    let main = Engine::new().expect("main engine");
    let shared = message(
        &main,
        "globalThis.__keep = new Int32Array(new SharedArrayBuffer(16)); \
         Atomics.store(__keep, 0, 7); __keep",
    );

    let (result_tx, result_rx) = mpsc::channel();
    let (reply_tx, reply_rx) = mpsc::channel::<Serialized>();

    let worker = thread::spawn(move || {
        let engine = Engine::new().expect("worker engine");
        let observed = engine.with_ctx(|ctx| {
            let value = deserialize(&ctx, shared).expect("deserialize");
            ctx.globals().set("__in", value).expect("global");
            ctx.eval::<String, _>("String(Atomics.store(__in, 0, 99))")
                .expect("store")
        });
        // Serialize a value back on this thread, to prove the direction is symmetric.
        let reply = engine.with_ctx(|ctx| {
            let value: js::Value = ctx
                .eval("({ fromWorker: true, value: Atomics.load(__in, 0) })")
                .expect("eval reply");
            serialize(&ctx, &value).expect("serialize reply")
        });
        reply_tx.send(reply).expect("reply channel");
        result_tx.send(observed).expect("result channel");
    });

    let observed = result_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("worker result");
    assert_eq!(
        observed, "99",
        "the worker's store returns the previous value"
    );
    let reply = reply_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("reply");
    let reply = main.with_ctx(|ctx| {
        let value = deserialize(&ctx, reply).expect("deserialize reply");
        ctx.globals().set("__reply", value).expect("global");
        ctx.eval::<String, _>("[__reply.fromWorker, __reply.value].join('|')")
            .expect("reply check")
    });
    assert_eq!(reply, "true|99", "the parent sees the worker's write");
    assert_eq!(
        main.with_ctx(|ctx| ctx.eval::<f64, _>("Atomics.load(__keep, 0)").expect("load")),
        99.0,
        "the parent's view of the buffer changed"
    );
    worker.join().expect("worker thread");
}

#[test]
fn an_atomics_waiter_on_another_thread_is_woken() {
    let _guard = guard();
    let main = Engine::new().expect("main engine");
    let wait_message = message(
        &main,
        "globalThis.__keep = new Int32Array(new SharedArrayBuffer(16)); __keep",
    );

    let (ready_tx, ready_rx) = mpsc::channel();
    let (result_tx, result_rx) = mpsc::channel();
    let waiter = thread::spawn(move || {
        let engine = Engine::new().expect("waiter engine");
        let outcome = engine.with_ctx(|ctx| {
            let value = deserialize(&ctx, wait_message).expect("deserialize");
            ctx.globals().set("__in", value).expect("global");
            // Tell the notifier this isolate is ready, then wait on index 0.
            ctx.eval::<(), _>("Atomics.store(__in, 1, 1)")
                .expect("ready");
            ready_tx.send(()).expect("ready channel");
            ctx.eval::<String, _>("Atomics.wait(__in, 0, 0, 5000)")
                .expect("wait")
        });
        result_tx.send(outcome).expect("result channel");
    });

    ready_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("waiter ready");
    // Wait for the waiter's own handshake so the notify cannot race the wait.
    let mut waited = 0;
    while main.with_ctx(|ctx| {
        ctx.eval::<i32, _>("Atomics.load(__keep, 1)")
            .expect("load ready")
    }) != 1
    {
        thread::sleep(Duration::from_millis(5));
        waited += 1;
        assert!(waited < 400, "the waiter never started");
    }
    thread::sleep(Duration::from_millis(20));
    let notified = main.with_ctx(|ctx| {
        ctx.eval::<i32, _>("Atomics.notify(__keep, 0, 1)")
            .expect("notify")
    });
    assert_eq!(notified, 1, "one waiter was woken");
    let outcome = result_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("waiter result");
    assert_eq!(outcome, "ok", "the waiter woke, it did not time out");
    waiter.join().expect("waiter thread");
}

#[test]
fn ordinary_objects_are_copied_not_shared() {
    let _guard = guard();
    let main = Engine::new().expect("main engine");
    let original = message(&main, "globalThis.__keep = { count: 1 }; __keep");
    let worker = thread::spawn(move || {
        let engine = Engine::new().expect("worker engine");
        engine.with_ctx(|ctx| {
            let value = deserialize(&ctx, original).expect("deserialize");
            ctx.globals().set("__in", value).expect("global");
            ctx.eval::<(), _>("__in.count = 2").expect("mutate");
        });
    });
    worker.join().expect("worker thread");
    let count = main.with_ctx(|ctx| ctx.eval::<i32, _>("__keep.count").expect("load count"));
    assert_eq!(count, 1, "the parent's object was not mutated");
}

/// The message owns a reference: dropping the sender's JS value must not free the block while the
/// message (or the receiver's reconstructed value) is alive.
#[test]
fn a_message_keeps_shared_memory_alive_after_the_sender_drops_it() {
    let _guard = guard();
    let main = Engine::new().expect("main engine");
    let shared = main.with_ctx(|ctx| {
        let value: js::Value = ctx
            .eval("new Int32Array(new SharedArrayBuffer(8))")
            .expect("eval");
        // `value` is dropped at the end of this closure; only the message keeps the block.
        serialize(&ctx, &value).expect("serialize")
    });
    let worker = thread::spawn(move || {
        let engine = Engine::new().expect("worker engine");
        engine.with_ctx(|ctx| {
            let value = deserialize(&ctx, shared).expect("deserialize");
            ctx.globals().set("__in", value).expect("global");
            ctx.eval::<(), _>("Atomics.store(__in, 0, 42); Atomics.add(__in, 0, 1)")
                .expect("store");
            let result = ctx.eval::<i32, _>("Atomics.load(__in, 0)").expect("load");
            assert_eq!(result, 43);
        });
    });
    worker.join().expect("worker thread");
    drop(main);
}

/// The WP0 leak gate: ten thousand distinct shared buffers cross a thread and are released on both
/// sides. Every allocation the sender makes must be gone once both engines are dropped.
#[test]
fn ten_thousand_messages_do_not_leak_shared_allocations() {
    let _guard = guard();
    let baseline = sab::live_allocations();
    let main = Engine::new().expect("main engine");
    let (messages_tx, messages_rx) = mpsc::channel::<Serialized>();

    let worker = thread::spawn(move || {
        let engine = Engine::new().expect("worker engine");
        let mut received = 0usize;
        for message in messages_rx {
            engine.with_ctx(|ctx| {
                let value = deserialize(&ctx, message).expect("deserialize");
                drop(value);
            });
            received += 1;
        }
        // Dropping the engine must release every buffer the worker's values still pinned.
        drop(engine);
        received
    });

    const COUNT: usize = 10_000;
    for _ in 0..COUNT {
        let message = main.with_ctx(|ctx| {
            let value: js::Value = ctx
                .eval("new Int32Array(new SharedArrayBuffer(16))")
                .expect("eval");
            serialize(&ctx, &value).expect("serialize")
        });
        messages_tx.send(message).expect("send");
    }
    drop(messages_tx);
    assert_eq!(worker.join().expect("worker thread"), COUNT);
    drop(main);
    assert_eq!(
        sab::live_allocations(),
        baseline,
        "every shared allocation is released once both isolates are gone"
    );
}
