//! The bootstrap snapshot the build embeds must be readable by the engine this test linked.
//!
//! `build.rs` compiles `js/bootstrap.js` with the same vendored quickjs-ng the runtime links, so a
//! mismatch here means a stale `OUT_DIR` or a toolchain that mixed two engine builds — the failure
//! a release binary would hit at boot. Running it as a test moves that discovery from "first user"
//! to "first build" (m7-plan §4.3).

/// The snapshot `ln-runtime` embeds. `OUT_DIR` here is this test's own build directory, but the
/// crate's build script wrote the artifact into its own; cargo passes both, and the crate re-exports
/// none of it, so the test re-reads the same path the crate compiled against.
fn snapshot_bytes() -> &'static [u8] {
    include_bytes!(concat!(env!("OUT_DIR"), "/js/bootstrap.bc"))
}

#[test]
fn the_snapshot_matches_the_engine_that_will_run_it() {
    let stamp = ln_engine::engine_stamp_parsed();
    let snapshot = ln_payload::snapshot::parse(snapshot_bytes(), &stamp)
        .unwrap_or_else(|error| panic!("the embedded bootstrap snapshot is unusable: {error}"));
    assert!(!snapshot.bytecode.is_empty(), "snapshot has no bytecode");
    assert_eq!(
        snapshot.bytecode.len() + ln_payload::snapshot::HEADER_LEN,
        snapshot_bytes().len()
    );
}

#[test]
fn a_truncated_snapshot_is_refused_rather_than_read() {
    let stamp = ln_engine::engine_stamp_parsed();
    let bytes = snapshot_bytes();
    // Truncation is the one corruption a stale build directory can produce cheaply; the engine must
    // never see it.
    let truncated = &bytes[..bytes.len() / 2];
    assert!(ln_payload::snapshot::parse(truncated, &stamp).is_err());
}
