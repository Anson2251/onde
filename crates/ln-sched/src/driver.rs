//! The event-loop driver: timers, immediates, completions and the exit decision.
//!
//! This is the deterministic policy half of ADR-0003's loop shell. It never touches the engine
//! and never runs a callback; [`Driver::next`] hands the caller one unit of work and the caller
//! is responsible for running it and then checkpointing microtasks.
//!
//! Phase order per turn: **timers (snapshot) → completions → immediates (snapshot) → block**.
//! A timer or immediate scheduled while its own phase is running is picked up next turn.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use crate::timer::{TimerFire, TimerId, TimerQueue, MIN_TIMEOUT};

/// An opaque completion delivered by the reactor (owned Rust payload, never a JS value).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Completion(pub u64);

/// The blocking point of the loop. Real builds use [`Sleeper`]; tests use [`FakeReactor`].
pub trait Reactor {
    /// Block until a completion is available or `timeout` elapses. `None` blocks indefinitely.
    fn wait(&mut self, timeout: Option<Duration>) -> Vec<Completion>;
}

/// The production reactor for M1: there are no I/O completions yet, so it only sleeps.
#[derive(Debug, Default)]
pub struct Sleeper;

impl Reactor for Sleeper {
    fn wait(&mut self, timeout: Option<Duration>) -> Vec<Completion> {
        if let Some(timeout) = timeout {
            std::thread::sleep(timeout);
        }
        Vec::new()
    }
}

/// A completion channel plus its waker: sending a completion wakes the isolate thread blocked
/// in [`Reactor::wait`]. M3's op bridge uses this from the offload pool; M1 tests it directly.
#[derive(Debug, Clone)]
pub struct CompletionSender {
    sender: std::sync::mpsc::Sender<Completion>,
}

impl CompletionSender {
    /// Wake the loop with an owned completion. Returns false when the isolate has shut down.
    pub fn send(&self, completion: Completion) -> bool {
        self.sender.send(completion).is_ok()
    }
}

/// The receiving side of the completion channel.
#[derive(Debug)]
pub struct ChannelReactor {
    receiver: std::sync::mpsc::Receiver<Completion>,
    /// Keeping a sender alive means `recv_timeout` blocks instead of reporting a disconnect when
    /// no external work has registered a sender yet.
    _keepalive: CompletionSender,
}

impl ChannelReactor {
    pub fn new() -> (Self, CompletionSender) {
        let (sender, receiver) = std::sync::mpsc::channel();
        let keepalive = CompletionSender {
            sender: sender.clone(),
        };
        (
            ChannelReactor {
                receiver,
                _keepalive: keepalive.clone(),
            },
            keepalive,
        )
    }
}

impl Reactor for ChannelReactor {
    fn wait(&mut self, timeout: Option<Duration>) -> Vec<Completion> {
        let received = match timeout {
            None => self.receiver.recv().ok(),
            Some(timeout) if timeout.is_zero() => self.receiver.try_recv().ok(),
            Some(timeout) => self.receiver.recv_timeout(timeout).ok(),
        };
        received.into_iter().collect()
    }
}

/// A scripted reactor for deterministic tests. It records every requested timeout.
#[derive(Debug, Default)]
pub struct FakeReactor {
    script: VecDeque<(Option<Duration>, Vec<Completion>)>,
    waits: Vec<Option<Duration>>,
}

impl FakeReactor {
    pub fn new() -> Self {
        Self::default()
    }

    /// Queue what the next `wait` call returns.
    pub fn script(&mut self, timeout: Option<Duration>, completions: Vec<Completion>) {
        self.script.push_back((timeout, completions));
    }

    /// Every timeout requested so far, in order.
    pub fn waits(&self) -> &[Option<Duration>] {
        &self.waits
    }
}

impl Reactor for FakeReactor {
    fn wait(&mut self, timeout: Option<Duration>) -> Vec<Completion> {
        self.waits.push(timeout);
        self.script
            .pop_front()
            .map(|(_, completions)| completions)
            .unwrap_or_default()
    }
}

/// An immediate handle (`setImmediate`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ImmediateId(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Immediate {
    id: ImmediateId,
    payload: u64,
    refed: bool,
}

/// One unit of work produced by [`Driver::next`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Turn {
    /// A timer became due. Call [`Driver::fire_timer`] to consume it.
    Timer(TimerId),
    /// An immediate was queued before this turn started. Call [`Driver::fire_immediate`].
    Immediate(ImmediateId),
    /// The reactor delivered an owned completion (M3+).
    Completion(u64),
    /// The loop has no more work and `beforeExit` has not been emitted for this idle period.
    BeforeExit,
    /// The loop has no more work and `beforeExit` has already been emitted.
    Exit,
    /// Block until the next deadline or completion. `None` blocks indefinitely.
    Wait(Option<Duration>),
}

