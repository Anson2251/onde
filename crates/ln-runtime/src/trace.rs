//! Chrome-trace output and the phase/op aggregation behind `--trace-events` and `--timing`.
//!
//! The writer is deliberately small and hand-rolled: a trace event is five fields, `serde_json` is
//! already a dependency but pulling a serializer into the hot path of an opted-in diagnostic would
//! buy nothing, and the format has to be readable by `chrome://tracing`, not by us.
//!
//! # What is traced
//!
//! | Event | `cat` | Emitted by | Meaning |
//! |---|---|---|---|
//! | `metadata` | `__metadata` | `Trace::new` | one `process_name` event; Chrome prefers a named lane |
//! | `<phase>` | `loop` | `Isolate::run_loop` | one event per turn, named for the phase that ran |
//! | `<op>` | `op` | the op bridge | one event per submitted `ln_io::Op` / network command |
//! | `gc` | `gc` | the loop, when the sampled heap falls | `args.before`/`args.after` in bytes |
//!
//! Phase names come from `ln_sched::Turn` (`timer`, `immediate`, `completion`, `beforeExit`,
//! `wait`), so a reader of ADR-0003 already knows the vocabulary. The names are ours on purpose:
//! Node's `--trace-events` shape belongs to its inspector, and D70 records the difference.
//!
//! # Cost when off
//!
//! Nothing in this module runs unless an `Option<Trace>` is `Some`. The loop checks the option once
//! per turn; a program that did not pass the flag pays one branch and no clock read beyond the
//! timers it already had.
//!
//! # Bounded memory
//!
//! Events are buffered and flushed in chunks. If the file cannot keep up with the trace, the writer
//! drops events and counts them (`Trace::dropped`) instead of growing without bound — a diagnostic
//! that can exhaust the memory limit it is helping to diagnose is not a diagnostic.

use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Default buffer before a flush, in bytes of encoded JSON.
pub const DEFAULT_BUFFER_LIMIT: usize = 4 * 1024 * 1024;

/// A Chrome-trace event, encoded when it is written so the buffer's cost is the encoded size.
struct Event {
    name: &'static str,
    cat: &'static str,
    ts_us: u64,
    dur_us: u64,
    /// `before`/`after` heap bytes for a `gc` event; `None` for every other event.
    gc: Option<(u64, u64)>,
}

pub struct Trace {
    out: BufWriter<File>,
    start: Instant,
    epoch_us: u64,
    pid: u32,
    tid: u32,
    first: bool,
    buffered: Vec<Event>,
    buffered_bytes: usize,
    limit: usize,
    dropped: u64,
    finished: bool,
}

