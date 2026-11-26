//! Integration tests for the M5 WP3 child-process service (`ln_io::proc`).
//!
//! Every positive wait is bounded (`WAIT`) so a protocol bug fails the test instead of hanging it.
//! The two "nothing happens" assertions (no events after shutdown, no `Spawned` for a missing
//! program) necessarily wait a short bounded time for the absence of an event; that is the only way
//! to observe a negative.
//!
//! Reads are pull-based, so the pump helper issues the next `Read` for a stream after each `Data`,
//! exactly like `internal/pipe.js` will.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

use ln_io::proc::{
    encode_frame, ipc_pair, ChildId, ChildIdSource, ChildService, Command, Event, EventSink,
    FrameDecoder, SpawnOptions, StdioMode, Stream, MAX_FRAME_SIZE,
};
use ln_io::{Permit, Pool};

/// Every positive wait fails the test after five seconds instead of hanging.
const WAIT: Duration = Duration::from_secs(5);
/// How long "no event must arrive" is observed for.
const QUIET: Duration = Duration::from_millis(250);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

struct Harness {
    service: ChildService,
    events: mpsc::Receiver<(ChildId, Event)>,
    // Declared last so the service (and its shutdown) drops before the runtime, like an isolate.
    _pool: Arc<Pool>,
}

impl Harness {
    fn new() -> Self {
        let pool = Arc::new(Pool::new_unconfined(1).expect("pool"));
        let (sender, events) = mpsc::channel();
        let sink: EventSink = Arc::new(move |id, event| {
            // A closed receiver only happens while the test (and its runtime) is tearing down.
            let _ = sender.send((id, event));
        });
        let next = Arc::new(AtomicU64::new(1));
        let ids: ChildIdSource = Arc::new(move || next.fetch_add(1, Ordering::SeqCst));
        Harness {
            service: ChildService::new(pool.clone(), sink, ids, Permit::unconfined()),
            events,
            _pool: pool,
        }
    }

    fn spawn(&self, id: ChildId, options: SpawnOptions) {
        self.service.spawn(id, options, None).expect("spawn");
    }

    fn next(&mut self) -> (ChildId, Event) {
        self.events
            .recv_timeout(WAIT)
            .unwrap_or_else(|error| panic!("no event: {error}"))
    }

    /// The next event, asserting it belongs to `id`.
    fn next_for(&mut self, id: ChildId) -> Event {
        let (event_id, event) = self.next();
        assert_eq!(event_id, id, "event for the wrong child: {event:?}");
        event
    }

    /// Pump reads for `reads` and collect events until `close`, like a flowing JS stream.
    fn collect_until_close(&mut self, id: ChildId, reads: &[Stream]) -> Vec<Event> {
        for stream in reads {
            self.service.command(
                id,
                Command::Read {
                    stream: *stream,
                    max: 8 * 1024,
                },
            );
        }
        let mut events = Vec::new();
        loop {
            let event = self.next_for(id);
            if let Event::Data { stream, .. } = &event {
                let stream = *stream;
                self.service.command(
                    id,
                    Command::Read {
                        stream,
                        max: 8 * 1024,
                    },
                );
            }
            let closed = matches!(event, Event::Close { .. });
            events.push(event);
            if closed {
                return events;
            }
        }
    }

    /// Assert that no event is delivered during [`QUIET`] (H4, and "no `Spawned`").
    fn assert_quiet(&mut self) {
        match self.events.recv_timeout(QUIET) {
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Ok((id, event)) => panic!("unexpected event for child {id}: {event:?}"),
            Err(error) => panic!("event channel closed while quiet: {error}"),
        }
    }
}

fn options(program: &str, args: &[&str], stdio: [StdioMode; 3]) -> SpawnOptions {
    SpawnOptions {
        program: program.into(),
        args: args.iter().map(|arg| (*arg).to_string()).collect(),
        cwd: None,
        env: None,
        stdio,
        detached: false,
        argv0: None,
    }
}

fn bytes_for(events: &[Event], stream: Stream) -> Vec<u8> {
    events
        .iter()
        .filter_map(|event| match event {
            Event::Data {
                stream: actual,
                bytes,
            } if *actual == stream => Some(bytes.as_slice()),
            _ => None,
        })
        .flatten()
        .copied()
        .collect()
}

fn position(events: &[Event], predicate: impl Fn(&Event) -> bool) -> Option<usize> {
    events.iter().position(predicate)
}

fn exit_of(events: &[Event]) -> (Option<i32>, Option<i32>) {
    events
        .iter()
        .find_map(|event| match event {
            Event::Exit { code, signal } => Some((*code, *signal)),
            _ => None,
        })
        .expect("an Exit event")
}