/// The loop state machine.
#[derive(Debug)]
pub struct Driver {
    timers: TimerQueue,
    immediates: VecDeque<Immediate>,
    completions: VecDeque<Completion>,
    next_immediate_id: u64,
    /// Refed timers + immediates + externally refed handles.
    refs: usize,
    external_refs: usize,
    /// Timers snapshot for the current turn.
    due: VecDeque<TimerId>,
    /// Immediates snapshot for the current turn.
    immediate_snapshot: Option<VecDeque<ImmediateId>>,
    turn_started: bool,
    before_exit_done: bool,
}

impl Default for Driver {
    fn default() -> Self {
        Self::new()
    }
}

impl Driver {
    pub fn new() -> Self {
        Driver {
            timers: TimerQueue::new(),
            immediates: VecDeque::new(),
            completions: VecDeque::new(),
            next_immediate_id: 1,
            refs: 0,
            external_refs: 0,
            due: VecDeque::new(),
            immediate_snapshot: None,
            turn_started: false,
            before_exit_done: false,
        }
    }

    /// Schedule a `setTimeout`/`setInterval`. Applies Node's 1 ms clamp.
    pub fn schedule_timer(
        &mut self,
        now: Instant,
        delay: Duration,
        repeat: Option<Duration>,
        refed: bool,
        payload: u64,
    ) -> TimerId {
        let delay = delay.max(MIN_TIMEOUT);
        let repeat = repeat.map(|period| period.max(MIN_TIMEOUT));
        self.before_exit_done = false;
        if refed {
            self.refs += 1;
        }
        self.timers.schedule(now + delay, repeat, refed, payload)
    }

    /// Cancel a timer. Returns true when a live timer was removed.
    pub fn clear_timer(&mut self, id: TimerId) -> bool {
        match self.timers.cancel(id) {
            Some(timer) => {
                if timer.refed {
                    self.refs = self.refs.saturating_sub(1);
                }
                true
            }
            None => false,
        }
    }

    /// Change a timer's ref state. Returns the new state, or `None` for an unknown timer.
    pub fn set_timer_ref(&mut self, id: TimerId, refed: bool) -> Option<bool> {
        let previous = self.timers.set_ref(id, refed)?;
        if previous != refed {
            if refed {
                self.refs += 1;
                self.before_exit_done = false;
            } else {
                self.refs = self.refs.saturating_sub(1);
            }
        }
        Some(refed)
    }

    /// Queue an immediate. Returns its handle.
    pub fn schedule_immediate(&mut self, payload: u64) -> ImmediateId {
        let id = ImmediateId(self.next_immediate_id);
        self.next_immediate_id += 1;
        self.immediates.push_back(Immediate {
            id,
            payload,
            refed: true,
        });
        self.refs += 1;
        self.before_exit_done = false;
        id
    }

    /// Cancel a queued immediate.
    pub fn clear_immediate(&mut self, id: ImmediateId) -> bool {
        let Some(position) = self.immediates.iter().position(|entry| entry.id == id) else {
            return false;
        };
        let immediate = self.immediates.remove(position).expect("position is valid");
        if immediate.refed {
            self.refs = self.refs.saturating_sub(1);
        }
        true
    }

    /// Change an immediate's ref state.
    pub fn set_immediate_ref(&mut self, id: ImmediateId, refed: bool) -> Option<bool> {
        let immediate = self.immediates.iter_mut().find(|entry| entry.id == id)?;
        let previous = immediate.refed;
        if previous != refed {
            if refed {
                self.refs += 1;
                self.before_exit_done = false;
            } else {
                self.refs = self.refs.saturating_sub(1);
            }
        }
        immediate.refed = refed;
        Some(refed)
    }

    /// Consume a due timer and reschedule it if it is an interval.
    pub fn fire_timer(&mut self, id: TimerId, now: Instant) -> Option<TimerFire> {
        let fire = self.timers.fire(id, now)?;
        if !fire.repeated && fire.refed {
            self.refs = self.refs.saturating_sub(1);
        }
        Some(fire)
    }

    /// Consume an immediate, returning its callback payload.
    pub fn fire_immediate(&mut self, id: ImmediateId) -> Option<u64> {
        let position = self.immediates.iter().position(|entry| entry.id == id)?;
        let immediate = self.immediates.remove(position).expect("position is valid");
        if immediate.refed {
            self.refs = self.refs.saturating_sub(1);
        }
        Some(immediate.payload)
    }

    /// Add an externally refed handle (a pending op in M3+).
    pub fn ref_external(&mut self) {
        self.refs += 1;
        self.before_exit_done = false;
    }