impl Trace {
    /// Open a trace file and write its header. `limit` bounds the buffered JSON between flushes.
    pub fn create(path: &Path, limit: usize) -> io::Result<Trace> {
        let file = File::create(path)?;
        let mut trace = Trace {
            out: BufWriter::new(file),
            start: Instant::now(),
            epoch_us: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_micros() as u64)
                .unwrap_or(0),
            // Chrome uses pid/tid only to separate lanes; the OS ids make one file show the main
            // isolate and each worker thread on its own lane.
            pid: std::process::id(),
            tid: thread_id(),
            first: true,
            buffered: Vec::new(),
            buffered_bytes: 0,
            limit: limit.max(4096),
            dropped: 0,
            finished: false,
        };
        trace.out.write_all(b"{\"traceEvents\":[\n")?;
        trace.push_event(Event {
            name: "process_name",
            cat: "__metadata",
            ts_us: 0,
            dur_us: 0,
            gc: None,
        });
        Ok(trace)
    }

    /// One completed turn, named for the phase that ran.
    pub fn phase(&mut self, name: &'static str, elapsed: Duration) {
        if self.finished {
            return;
        }
        let ts_us = self.start.elapsed().as_micros() as u64;
        self.push_event(Event {
            name,
            cat: "loop",
            ts_us,
            dur_us: elapsed.as_micros() as u64,
            gc: None,
        });
    }

    /// One host op that ran to completion. `name` is the `ln_io::Op`/`Command` variant name, which
    /// the bridge owns as a `&'static str`.
    pub fn op(&mut self, name: &'static str, elapsed: Duration) {
        if self.finished {
            return;
        }
        let ts_us = self.start.elapsed().as_micros() as u64;
        self.push_event(Event {
            name,
            cat: "op",
            ts_us: ts_us.saturating_sub(elapsed.as_micros() as u64),
            dur_us: elapsed.as_micros() as u64,
            gc: None,
        });
    }

    /// A sampled collection: the heap fell from `before` to `after` bytes.
    pub fn gc(&mut self, before: u64, after: u64) {
        if self.finished {
            return;
        }
        let ts_us = self.start.elapsed().as_micros() as u64;
        self.push_event(Event {
            name: "gc",
            cat: "gc",
            ts_us,
            dur_us: 0,
            gc: Some((before, after)),
        });
    }

    /// Events dropped because the buffer limit was reached.
    pub fn dropped(&self) -> u64 {
        self.dropped
    }

    /// Flush buffered events and close the array. Idempotent.
    pub fn finish(&mut self) {
        if self.finished {
            return;
        }
        self.finished = true;
        self.flush_events();
        let _ = self.out.write_all(b"]}\n");
        let _ = self.out.flush();
        let dropped = self.dropped();
        if dropped > 0 {
            // A truncated trace must say so: a missing half of the timeline would otherwise read as
            // "the program did nothing there".
            eprintln!(
                "trace: dropped {dropped} events (buffer of {} bytes was full)",
                self.limit
            );
        }
    }

    fn push_event(&mut self, event: Event) {
        // ~90 bytes is the encoded floor of one event; the exact size is added when it is written.
        self.buffered_bytes += 100;
        self.buffered.push(event);
        if self.buffered_bytes >= self.limit {
            self.flush_events();
        }
    }

    fn flush_events(&mut self) {
        if self.buffered.is_empty() {
            return;
        }
        for event in std::mem::take(&mut self.buffered) {
            let separator = if self.first { "" } else { ",\n" };
            self.first = false;
            let written = match event.gc {
                None => write!(
                    self.out,
                    "{}{{\"name\":\"{}\",\"cat\":\"{}\",\"ph\":\"X\",\"ts\":{},\"dur\":{},\"pid\":{},\"tid\":{}}}",
                    separator,
                    escape(event.name),
                    event.cat,
                    self.epoch_us + event.ts_us,
                    event.dur_us,
                    self.pid,
                    self.tid
                ),
                Some((before, after)) => write!(
                    self.out,
                    "{}{{\"name\":\"{}\",\"cat\":\"{}\",\"ph\":\"i\",\"s\":\"t\",\"ts\":{},\"pid\":{},\"tid\":{},\"args\":{{\"before\":{},\"after\":{}}}}}",
                    separator,
                    escape(event.name),
                    event.cat,
                    self.epoch_us + event.ts_us,
                    self.pid,
                    self.tid,
                    before,
                    after
                ),
            };
            if written.is_err() {
                self.dropped += 1;
                return;
            }
        }
        self.buffered_bytes = 0;
        let _ = self.out.flush();
    }
}

impl Drop for Trace {
    fn drop(&mut self) {
        self.finish();
    }
}

/// The JSON fragment of one event, for tests and for hosts that want to write their own file.
fn escape(name: &str) -> String {
    // Event names in this module are `&'static str` from `ln_io` enums: identifiers, never quotes.
    // Keeping the function means a future name with a quote cannot produce broken JSON silently.
    name.replace('\\', "\\\\").replace('"', "\\\"")
}

fn thread_id() -> u32 {
    // Rust has no stable thread id; the address of a thread-local is unique per thread and good
    // enough for a trace lane (Chrome only needs the lanes to differ).
    thread_local!(static LANE: u8 = const { 0 });
    LANE.with(|lane| lane as *const u8 as usize as u32)
}

/// Per-phase and per-op aggregation for `--timing`.
///
/// Rows are kept in submission order and sorted only when printed, because the print happens once
/// and the record happens per turn.
#[derive(Default)]
pub struct Timing {
    rows: Vec<Row>,
}

