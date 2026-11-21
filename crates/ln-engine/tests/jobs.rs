//! The host-owned job queue (M6).
//!
//! These tests drive the patched engine directly: no runtime, no bootstrap, no scheduler. They
//! assert the three properties the scheduler depends on and that an unpatched engine cannot
//! offer:
//!
//! 1. every job the engine creates is handed to the host, in enqueue order (the engine's own
//!    list stays empty);
//! 2. a job carries the async tag of the promise whose reaction it is, so `before`/`after` can
//!    name the right resource;
//! 3. a job's payload survives a garbage collection between enqueue and run (ADR-0002 G11).

use std::rc::Rc;

use ln_engine::{js, Engine, PumpOutcome};

/// Evaluate `source`, then drain the job queue and return the tags of the jobs that ran.
fn drain(engine: &Engine, source: &str) -> Vec<i64> {
    engine.eval_global(source, "<test>").expect("evaluate");
    let mut tags = Vec::new();
    while let Some(tag) = engine.next_job_tag() {
        tags.push(tag);
        match engine.run_next_job() {
            PumpOutcome::Executed { tag: ran } => assert_eq!(tag, ran),
            other => panic!("unexpected job outcome: {other:?}"),
        }
    }
    tags
}

#[test]
fn the_engine_hands_every_job_to_the_host() {
    let engine = Engine::new().expect("engine");
    let tags = drain(
        &engine,
        "Promise.resolve(1).then((v) => (globalThis.r = v + 1));",
    );
    assert_eq!(tags.len(), 1, "one reaction, one job");
    assert_eq!(
        engine.queued_jobs(),
        0,
        "the queue is empty after the drain"
    );
    // `has_jobs` asserts in debug builds that the engine's internal list is empty: with the hook
    // installed it must stay that way for the whole isolate lifetime.
    assert!(!engine.has_jobs());
}

#[test]
fn jobs_run_in_enqueue_order() {
    let engine = Engine::new().expect("engine");
    let tags = drain(
        &engine,
        r#"
        globalThis.order = [];
        Promise.resolve().then(() => order.push("first"));
        Promise.resolve()
          .then(() => order.push("second"))
          .then(() => order.push("third"));
        "#,
    );
    assert_eq!(tags.len(), 3);
    let text = engine.with_ctx(|ctx| {
        let order: js::Array = ctx.globals().get("order").expect("order");
        let mut items = Vec::new();
        for value in order.iter::<js::String>() {
            items.push(value.expect("string").to_string().expect("utf8"));
        }
        items.join(",")
    });
    assert_eq!(text, "first,second,third");
}

#[test]
fn reaction_jobs_carry_the_derived_promises_tag() {
    let engine = Rc::new(Engine::new().expect("engine"));
    // Tag every promise with its id at INIT, exactly like the runtime's promise hook.
    let next = std::rc::Rc::new(std::cell::Cell::new(2i64));
    {
        let next = next.clone();
        let inner = engine.clone();
        engine.set_promise_hook(move |ctx, kind, promise, _parent| {
            if matches!(kind, js::promise::PromiseHookType::Init) {
                let id = next.get();
                next.set(id + 1);
                inner.set_promise_tag(&ctx, &promise, id);
            }
        });
    }
    let tags = drain(&engine, "Promise.resolve(1).then(() => {});");
    assert_eq!(tags.len(), 1);
    // p is id 2, the derived promise is 3, and the reaction belongs to the derived promise:
    // Node runs a `then` callback as the promise `.then()` created.
    assert_eq!(tags[0], 3);
}

#[test]
fn a_job_payload_survives_gc_between_enqueue_and_run() {
    let engine = Engine::new().expect("engine");
    // The promise reaction holds a cyclic object graph whose only outside reference is the job
    // itself. If a collection between enqueue and run dropped it, `run_next_job` would throw.
    engine
        .eval_global(
            r#"
            globalThis.seen = "not run";
            const cycle = { name: "payload" };
            cycle.self = cycle;
            Promise.resolve().then(() => { globalThis.seen = cycle.name; });
            "#,
            "<test>",
        )
        .expect("evaluate");

    assert!(engine.next_job_tag().is_some(), "a job is queued");
    // `JS_RunGC` through the safe API: allocating a lot is the portable way to force the
    // collector without reaching into the runtime internals.
    engine
        .eval_global(
            "for (let i = 0; i < 20000; i += 1) { const x = { i, data: new Array(8).fill(i) }; }",
            "<gc>",
        )
        .expect("allocate");

    let outcome = engine.run_next_job();
    assert!(
        matches!(outcome, PumpOutcome::Executed { .. }),
        "the job must run after a GC: {outcome:?}"
    );
    let seen = engine.with_ctx(|ctx| ctx.globals().get::<_, String>("seen").expect("seen"));
    assert_eq!(seen, "payload", "the cyclic payload survived");
    assert!(!engine.has_jobs());
}

#[test]
fn a_throwing_job_returns_the_error_and_keeps_the_queue_usable() {
    let engine = Engine::new().expect("engine");
    // A promise handler's throw becomes a rejection (the engine swallows it into the derived
    // promise), so the escaping-exception case has to be a microtask, whose throw unwinds out of
    // the job itself -- exactly what an uncaughtException is built from.
    engine
        .eval_global(
            r#"
            globalThis.ran = false;
            queueMicrotask(() => { throw new Error("boom"); });
            queueMicrotask(() => { globalThis.ran = true; });
            "#,
            "<test>",
        )
        .expect("evaluate");

    match engine.run_next_job() {
        PumpOutcome::Threw { error, .. } => {
            assert_eq!(error.message, "boom");
            assert!(error.is_error);
        }
        other => panic!("expected a throw, got {other:?}"),
    }

    match engine.run_next_job() {
        PumpOutcome::Executed { .. } => {}
        other => panic!("the queue must keep draining after a throw, got {other:?}"),
    }
    let ran = engine.with_ctx(|ctx| ctx.globals().get::<_, bool>("ran").expect("ran"));
    assert!(ran);
    assert!(!engine.has_jobs());
}

#[test]
fn dropping_the_engine_with_queued_jobs_does_not_leak_or_crash() {
    // Teardown order: jobs are freed before the runtime, and the debug assertions in `Drop` fail
    // if any job was adopted and not released.
    let engine = Engine::new().expect("engine");
    engine
        .eval_global(
            "for (let i = 0; i < 32; i += 1) Promise.resolve(i).then(() => {});",
            "<test>",
        )
        .expect("evaluate");
    assert!(engine.has_jobs());
    drop(engine);
}