    /// Drop an externally refed handle.
    pub fn unref_external(&mut self) {
        self.refs = self.refs.saturating_sub(1);
    }

    /// Queue a completion for dispatch in the next turn's completions phase.
    pub fn push_completion(&mut self, completion: Completion) {
        self.completions.push_back(completion);
    }

    /// Number of live refed handles. Zero means the loop is about to emit `beforeExit`.
    pub fn refs(&self) -> usize {
        self.refs + self.external_refs
    }

    pub fn timers(&self) -> &TimerQueue {
        &self.timers
    }

    pub fn timer_count(&self) -> usize {
        self.timers.len()
    }

    pub fn immediate_count(&self) -> usize {
        self.immediates.len()
    }

    /// True when `beforeExit` was already emitted for the current idle period.
    pub fn before_exit_emitted(&self) -> bool {
        self.before_exit_done
    }

    /// Produce the next unit of work.
    ///
    /// `now` is the loop's clock. Tests pass a fake instant; the runtime passes `Instant::now()`.
    pub fn next(&mut self, now: Instant) -> Turn {
        loop {
            if !self.turn_started {
                self.turn_started = true;
                self.immediate_snapshot = None;
                // An unreferenced handle cannot start a turn: Node exits before firing an `unref`ed
                // timer when nothing else keeps the loop alive.
                self.due = if self.refs() == 0 {
                    VecDeque::new()
                } else {
                    self.timers.due_snapshot(now).into()
                };
                if self.refs() == 0 {
                    // An `unref`ed immediate cannot start a turn either.
                    self.immediate_snapshot = Some(VecDeque::new());
                }
            }

            while let Some(id) = self.due.pop_front() {
                // Timers cleared after the snapshot are skipped, not fired.
                if self.timers.contains(id) {
                    return Turn::Timer(id);
                }
            }

            // Completions are the poll-phase substitute and run before check-phase immediates
            // (ADR-0003 §2).
            if let Some(completion) = self.completions.pop_front() {
                return Turn::Completion(completion.0);
            }

            if self.immediate_snapshot.is_none() {
                let ids: VecDeque<ImmediateId> =
                    self.immediates.iter().map(|entry| entry.id).collect();
                self.immediate_snapshot = Some(ids);
            }
            if let Some(snapshot) = self.immediate_snapshot.as_mut() {
                while let Some(id) = snapshot.pop_front() {
                    if self.immediates.iter().any(|entry| entry.id == id) {
                        return Turn::Immediate(id);
                    }
                }
            }

            // The turn is over: decide whether to exit or block.
            self.turn_started = false;
            if self.refs() == 0 {
                if !self.before_exit_done {
                    self.before_exit_done = true;
                    return Turn::BeforeExit;
                }
                return Turn::Exit;
            }

            // An immediate scheduled while the check phase was running is not in this turn's
            // snapshot: it belongs to the next turn (the phase-order rule above), so start that
            // turn now instead of blocking. Without this, the new immediate waits for an
            // unrelated timer or completion — forever when none exists. `setImmediate` scheduled
            // from a promise continuation after another immediate is the common case (a test
            // runner awaiting one test before starting the next is exactly that shape).
            self.before_exit_done = false;
            if !self.immediates.is_empty() {
                continue;
            }

            let timeout = self
                .timers
                .next_deadline()
                .map(|deadline| deadline.saturating_duration_since(now));
            return Turn::Wait(timeout);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_completion_channel_wakes_a_blocked_loop() {
        let (reactor, sender) = ChannelReactor::new();
        let mut reactor = reactor;

        let handle = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(5));
            sender.send(Completion(42));
        });