struct Row {
    name: &'static str,
    count: u64,
    total_ns: u64,
    max_ns: u64,
}

impl Timing {
    pub fn record(&mut self, name: &'static str, elapsed: Duration) {
        let nanos = elapsed.as_nanos().min(u64::MAX as u128) as u64;
        match self.rows.iter_mut().find(|row| row.name == name) {
            Some(row) => {
                row.count += 1;
                row.total_ns += nanos;
                row.max_ns = row.max_ns.max(nanos);
            }
            None => self.rows.push(Row {
                name,
                count: 1,
                total_ns: nanos,
                max_ns: nanos,
            }),
        }
    }

    /// Write one line per row, largest total first. Every line is `timing: <name> count=… total_ms=…
    /// max_ms=…`, which is stable enough to assert on and readable enough to paste in a report.
    pub fn report(&self, mut out: impl Write) -> io::Result<()> {
        let mut rows: Vec<&Row> = self.rows.iter().collect();
        rows.sort_by(|a, b| b.total_ns.cmp(&a.total_ns).then(a.name.cmp(b.name)));
        for row in rows {
            writeln!(
                out,
                "timing: {} count={} total_ms={:.3} max_ms={:.3}",
                row.name,
                row.count,
                row.total_ns as f64 / 1e6,
                row.max_ns as f64 / 1e6,
            )?;
        }
        Ok(())
    }
}

/// Everything the three diagnostic flags need, or nothing.
///
/// One struct rather than three `Option`s on the isolate: the loop asks it once per turn, and a
/// program with no flags pays one branch that returns immediately.
#[derive(Default)]
pub struct Diagnostics {
    trace: Option<Trace>,
    timing: Option<Timing>,
    gc: Option<GcTracker>,
}

/// How much of the FFI boundary to log (`--trace-ffi`, `ONDE_FFI_TRACE`).
///
/// The log is written from the host, synchronously, before control enters C: a crash inside the
/// library kills the process, so the last line is the only record of which call was in flight.
/// `Summary` prints the call, its coerced values and the JavaScript frame; `Full` also prints
/// struct layouts and the contents of struct and array arguments.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FfiTrace {
    #[default]
    Off,
    Summary,
    Full,
}

impl FfiTrace {
    pub fn enabled(self) -> bool {
        !matches!(self, FfiTrace::Off)
    }

    pub fn full(self) -> bool {
        matches!(self, FfiTrace::Full)
    }

    /// The value the host hands `onde:ffi` (0 off, 1 summary, 2 full).
    pub fn level(self) -> u8 {
        match self {
            FfiTrace::Off => 0,
            FfiTrace::Summary => 1,
            FfiTrace::Full => 2,
        }
    }

    /// `ONDE_FFI_TRACE`: `1`/`summary` for the call log, `2`/`full` for layouts and values.
    /// Anything unrecognised is off, so a typo cannot flood stderr.
    pub fn from_env() -> FfiTrace {
        match std::env::var("ONDE_FFI_TRACE") {
            Ok(value) => match value.trim().to_ascii_lowercase().as_str() {
                "full" | "2" | "verbose" => FfiTrace::Full,
                "1" | "summary" | "on" | "true" => FfiTrace::Summary,
                _ => FfiTrace::Off,
            },
            Err(_) => FfiTrace::Off,
        }
    }

    /// The flag wins when it was passed; the environment covers compiled apps and `ondec`.
    pub fn or_env(self) -> FfiTrace {
        if self.enabled() {
            self
        } else {
            FfiTrace::from_env()
        }
    }
}

/// What the CLI asked for.
#[derive(Debug, Clone)]
pub struct DiagnosticsConfig {
    /// Write a Chrome trace here.
    pub trace_events: Option<std::path::PathBuf>,
    /// `--trace-events` buffer, in MiB.
    pub trace_buffer_mb: usize,
    /// Aggregate phases and ops and print them at exit.
    pub timing: bool,
    /// Report sampled collections.
    pub trace_gc: bool,
    /// Trace the FFI boundary (`--trace-ffi`; `ONDE_FFI_TRACE` is the fallback).
    pub trace_ffi: FfiTrace,
    /// Time the CLI spent parsing the permission policy, before the isolate existed. Reported as a
    /// `permissions` row under `--timing` (ADR-0011 §7); `None` when no policy was parsed.
    pub setup_micros: Option<u64>,
}