// ---------------------------------------------------------------------------
// 1. stdout, EOF, exit, close
// ---------------------------------------------------------------------------

#[test]
fn stdout_is_read_until_eof_then_exit_then_close() {
    let mut harness = Harness::new();
    let id = 1;
    harness.spawn(
        id,
        options(
            "/bin/sh",
            &["-c", "printf hello"],
            [StdioMode::Ignore, StdioMode::Pipe, StdioMode::Ignore],
        ),
    );

    let events = harness.collect_until_close(id, &[Stream::Stdout]);
    assert_eq!(bytes_for(&events, Stream::Stdout), b"hello", "{events:?}");
    assert!(
        position(&events, |event| matches!(
            event,
            Event::End {
                stream: Stream::Stdout
            }
        ))
        .is_some(),
        "stdout must end: {events:?}"
    );
    assert!(matches!(events.first(), Some(Event::Spawned { .. })));
    assert_eq!(exit_of(&events), (Some(0), None));
    let exit = position(&events, |event| matches!(event, Event::Exit { .. })).expect("exit");
    let close = position(&events, |event| matches!(event, Event::Close { .. })).expect("close");
    assert!(exit < close, "exit must precede close: {events:?}");
    assert!(close + 1 == events.len(), "close must be last: {events:?}");
}

// ---------------------------------------------------------------------------
// 2. stdin: write, end, echoed data
// ---------------------------------------------------------------------------

#[test]
fn stdin_write_then_end_is_echoed_and_exits_zero() {
    let mut harness = Harness::new();
    let id = 2;
    harness.spawn(
        id,
        options(
            "cat",
            &[],
            [StdioMode::Pipe, StdioMode::Pipe, StdioMode::Ignore],
        ),
    );

    harness.service.command(
        id,
        Command::Write {
            stream: Stream::Stdin,
            data: b"hello from stdin\n".to_vec(),
        },
    );
    harness.service.command(
        id,
        Command::End {
            stream: Stream::Stdin,
        },
    );

    let events = harness.collect_until_close(id, &[Stream::Stdout]);
    assert_eq!(
        bytes_for(&events, Stream::Stdout),
        b"hello from stdin\n",
        "{events:?}"
    );
    assert!(
        position(&events, |event| matches!(
            event,
            Event::Drain {
                stream: Stream::Stdin
            }
        ))
        .is_some(),
        "the stdin queue must drain: {events:?}"
    );
    assert_eq!(exit_of(&events), (Some(0), None));
}

// ---------------------------------------------------------------------------
// 3. kill, exit by signal, shutdown gates events
// ---------------------------------------------------------------------------

#[test]
fn kill_terminates_the_child_and_shutdown_stops_events() {
    let mut harness = Harness::new();
    let id = 3;
    harness.spawn(id, options("sleep", &["30"], [StdioMode::Ignore; 3]));

    let event = harness.next_for(id);
    let pid = match event {
        Event::Spawned { pid } => pid,
        other => panic!("expected Spawned, got {other:?}"),
    };
    assert!(pid > 0);

    harness.service.command(id, Command::Kill { signal: 15 }); // SIGTERM

    // All three stdio slots are ignored, so `close` follows `exit` directly. Reaching this point
    // (rather than timing out) is the "reaped, not a zombie-style hang" assertion.
    let events = harness.collect_until_close(id, &[]);
    assert_eq!(
        exit_of(&events),
        (None, Some(15)),
        "SIGTERM must be reported as a signal: {events:?}"
    );

    harness.service.shutdown();
    harness.assert_quiet();
}

// ---------------------------------------------------------------------------
// 4. exit/close ordering in the sink's vector
// ---------------------------------------------------------------------------