        let completions = reactor.wait(Some(Duration::from_secs(2)));
        handle.join().expect("sender thread");
        assert_eq!(completions, vec![Completion(42)]);
    }

    fn now() -> Instant {
        Instant::now()
    }

    fn drain(driver: &mut Driver, now: Instant, limit: usize) -> Vec<String> {
        let mut seen = Vec::new();
        for _ in 0..limit {
            match driver.next(now) {
                Turn::Timer(id) => {
                    let fire = driver.fire_timer(id, now).expect("timer still live");
                    seen.push(format!("timer:{}", fire.payload));
                }
                Turn::Immediate(id) => {
                    let payload = driver.fire_immediate(id).expect("immediate still live");
                    seen.push(format!("immediate:{payload}"));
                }
                Turn::BeforeExit => seen.push("beforeExit".to_string()),
                Turn::Exit => {
                    seen.push("exit".to_string());
                    break;
                }
                Turn::Wait(_) => break,
                Turn::Completion(id) => seen.push(format!("completion:{id}")),
            }
        }
        seen
    }

    #[test]
    fn timers_run_before_immediates_that_arrived_in_the_same_turn() {
        let now = now();
        let mut driver = Driver::new();
        driver.schedule_timer(now, Duration::ZERO, None, true, 1);
        driver.schedule_immediate(2);

        // `schedule_timer` applies Node's 1 ms clamp, so the timer is due one millisecond out.
        let at = now + Duration::from_millis(1);
        assert_eq!(
            drain(&mut driver, at, 10),
            ["timer:1", "immediate:2", "beforeExit", "exit"]
        );
    }

    #[test]
    fn a_future_timer_does_not_delay_an_immediate() {
        let now = now();
        let mut driver = Driver::new();
        driver.schedule_timer(now, Duration::from_millis(5), None, true, 1);
        driver.schedule_immediate(2);

        let first = driver.next(now);
        assert_eq!(first, Turn::Immediate(ImmediateId(1)));
        assert_eq!(driver.fire_immediate(ImmediateId(1)), Some(2));

        // The next turn, still at `now`, must block until the timer's deadline.
        assert_eq!(driver.next(now), Turn::Wait(Some(Duration::from_millis(5))));
    }

    #[test]
    fn an_immediate_scheduled_during_the_check_phase_starts_a_new_turn() {
        let now = now();
        let mut driver = Driver::new();
        let first = driver.schedule_immediate(1);
        assert_eq!(driver.next(now), Turn::Immediate(first));
        assert_eq!(driver.fire_immediate(first), Some(1));

        // The callback's microtask checkpoint queues a second immediate before the loop asks for
        // work again. It must run at the start of the next turn, not after a block: with no timer
        // pending, a `Wait(None)` here is a hang.
        let second = driver.schedule_immediate(2);
        assert_eq!(driver.next(now), Turn::Immediate(second));
        assert_eq!(driver.fire_immediate(second), Some(2));
        assert_eq!(driver.next(now), Turn::BeforeExit);
    }

    #[test]
    fn before_exit_is_reported_once_per_idle_period_and_can_be_revived() {
        let now = now();
        let mut driver = Driver::new();
        assert_eq!(driver.next(now), Turn::BeforeExit);
        driver.schedule_immediate(1);
        assert_eq!(driver.next(now), Turn::Immediate(ImmediateId(1)));
        driver.fire_immediate(ImmediateId(1));
        assert_eq!(driver.next(now), Turn::BeforeExit);
        assert_eq!(driver.next(now), Turn::Exit);
    }

    #[test]
    fn unrefed_timers_do_not_keep_the_loop_alive() {
        let now = now();
        let mut driver = Driver::new();
        let id = driver.schedule_timer(now, Duration::ZERO, None, false, 1);
        let at = now + Duration::from_millis(1);
        assert_eq!(driver.refs(), 0);
        assert_eq!(driver.next(at), Turn::BeforeExit);
        assert_eq!(driver.next(at), Turn::Exit);

        // The timer is still there: if work revives the loop, it fires.
        driver.ref_external();
        assert_eq!(driver.next(at), Turn::Timer(id));
        driver.fire_timer(id, at);
        driver.unref_external();
    }

    #[test]
    fn intervals_stay_refed_until_cleared() {
        let now = now();
        let mut driver = Driver::new();
        let id =
            driver.schedule_timer(now, Duration::ZERO, Some(Duration::from_millis(1)), true, 1);
        let at = now + Duration::from_millis(1);
        assert_eq!(driver.next(at), Turn::Timer(id));
        driver.fire_timer(id, at);
        assert_eq!(driver.refs(), 1);
        assert!(driver.clear_timer(id));
        assert_eq!(driver.refs(), 0);
    }

    #[test]
    fn a_timer_cleared_after_the_snapshot_is_skipped() {
        let now = now();
        let mut driver = Driver::new();
        let first = driver.schedule_timer(now, Duration::ZERO, None, true, 1);
        let second = driver.schedule_timer(now, Duration::ZERO, None, true, 2);

        let at = now + Duration::from_millis(1);
        assert_eq!(driver.next(at), Turn::Timer(first));
        assert!(driver.fire_timer(first, at).is_some());
        assert!(driver.clear_timer(second));
        assert_eq!(driver.next(at), Turn::BeforeExit);
    }

    #[test]
    fn completions_are_macrotasks_before_immediates_are_snapshotted() {
        let now = now();
        let mut driver = Driver::new();
        driver.ref_external();
        driver.schedule_immediate(9);
        driver.push_completion(Completion(4));

        assert_eq!(driver.next(now), Turn::Completion(4));
        assert_eq!(driver.next(now), Turn::Immediate(ImmediateId(1)));
        driver.fire_immediate(ImmediateId(1));
    }
}
