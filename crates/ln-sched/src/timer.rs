//! Timer heap for the onde event loop.
//!
//! One binary heap keyed `(deadline, seq)` per isolate (ADR-0003 §2/§7). `seq` is a monotonic
//! insertion counter, which is what makes two timers with the same deadline fire in creation
//! order. Cancellation is lazy: [`TimerQueue::cancel`] removes the entry from the map and leaves
//! the heap node behind; nodes are validated against the map when popped.
//!
//! This module knows nothing about JavaScript. A timer payload is an opaque `u64` chosen by the
//! caller (`ln-runtime` uses it as a callback-registry key).

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::time::{Duration, Instant};

/// Node clamps `setTimeout`/`setInterval` delays below 1 ms to 1 ms.
pub const MIN_TIMEOUT: Duration = Duration::from_millis(1);

/// Stable timer identity, returned to JS as the `Timeout` handle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TimerId(pub u64);

/// A scheduled timer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timer {
    pub id: TimerId,
    pub deadline: Instant,
    pub seq: u64,
    /// `Some(period)` for `setInterval`, `None` for `setTimeout`.
    pub repeat: Option<Duration>,
    /// Whether this handle keeps the loop alive. `unref()` clears it.
    pub refed: bool,
    /// Opaque callback payload.
    pub payload: u64,
}

/// What a fired timer hands back to the loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimerFire {
    pub id: TimerId,
    pub payload: u64,
    /// True when the timer was rescheduled (an interval).
    pub repeated: bool,
    pub refed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct TimerKey {
    deadline: Instant,
    seq: u64,
    id: u64,
}

/// A deterministic timer queue with lazy cancellation.
#[derive(Debug, Default)]
pub struct TimerQueue {
    timers: HashMap<TimerId, Timer>,
    heap: BinaryHeap<Reverse<TimerKey>>,
    next_id: u64,
    next_seq: u64,
}

impl TimerQueue {
    pub fn new() -> Self {
        TimerQueue {
            next_id: 1,
            ..Self::default()
        }
    }

    /// Schedule a timer at `deadline`. The caller is responsible for clamping (`MIN_TIMEOUT`)
    /// and for computing the deadline from its own clock.
    pub fn schedule(
        &mut self,
        deadline: Instant,
        repeat: Option<Duration>,
        refed: bool,
        payload: u64,
    ) -> TimerId {
        let id = TimerId(self.next_id);
        self.next_id += 1;
        let seq = self.next_seq;
        self.next_seq += 1;

        self.timers.insert(
            id,
            Timer {
                id,
                deadline,
                seq,
                repeat,
                refed,
                payload,
            },
        );
        self.heap.push(Reverse(TimerKey {
            deadline,
            seq,
            id: id.0,
        }));
        id
    }

    /// Remove a timer. Returns the cancelled timer, or `None` if it was unknown or already fired.
    pub fn cancel(&mut self, id: TimerId) -> Option<Timer> {
        let timer = self.timers.remove(&id);
        if timer.is_some() {
            self.compact_if_needed();
        }
        timer
    }

    /// The heap keeps stale nodes for cancelled/rescheduled timers (lazy deletion). Without a
    /// bound, a long-lived process that creates and clears timers would grow the heap forever.
    /// Rebuild when stale nodes outnumber live timers.
    fn compact_if_needed(&mut self) {
        if self.heap.len() <= self.timers.len().saturating_mul(2) + 64 {
            return;
        }
        self.heap = self
            .timers
            .values()
            .map(|timer| {
                Reverse(TimerKey {
                    deadline: timer.deadline,
                    seq: timer.seq,
                    id: timer.id.0,
                })
            })
            .collect();
    }

    /// Change a timer's `ref` state. Returns the previous state, or `None` if unknown.
    pub fn set_ref(&mut self, id: TimerId, refed: bool) -> Option<bool> {
        let timer = self.timers.get_mut(&id)?;
        let previous = timer.refed;
        timer.refed = refed;
        Some(previous)
    }

    pub fn get(&self, id: TimerId) -> Option<&Timer> {
        self.timers.get(&id)
    }

    pub fn contains(&self, id: TimerId) -> bool {
        self.timers.contains_key(&id)
    }

    pub fn len(&self) -> usize {
        self.timers.len()
    }

    pub fn is_empty(&self) -> bool {
        self.timers.is_empty()
    }

    /// Snapshot every timer due at `now`, in `(deadline, insertion order)` order.
    ///
    /// The timers stay in the map until [`fire`](Self::fire) or [`cancel`](Self::cancel); the
    /// snapshot is the timers phase's view of the world, so a timer created while the phase is
    /// running is not picked up until the next turn (ADR-0003 §2).
    pub fn due_snapshot(&mut self, now: Instant) -> Vec<TimerId> {
        let mut due = Vec::new();
        while let Some(Reverse(key)) = self.heap.peek().copied() {
            if key.deadline > now {
                break;
            }
            self.heap.pop();
            let Some(timer) = self.timers.get(&TimerId(key.id)) else {
                continue; // cancelled
            };
            // A stale node from a rescheduled interval: the current entry has a different key.
            if timer.deadline != key.deadline || timer.seq != key.seq {
                continue;
            }
            due.push(TimerId(key.id));
        }
        due
    }