impl Default for DiagnosticsConfig {
    fn default() -> Self {
        DiagnosticsConfig {
            trace_events: None,
            trace_buffer_mb: DEFAULT_BUFFER_LIMIT / (1024 * 1024),
            timing: false,
            trace_gc: false,
            trace_ffi: FfiTrace::Off,
            setup_micros: None,
        }
    }
}

impl Diagnostics {
    /// Build the collectors, or `None` when nothing was asked for.
    pub fn new(config: &DiagnosticsConfig) -> io::Result<Option<Diagnostics>> {
        let trace_events = config.trace_events.is_some();
        if !trace_events && !config.timing && !config.trace_gc {
            return Ok(None);
        }
        let trace = match &config.trace_events {
            Some(path) => Some(Trace::create(
                path,
                config.trace_buffer_mb.max(1) * 1024 * 1024,
            )?),
            None => None,
        };
        let mut diagnostics = Diagnostics {
            trace,
            timing: config.timing.then(Timing::default),
            gc: config.trace_gc.then(GcTracker::new),
        };
        if let (Some(timing), Some(micros)) = (&mut diagnostics.timing, config.setup_micros) {
            timing.record("permissions", Duration::from_micros(micros));
        }
        Ok(Some(diagnostics))
    }

    /// True when a heap sample is needed, so the caller can skip `JS_ComputeMemoryUsage`, which
    /// walks the whole heap.
    pub fn wants_heap(&self) -> bool {
        self.gc.is_some()
    }

    /// One completed turn. `--trace-gc` samples happen at these boundaries and nowhere else.
    pub fn turn(&mut self, phase: &'static str, elapsed: Duration) {
        if let Some(timing) = &mut self.timing {
            timing.record(phase, elapsed);
        }
        if let Some(trace) = &mut self.trace {
            trace.phase(phase, elapsed);
        }
    }

    /// One host op, measured from submission to delivery.
    pub fn op(&mut self, name: &'static str, elapsed: Duration) {
        if let Some(timing) = &mut self.timing {
            timing.record(name, elapsed);
        }
        if let Some(trace) = &mut self.trace {
            trace.op(name, elapsed);
        }
    }

    /// Offer the heap sample taken at the top of this turn.
    pub fn sample_heap(&mut self, used: u64) {
        if let (Some(tracker), Some(trace)) = (self.gc.as_mut(), self.trace.as_mut()) {
            if let Some((before, after)) = tracker.observe(used) {
                trace.gc(before, after);
            }
        }
    }

    /// Flush the trace and print the timing rows. Called once, when the loop ends.
    pub fn finish(&mut self) {
        if let Some(trace) = &mut self.trace {
            trace.finish();
        }
        if let Some(timing) = &self.timing {
            let mut stderr = io::stderr();
            let _ = timing.report(&mut stderr);
        }
    }
}

/// Turns a sampled heap series into `gc` events.
///
/// The engine has no GC callback, so a collection is inferred: the sample at a turn boundary is
/// lower than the last one by more than `DROP_PERCENT`. One turn that collects twice reports once
/// (D69), and a collection inside a turn is attributed to that turn's boundary rather than to the
/// moment it happened.
#[derive(Default)]
pub struct GcTracker {
    last_used: Option<u64>,
}

/// A drop of more than this share of the heap is reported as a collection; smaller drops are the
/// allocator reusing freed pages.
pub const GC_DROP_PERCENT: u64 = 10;

impl GcTracker {
    pub fn new() -> GcTracker {
        GcTracker::default()
    }

