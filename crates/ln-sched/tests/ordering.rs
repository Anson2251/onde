//! Executable spec for ADR-0002. Each test encodes a program whose expected output was measured
//! against `node v26.10.0` (and, for the shared-FIFO case, `qjs 0.17.0`).
//!
//! The point is not to test this crate; it is to pin the *contract* that `ln-engine` must
//! satisfy when it maps these jobs onto `JS_ExecutePendingJob` / `JS_JobRun`.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::{Duration, Instant};

use ln_sched::{Budget, Checkpoint, ErrorInfo, Event, HandleOutcome, PromiseKey, Scheduler};

#[derive(Clone, Default)]
struct Trace(Rc<RefCell<Vec<String>>>);

impl Trace {
    fn new() -> Self {
        Self::default()
    }

    fn push(&self, line: impl Into<String>) {
        self.0.borrow_mut().push(line.into());
    }

    fn lines(&self) -> Vec<String> {
        self.0.borrow().clone()
    }
}

fn mark(
    t: &Trace,
    msg: &'static str,
) -> impl FnOnce(&mut Scheduler) -> Result<(), ErrorInfo> + 'static {
    let t = t.clone();
    move |_| {
        t.push(msg);
        Ok(())
    }
}

fn feed(s: &mut Scheduler, count: Rc<Cell<u32>>) {
    s.queue_microtask("self-feeding microtask", move |s| {
        count.set(count.get() + 1);
        feed(s, count.clone());
        Ok(())
    });
}

/// C1: nextTick outranks promise jobs; a microtask queued from a tick runs after the microtasks
/// already queued.
#[test]
fn c1_next_tick_outranks_microtasks() {
    let t = Trace::new();
    let mut s = Scheduler::new();

    let t_tick = t.clone();
    let t_tick2 = t.clone();
    s.queue_tick("nextTick#1", move |s| {
        t_tick.push("tick1");
        let t_micro = t_tick.clone();
        s.queue_microtask("queueMicrotask(from nextTick#1)", move |_| {
            t_micro.push("micro-from-tick");
            Ok(())
        });
        let t2 = t_tick2.clone();
        s.queue_tick("nextTick#2", move |_| {
            t2.push("tick2");
            Ok(())
        });
        Ok(())
    });
    s.queue_microtask("queueMicrotask#1", mark(&t, "micro1"));
    s.queue_promise_reaction("then#1", mark(&t, "then1"));

    t.push("sync");

    assert_eq!(s.checkpoint(), Checkpoint::Drained { jobs: 5 });
    assert_eq!(
        t.lines(),
        [
            "sync",
            "tick1",
            "tick2",
            "micro1",
            "then1",
            "micro-from-tick"
        ]
    );
}

/// C2: a throwing microtask is reported inline and the remaining microtasks still run.
#[test]
fn c2_throwing_microtask_reports_inline_and_drain_continues() {
    let t = Trace::new();
    let mut s = Scheduler::new();

    let sink_t = t.clone();
    s.set_event_sink(move |ev| {
        if let Event::Uncaught { error, .. } = ev {
            sink_t.push(format!("uncaught:{}", error.message));
        }
    });

    let t1 = t.clone();
    s.queue_microtask("m1", move |_| {
        t1.push("m1");
        Err(ErrorInfo::message("boom"))
    });
    s.queue_microtask("m2", mark(&t, "m2"));
    s.queue_promise_reaction("then1", mark(&t, "then1"));

    assert!(matches!(s.checkpoint(), Checkpoint::Drained { .. }));
    assert_eq!(t.lines(), ["m1", "uncaught:boom", "m2", "then1"]);
}

/// C3: an unhandled rejection is reported after both queues drain, and before the next phase.
#[test]
fn c3_unhandled_rejection_reported_after_microtasks() {
    let t = Trace::new();
    let mut s = Scheduler::new();

    let sink_t = t.clone();
    s.set_event_sink(move |ev| {
        if let Event::UnhandledRejection { reason, .. } = ev {
            sink_t.push(format!("unhandled:{reason}"));
        }
    });

    s.reject(PromiseKey(1), "r1");
    s.queue_tick("t1", mark(&t, "t1"));
    s.queue_microtask("m1", mark(&t, "m1"));

    s.checkpoint();
    t.push("timer");

    assert_eq!(t.lines(), ["t1", "m1", "unhandled:r1", "timer"]);
}