    /// Fire a timer. One-shots are removed; intervals are rescheduled at `deadline + period`
    /// (no drift compensation, matching Node's default) and stay registered.
    ///
    /// Returns `None` when the timer was cleared after the phase snapshot was taken.
    pub fn fire(&mut self, id: TimerId, now: Instant) -> Option<TimerFire> {
        let timer = self.timers.get(&id).copied()?;

        match timer.repeat {
            None => {
                self.timers.remove(&id);
                Some(TimerFire {
                    id,
                    payload: timer.payload,
                    repeated: false,
                    refed: timer.refed,
                })
            }
            Some(period) => {
                let mut next = timer.deadline + period;
                // If the loop fell far behind, do not queue a burst of catch-up firings: the
                // next turn fires once and reschedules again from the new deadline.
                if next <= now {
                    next = now + period;
                }
                let seq = self.next_seq;
                self.next_seq += 1;
                let updated = Timer {
                    deadline: next,
                    seq,
                    ..timer
                };
                self.timers.insert(id, updated);
                self.heap.push(Reverse(TimerKey {
                    deadline: next,
                    seq,
                    id: id.0,
                }));
                self.compact_if_needed();
                Some(TimerFire {
                    id,
                    payload: timer.payload,
                    repeated: true,
                    refed: timer.refed,
                })
            }
        }
    }

    /// Deadline of the next live timer, discarding cancelled/rescheduled nodes at the top.
    pub fn next_deadline(&mut self) -> Option<Instant> {
        while let Some(Reverse(key)) = self.heap.peek().copied() {
            let live = self
                .timers
                .get(&TimerId(key.id))
                .is_some_and(|timer| timer.deadline == key.deadline && timer.seq == key.seq);
            if live {
                return Some(key.deadline);
            }
            self.heap.pop();
        }
        None
    }

    /// Heap nodes currently stored, including lazily deleted ones. Diagnostics/tests only.
    pub fn heap_len(&self) -> usize {
        self.heap.len()
    }

    /// Number of live refed timers. Intended for assertions and diagnostics.
    pub fn refed_count(&self) -> usize {
        self.timers.values().filter(|timer| timer.refed).count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Instant {
        Instant::now()
    }

    #[test]
    fn fires_in_deadline_order_then_insertion_order() {
        let now = base();
        let mut queue = TimerQueue::new();
        let late = queue.schedule(now + Duration::from_millis(5), None, true, 1);
        let first = queue.schedule(now + Duration::from_millis(1), None, true, 2);
        let second = queue.schedule(now + Duration::from_millis(1), None, true, 3);

        let due = queue.due_snapshot(now + Duration::from_millis(5));
        assert_eq!(due, vec![first, second, late]);
        assert_eq!(queue.fire(first, now).map(|f| f.payload), Some(2));
        assert_eq!(queue.fire(second, now).map(|f| f.payload), Some(3));
        assert_eq!(queue.fire(late, now).map(|f| f.payload), Some(1));
        assert!(queue.is_empty());
    }

    #[test]
    fn snapshot_does_not_include_new_timers() {
        let now = base();
        let mut queue = TimerQueue::new();
        let first = queue.schedule(now, None, true, 1);
        let due = queue.due_snapshot(now);
        let late = queue.schedule(now, None, true, 2);

        assert_eq!(due, vec![first]);
        assert!(queue.due_snapshot(now).contains(&late));
    }

    #[test]
    fn cancellation_is_lazy_but_effective() {
        let now = base();
        let mut queue = TimerQueue::new();
        let first = queue.schedule(now, None, true, 1);
        let second = queue.schedule(now, None, true, 2);

        assert_eq!(queue.cancel(first).map(|t| t.payload), Some(1));
        assert_eq!(queue.due_snapshot(now), vec![second]);
        assert_eq!(queue.fire(first, now), None);
        assert_eq!(queue.cancel(first), None);
    }

    #[test]
    fn intervals_reschedule_from_the_deadline() {
        let now = base();
        let mut queue = TimerQueue::new();
        let id = queue.schedule(
            now + Duration::from_millis(2),
            Some(Duration::from_millis(3)),
            true,
            7,
        );

        let first = queue.fire(id, now + Duration::from_millis(2)).unwrap();
        assert!(first.repeated);
        assert_eq!(
            queue.get(id).unwrap().deadline,
            now + Duration::from_millis(5)
        );
        assert_eq!(queue.due_snapshot(now + Duration::from_millis(4)), vec![]);
        assert_eq!(queue.due_snapshot(now + Duration::from_millis(5)), vec![id]);
    }

    #[test]
    fn a_late_interval_does_not_burst() {
        let now = base();
        let mut queue = TimerQueue::new();
        let id = queue.schedule(
            now + Duration::from_millis(1),
            Some(Duration::from_millis(1)),
            true,
            7,
        );

        let now_late = now + Duration::from_millis(100);
        queue.fire(id, now_late).unwrap();
        assert_eq!(
            queue.get(id).unwrap().deadline,
            now_late + Duration::from_millis(1)
        );
    }

    #[test]
    fn cancelled_timers_do_not_grow_the_heap_without_bound() {
        let now = base();
        let mut queue = TimerQueue::new();
        for i in 0..10_000 {
            let id = queue.schedule(now + Duration::from_millis(1000), None, true, i);
            queue.cancel(id);
        }
        assert!(queue.is_empty());
        assert!(
            queue.heap_len() <= 64,
            "heap kept {} stale nodes",
            queue.heap_len()
        );
    }

    #[test]
    fn ref_state_is_observable() {
        let now = base();
        let mut queue = TimerQueue::new();
        let id = queue.schedule(now, None, true, 1);
        assert_eq!(queue.refed_count(), 1);
        assert_eq!(queue.set_ref(id, false), Some(true));
        assert_eq!(queue.refed_count(), 0);
        assert_eq!(queue.set_ref(id, true), Some(false));
        assert_eq!(queue.set_ref(TimerId(99), true), None);
    }
}