    /// Observe one sample. Returns `(before, after)` exactly when the sample looks like a
    /// collection.
    pub fn observe(&mut self, used: u64) -> Option<(u64, u64)> {
        let previous = self.last_used.replace(used)?;
        if previous == 0 || used >= previous {
            return None;
        }
        let freed = previous - used;
        if freed * 100 > previous * GC_DROP_PERCENT {
            Some((previous, used))
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn trace_in_temp() -> (Trace, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "ln-trace-{}-{}.json",
            std::process::id(),
            thread_id()
        ));
        (
            Trace::create(&path, DEFAULT_BUFFER_LIMIT).expect("trace"),
            path,
        )
    }

    fn read_back(path: &Path) -> serde_json::Value {
        let mut text = String::new();
        File::open(path)
            .expect("open")
            .read_to_string(&mut text)
            .expect("read");
        serde_json::from_str(&text)
            .unwrap_or_else(|error| panic!("trace is not JSON: {error}\n{text}"))
    }

    #[test]
    fn phases_and_ops_load_as_a_trace_file() {
        let (mut trace, path) = trace_in_temp();
        trace.phase("timer", Duration::from_micros(120));
        trace.phase("completion", Duration::from_micros(30));
        trace.op("read", Duration::from_micros(80));
        trace.finish();

        let document = read_back(&path);
        let events = document["traceEvents"].as_array().expect("traceEvents");
        assert_eq!(events[0]["name"], "process_name");
        let names: Vec<&str> = events[1..]
            .iter()
            .map(|e| e["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["timer", "completion", "read"]);
        for event in &events[1..] {
            assert_eq!(event["ph"], "X");
            assert_eq!(event["pid"], std::process::id());
            assert!(event["ts"].as_u64().unwrap() > 0);
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_gc_event_is_an_instant_with_both_heap_sizes() {
        let (mut trace, path) = trace_in_temp();
        trace.gc(1_000_000, 400_000);
        trace.finish();

        let document = read_back(&path);
        let event = &document["traceEvents"][1];
        assert_eq!(event["name"], "gc");
        assert_eq!(event["ph"], "i");
        assert_eq!(event["args"]["before"], 1_000_000);
        assert_eq!(event["args"]["after"], 400_000);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn dropping_the_writer_closes_the_file() {
        let path = std::env::temp_dir().join(format!("ln-trace-drop-{}.json", std::process::id()));
        {
            let mut trace = Trace::create(&path, DEFAULT_BUFFER_LIMIT).expect("trace");
            trace.phase("wait", Duration::from_micros(5));
        }
        let document = read_back(&path);
        assert_eq!(document["traceEvents"].as_array().unwrap().len(), 2);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_small_buffer_flushes_without_losing_events() {
        let path = std::env::temp_dir().join(format!("ln-trace-small-{}.json", std::process::id()));
        let mut trace = Trace::create(&path, 4096).expect("trace");
        for _ in 0..500 {
            trace.phase("timer", Duration::from_micros(1));
        }
        trace.finish();
        let document = read_back(&path);
        assert_eq!(document["traceEvents"].as_array().unwrap().len(), 501);
        assert_eq!(trace.dropped(), 0);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn timing_aggregates_and_sorts_by_total() {
        let mut timing = Timing::default();
        timing.record("read", Duration::from_micros(100));
        timing.record("read", Duration::from_micros(300));
        timing.record("stat", Duration::from_micros(50));

        let mut out = Vec::new();
        timing.report(&mut out).expect("report");
        let text = String::from_utf8(out).expect("utf8");
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(
            lines[0].starts_with("timing: read count=2 total_ms=0.400 max_ms=0.300"),
            "{text}"
        );
        assert!(lines[1].starts_with("timing: stat count=1"), "{text}");
    }

    #[test]
    fn gc_is_reported_only_for_a_real_drop() {
        let mut tracker = GcTracker::new();
        assert_eq!(
            tracker.observe(1_000),
            None,
            "the first sample has no predecessor"
        );
        assert_eq!(tracker.observe(1_010), None, "growth is not a collection");
        assert_eq!(tracker.observe(990), None, "a 2% dip is allocator reuse");
        assert_eq!(
            tracker.observe(600),
            Some((990, 600)),
            "40% is a collection"
        );
    }
}