#[test]
fn exit_is_emitted_before_close() {
    let mut harness = Harness::new();
    let id = 4;
    harness.spawn(
        id,
        options(
            "/bin/sh",
            &["-c", "printf done"],
            [StdioMode::Ignore, StdioMode::Pipe, StdioMode::Ignore],
        ),
    );

    let events = harness.collect_until_close(id, &[Stream::Stdout]);
    assert_eq!(bytes_for(&events, Stream::Stdout), b"done");
    let exit = position(&events, |event| matches!(event, Event::Exit { .. })).expect("exit");
    let close = position(&events, |event| matches!(event, Event::Close { .. })).expect("close");
    assert!(
        exit < close,
        "Exit must be recorded before Close in the sink's vector: {events:?}"
    );
    assert_eq!(exit_of(&events), (Some(0), None));
    // A `close` payload repeats the exit status, as in Node.
    match &events[close] {
        Event::Close { code, signal } => {
            assert_eq!((*code, *signal), (Some(0), None));
        }
        other => panic!("expected Close, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// 5. ENOENT is asynchronous and never `Spawned`
// ---------------------------------------------------------------------------

#[test]
fn a_missing_program_is_an_async_error_without_spawned() {
    let mut harness = Harness::new();
    let id = 5;
    let missing = "/onde-tests/definitely-not-a-program";
    // Node semantics: a missing program does not throw, it emits `error` later.
    harness
        .service
        .spawn(id, options(missing, &[], [StdioMode::Ignore; 3]), None)
        .expect("spawn must not fail synchronously for a missing program");

    let event = harness.next_for(id);
    let error = match event {
        Event::Error { error } => error,
        other => panic!("expected Error, got {other:?}"),
    };
    assert_eq!(error.code, "ENOENT", "{error:?}");
    assert_eq!(error.errno, Some(2), "ENOENT is 2 on macOS and Linux");
    assert_eq!(error.syscall, Some("spawn"));
    assert_eq!(error.path.as_deref(), Some(Path::new(missing)));

    // No `Spawned`, no `Exit`, no `Close` for a process that never existed.
    harness.assert_quiet();
}

// ---------------------------------------------------------------------------
// 6. IPC codec and a Unix pair round-trip (no process)
// ---------------------------------------------------------------------------

#[test]
fn ipc_frames_round_trip_and_oversized_frames_are_rejected() {
    // Encode/decode, including a frame split across two reads.
    let frame = encode_frame(b"{\"cmd\":\"ping\"}").expect("encode");
    assert_eq!(&frame[..4], &14u32.to_le_bytes());
    let mut decoder = FrameDecoder::new();
    decoder.push(&frame[..6]);
    assert_eq!(decoder.next_frame().expect("partial"), None);
    decoder.push(&frame[6..]);
    assert_eq!(
        decoder.next_frame().expect("frame"),
        Some(b"{\"cmd\":\"ping\"}".to_vec())
    );
    assert_eq!(decoder.next_frame().expect("drained"), None);

    // Oversized: the length prefix alone is enough to reject, before any payload is buffered.
    let mut oversized = FrameDecoder::new();
    oversized.push(&(MAX_FRAME_SIZE + 1).to_le_bytes());
    let error = oversized.next_frame().expect_err("oversized frame");
    assert_eq!(error.code, "ERR_IPC_FRAME_TOO_LARGE");

    // Oversized on encode too (the service frames `send` itself).
    let payload = vec![0u8; MAX_FRAME_SIZE as usize + 1];
    let error = encode_frame(&payload).expect_err("oversized payload");
    assert_eq!(error.code, "ERR_IPC_FRAME_TOO_LARGE");

    // A real Unix socket pair: one end writes frames, the other reads them, no child involved.
    let (parent, child) = ipc_pair().expect("ipc_pair");
    child.write_frame(b"one").expect("write one");
    child.write_frame(b"two").expect("write two");
    assert_eq!(parent.read_frame().expect("one"), Some(b"one".to_vec()));
    assert_eq!(parent.read_frame().expect("two"), Some(b"two".to_vec()));
    drop(child);
    assert_eq!(parent.read_frame().expect("eof"), None);
}

// ---------------------------------------------------------------------------
// 7. cwd and env
// ---------------------------------------------------------------------------

#[test]
fn cwd_and_env_are_applied_to_the_child() {
    let dir = tempfile::tempdir().expect("tempdir");
    // `pwd` prints the physical path; on macOS a tempdir is under `/var`, a symlink to
    // `/private/var`, so compare against the canonical form.
    let expected_cwd = std::fs::canonicalize(dir.path()).expect("canonicalize");

    let mut harness = Harness::new();
    let id = 7;
    let mut spawn = options(
        "/bin/sh",
        &["-c", "pwd; printf '%s|%s' \"$FOO\" \"${HOME-unset}\""],
        [StdioMode::Ignore, StdioMode::Pipe, StdioMode::Ignore],
    );
    spawn.cwd = Some(dir.path().to_path_buf());
    spawn.env = Some(vec![
        ("FOO".to_string(), Some("bar".to_string())),
        // `Some` clears the inherited environment, so the deletion is explicit.
        ("HOME".to_string(), None),
    ]);
    harness.spawn(id, spawn);

    let events = harness.collect_until_close(id, &[Stream::Stdout]);
    let output = String::from_utf8(bytes_for(&events, Stream::Stdout)).expect("utf-8");
    let mut lines = output.splitn(2, '\n');
    assert_eq!(
        lines.next(),
        Some(expected_cwd.display().to_string().as_str()),
        "child cwd: {output:?}"
    );
    assert_eq!(lines.next(), Some("bar|unset"), "child env: {output:?}");
    assert_eq!(exit_of(&events), (Some(0), None));
}

// ---------------------------------------------------------------------------
// 8. detached: own process group
// ---------------------------------------------------------------------------

/// `kill -0 -$$` succeeds only when the shell leads its own process group (the group id must be
/// the pid of a live group leader). That is a `ps`-free way to observe `process_group(0)`, and
/// `ps` is not available in every sandbox.
const GROUP_PROBE: &str = "kill -0 -$$ 2>/dev/null && printf grouped || printf not-grouped";

#[test]
fn detached_puts_the_child_in_its_own_process_group() {
    let mut harness = Harness::new();
    let id = 8;
    let mut spawn = options(
        "/bin/sh",
        &["-c", GROUP_PROBE],
        [StdioMode::Ignore, StdioMode::Pipe, StdioMode::Ignore],
    );
    spawn.detached = true;
    harness.spawn(id, spawn);
    let events = harness.collect_until_close(id, &[Stream::Stdout]);
    assert_eq!(
        bytes_for(&events, Stream::Stdout),
        b"grouped",
        "a detached child must lead its own process group: {events:?}"
    );

    // The same child without `detached` shares the parent's group, which proves the probe.
    let id = 9;
    harness.spawn(
        id,
        options(
            "/bin/sh",
            &["-c", GROUP_PROBE],
            [StdioMode::Ignore, StdioMode::Pipe, StdioMode::Ignore],
        ),
    );
    let events = harness.collect_until_close(id, &[Stream::Stdout]);
    assert_eq!(
        bytes_for(&events, Stream::Stdout),
        b"not-grouped",
        "a non-detached child shares the parent's process group: {events:?}"
    );
}

// ---------------------------------------------------------------------------
// 9. argv0
// ---------------------------------------------------------------------------

#[test]
fn argv0_overrides_the_childs_argv_zero() {
    let mut harness = Harness::new();
    let id = 10;
    let mut spawn = options(
        "/bin/sh",
        &["-c", "printf %s \"$0\""],
        [StdioMode::Ignore, StdioMode::Pipe, StdioMode::Ignore],
    );
    spawn.argv0 = Some("custom-argv0".to_string());
    harness.spawn(id, spawn);

    let events = harness.collect_until_close(id, &[Stream::Stdout]);
    assert_eq!(
        bytes_for(&events, Stream::Stdout),
        b"custom-argv0",
        "{events:?}"
    );
    assert_eq!(exit_of(&events), (Some(0), None));
}

// ---------------------------------------------------------------------------
// 10. large stdin: several queued buffers, partial pipe writes, exact echo
// ---------------------------------------------------------------------------

#[test]
fn large_stdin_is_written_once_and_echoed_intact() {
    let payload: Vec<u8> = (0..1024 * 1024).map(|index| (index % 251) as u8).collect();

    let mut harness = Harness::new();
    let id = 11;
    // The child sleeps before it reads, so the first write fills the 64 KiB pipe and blocks while
    // the remaining `Write` commands are still queued. That is what makes a queue-offset bug
    // (resetting the front buffer's progress when another chunk is queued) deterministic.
    harness.spawn(
        id,
        options(
            "/bin/sh",
            &["-c", "sleep 0.3; exec cat"],
            [StdioMode::Pipe, StdioMode::Pipe, StdioMode::Ignore],
        ),
    );

    // The first chunk is partially written while the child is not reading; queue the rest only
    // after that, so the service has to resume the front buffer at its offset rather than
    // restarting it. With a 64 KiB pipe one `write` cannot consume a 200 KiB chunk.
    let chunks: Vec<&[u8]> = payload.chunks(200 * 1024).collect();
    harness.service.command(
        id,
        Command::Write {
            stream: Stream::Stdin,
            data: chunks[0].to_vec(),
        },
    );
    std::thread::sleep(Duration::from_millis(100));
    for chunk in &chunks[1..] {
        harness.service.command(
            id,
            Command::Write {
                stream: Stream::Stdin,
                data: chunk.to_vec(),
            },
        );
    }
    harness.service.command(
        id,
        Command::End {
            stream: Stream::Stdin,
        },
    );

    let events = harness.collect_until_close(id, &[Stream::Stdout]);
    let echoed = bytes_for(&events, Stream::Stdout);
    assert_eq!(
        echoed.len(),
        payload.len(),
        "stdin bytes must be written exactly once, in order"
    );
    if echoed != payload {
        let first = echoed
            .iter()
            .zip(&payload)
            .position(|(actual, expected)| actual != expected);
        panic!("echoed bytes differ from the payload at offset {first:?}");
    }
    assert_eq!(exit_of(&events), (Some(0), None));
}