/// C4: a rejection handled inside the same checkpoint is never reported.
#[test]
fn c4_rejection_handled_in_same_checkpoint_is_silent() {
    let t = Trace::new();
    let mut s = Scheduler::new();

    s.reject(PromiseKey(2), "r2");
    let t_attach = t.clone();
    s.queue_microtask("attach catch", move |s| {
        assert_eq!(s.handle(PromiseKey(2)), HandleOutcome::Candidate);
        let t_catch = t_attach.clone();
        s.queue_microtask("catch handler", move |_| {
            t_catch.push("caught:r2");
            Ok(())
        });
        Ok(())
    });
    s.queue_microtask("m2", mark(&t, "m2"));

    s.checkpoint();

    assert_eq!(t.lines(), ["m2", "caught:r2"]);
    assert!(!s
        .events()
        .iter()
        .any(|e| matches!(e, Event::UnhandledRejection { .. })));
}

/// C5: a nextTick queued from a microtask runs only after the microtask queue is empty.
#[test]
fn c5_tick_from_microtask_runs_after_all_microtasks() {
    let t = Trace::new();
    let mut s = Scheduler::new();

    let t_m1 = t.clone();
    let t_tick = t.clone();
    s.queue_microtask("m1", move |s| {
        t_m1.push("m1");
        let t = t_tick.clone();
        s.queue_tick("tick-from-m1", move |_| {
            t.push("tick-from-m1");
            Ok(())
        });
        Ok(())
    });
    s.queue_microtask("m2", mark(&t, "m2"));

    s.checkpoint();
    assert_eq!(t.lines(), ["m1", "m2", "tick-from-m1"]);
}

/// C6: a rejection reported in one checkpoint and handled later emits `rejectionHandled`.
#[test]
fn c6_late_handler_emits_rejection_handled() {
    let mut s = Scheduler::new();
    s.reject(PromiseKey(3), "r3");
    s.checkpoint();

    assert_eq!(
        s.events(),
        &[Event::UnhandledRejection {
            promise: PromiseKey(3),
            reason: "r3".to_string()
        }]
    );

    // `rejectionHandled` is deferred to the end of the checkpoint in which the handler was
    // attached, so it lands after the catch reaction (Node's order).
    assert_eq!(s.handle(PromiseKey(3)), HandleOutcome::Reported);
    assert!(!s
        .events()
        .iter()
        .any(|event| matches!(event, Event::RejectionHandled { .. })));

    s.checkpoint();
    assert_eq!(
        s.events().last(),
        Some(&Event::RejectionHandled {
            promise: PromiseKey(3)
        })
    );
}

/// I2 / C7: a checkpoint requested from inside a checkpoint is a no-op.
#[test]
fn c7_nested_checkpoint_is_a_noop() {
    let t = Trace::new();
    let mut s = Scheduler::new();

    let t_outer = t.clone();
    s.queue_microtask("outer", move |s| {
        s.queue_microtask("inner", mark(&t_outer, "inner"));
        assert_eq!(s.checkpoint(), Checkpoint::Nested);
        t_outer.push("outer-done");
        Ok(())
    });

    s.checkpoint();
    assert_eq!(t.lines(), ["outer-done", "inner"]);
}

/// I9: a self-feeding microtask chain is stopped by the job budget, with work left queued.
#[test]
fn c8_budget_stops_self_feeding_microtasks() {
    let mut s = Scheduler::new();
    s.set_budget(Budget::jobs(3));
    feed(&mut s, Rc::new(Cell::new(0)));

    assert_eq!(s.checkpoint(), Checkpoint::BudgetExceeded { jobs: 3 });
    assert_eq!(s.pending(), (0, 1));
    assert!(matches!(
        s.events().last(),
        Some(Event::BudgetExceeded {
            jobs: 3,
            micros_pending: 1,
            ..
        })
    ));
}

