//! The engine's memory surface: one hard limit, heap accounting, and the two GC entry points.
//!
//! QuickJS enforces `JS_SetMemoryLimit` per `JSRuntime`, and there is no old/young split (m7-plan
//! §3.3). These tests pin what the runtime will build on: a limit set before any user script and
//! one set on a live engine both fail the allocation that crosses it as a JavaScript exception
//! (not an abort), and the accounting reports the limit it was given.

use ln_engine::Engine;

/// Allocate until the runtime refuses. The arrays stay reachable, so a collection cannot reclaim
/// its way back under the limit.
const ALLOCATE_PAST_THE_LIMIT: &str = "\
    var kept = [];\n\
    for (;;) { kept.push(new Array(65536).fill(1)); }\n";

const HEADROOM: u64 = 2 * 1024 * 1024;

/// A limit comfortably above the engine's current usage, so the loop is what trips it rather
/// than the engine being unable to start.
fn limit_with_headroom(engine: &Engine) -> u64 {
    let baseline = engine.heap_statistics().malloc_size;
    baseline + HEADROOM
}

#[test]
fn a_limit_set_before_boot_trips() {
    let engine = Engine::new().expect("engine");
    // "Before boot" for this crate: the runtime exists, but no host or user script has run yet.
    engine.set_memory_limit(limit_with_headroom(&engine));

    let error = engine
        .eval_global(ALLOCATE_PAST_THE_LIMIT, "<memory-limit>")
        .expect_err("the loop crosses the limit");
    assert!(
        error.body().contains("out of memory"),
        "expected the engine's out-of-memory error, got: {}",
        error.body()
    );

    // The limit is back to unlimited so dropping the engine cannot free-run into it.
    engine.set_memory_limit(0);
}

#[test]
fn a_limit_set_after_boot_trips() {
    let engine = Engine::new().expect("engine");
    engine
        .eval_global("globalThis.__booted = true;", "<boot>")
        .expect("boot script evaluates");

    engine.set_memory_limit(limit_with_headroom(&engine));
    let error = engine
        .eval_global(ALLOCATE_PAST_THE_LIMIT, "<memory-limit>")
        .expect_err("the loop crosses the limit");
    assert!(
        error.body().contains("out of memory"),
        "expected the engine's out-of-memory error, got: {}",
        error.body()
    );

    engine.set_memory_limit(0);
    let booted: bool = engine.with_ctx(|ctx| ctx.globals().get("__booted").expect("__booted"));
    assert!(booted, "the failed allocation must not undo earlier state");
}

#[test]
fn heap_statistics_reports_usage_and_the_limit() {
    let engine = Engine::new().expect("engine");
    let unlimited = engine.heap_statistics();
    assert!(unlimited.malloc_size > 0, "a live runtime has a heap");
    assert_eq!(unlimited.malloc_limit, 0, "0 means unlimited");

    let limit = unlimited.malloc_size + 8 * 1024 * 1024;
    engine.set_memory_limit(limit);
    let limited = engine.heap_statistics();
    assert_eq!(limited.malloc_limit, limit);
    assert!(limited.malloc_size > 0);
    assert!(limited.memory_used_size > 0);
    assert!(limited.malloc_count > 0);
    assert!(limited.memory_used_count > 0);
    assert!(limited.atom_size > 0, "the atom table is never empty");

    engine.set_memory_limit(0);
    assert_eq!(engine.heap_statistics().malloc_limit, 0);
}

#[test]
fn gc_runs_and_the_threshold_is_accepted() {
    let engine = Engine::new().expect("engine");
    engine
        .eval_global(
            "globalThis.__cycle = (() => { const a = {}; a.self = a; return a; })();",
            "<gc>",
        )
        .expect("cycle evaluates");

    engine.gc();
    let after = engine.heap_statistics();
    assert!(after.malloc_size > 0);

    // A low threshold forces a collection at the next allocation; the engine then replaces it
    // with its own growth heuristic, which is why this is a test hook and not a tuning knob.
    engine.set_gc_threshold(1024 * 1024);
    engine
        .eval_global("globalThis.__more = new Array(1024).fill(1);", "<gc>")
        .expect("allocation after the threshold evaluates");
    engine.gc();

    // The engine stayed coherent: accounting still reads, and JavaScript still runs.
    assert!(engine.heap_statistics().malloc_size > 0);
    engine
        .eval_global("globalThis.__after_gc = true;", "<gc>")
        .expect("engine still evaluates");
}