/// Wall-clock budgets use the injected clock, so this test does not sleep.
#[test]
fn c9_wall_clock_budget_uses_injected_clock() {
    let base = Instant::now();
    let ticks = Rc::new(Cell::new(0u64));
    let clock = {
        let ticks = ticks.clone();
        move || base + Duration::from_millis(ticks.get())
    };

    let mut s = Scheduler::new();
    s.set_clock(clock);
    s.set_budget(Budget {
        max_jobs_per_checkpoint: None,
        max_wall_per_checkpoint: Some(Duration::from_millis(10)),
    });

    for i in 0..10 {
        let t = ticks.clone();
        s.queue_microtask("slow", move |_| {
            t.set(t.get() + 4);
            // Keep the closure from being optimised into something else.
            let _ = i;
            Ok(())
        });
    }

    assert!(matches!(s.checkpoint(), Checkpoint::BudgetExceeded { .. }));
    assert!(s.pending().1 > 0);
}

/// C12 / engine check: `queueMicrotask` and promise reactions share one FIFO.
#[test]
fn c12_queue_microtask_shares_fifo_with_promise_reactions() {
    let t = Trace::new();
    let mut s = Scheduler::new();

    s.queue_microtask("qm1", mark(&t, "qm1"));
    s.queue_promise_reaction("then1", mark(&t, "then1"));
    let t_then2 = t.clone();
    s.queue_promise_reaction("then2", move |s| {
        t_then2.push("then2");
        let t = t_then2.clone();
        s.queue_microtask("qm-from-then2", move |_| {
            t.push("qm-from-then2");
            Ok(())
        });
        Ok(())
    });
    s.queue_microtask("qm2", mark(&t, "qm2"));

    t.push("sync");
    s.checkpoint();

    assert_eq!(
        t.lines(),
        ["sync", "qm1", "then1", "then2", "qm2", "qm-from-then2"]
    );
}

/// C11: a rejection created inside a job is reported at the end of the same checkpoint.
#[test]
fn c11_rejection_from_a_job_is_reported_at_checkpoint_end() {
    let t = Trace::new();
    let mut s = Scheduler::new();

    let sink_t = t.clone();
    s.set_event_sink(move |ev| {
        if let Event::UnhandledRejection { reason, .. } = ev {
            sink_t.push(format!("unhandled:{reason}"));
        }
    });

    s.queue_microtask("throwing then", move |s| {
        s.reject(PromiseKey(9), "in-then");
        Ok(())
    });
    s.queue_microtask("m2", mark(&t, "m2"));

    s.checkpoint();
    assert_eq!(t.lines(), ["m2", "unhandled:in-then"]);
}

/// I10: queued jobs (and the values they hold) are released on shutdown.
#[test]
fn c13_shutdown_releases_queued_jobs() {
    struct Guard(Trace);
    impl Drop for Guard {
        fn drop(&mut self) {
            self.0.push("dropped");
        }
    }

    let t = Trace::new();
    let guard = Guard(t.clone());
    let mut s = Scheduler::new();
    s.queue_microtask("holds a value", move |_| {
        let _held = guard;
        Ok(())
    });

    s.shutdown();

    assert_eq!(s.pending(), (0, 0));
    assert_eq!(s.dropped_on_shutdown(), 1);
    assert_eq!(t.lines(), ["dropped"]);
}

/// nextTick queued from a timer callback is not drained by the checkpoint that follows an
/// earlier callback; it is drained by the *next* checkpoint, in tick order.
#[test]
fn multiple_checkpoints_do_not_share_queues() {
    let t = Trace::new();
    let mut s = Scheduler::new();

    s.queue_microtask("turn1", mark(&t, "turn1"));
    s.checkpoint();

    let t_tick = t.clone();
    s.queue_tick("turn2 tick", move |s| {
        t_tick.push("turn2-tick");
        let t_inner = t_tick.clone();
        s.queue_microtask("turn2 micro", move |_| {
            t_inner.push("turn2-micro");
            Ok(())
        });
        Ok(())
    });
    s.checkpoint();

    assert_eq!(t.lines(), ["turn1", "turn2-tick", "turn2-micro"]);
    assert_eq!(s.checkpoints_run(), 2);
}
