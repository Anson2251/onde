//! Boot-time installation of the JavaScript bootstrap: source in debug, snapshot in release.
//!
//! `js/bootstrap.js` is one global script that defines the Node surface (`process`, timers, the
//! event emitter, the module loader seam). It is loaded on every start, so its parse is the largest
//! fixed cost in a cold start; M7 compiles it once at build time and embeds the bytecode
//! ([m7-plan §3.1](../../docs/m7-plan.md)).
//!
//! # Which path a build uses
//!
//! | Build | Embedded | Path |
//! |---|---|---|
//! | debug | source, plus the snapshot when `ONDE_BOOTSTRAP=bytecode` | `eval_global` by default |
//! | release | the snapshot only | `JS_EvalFunction` on loaded bytecode |
//!
//! Debug keeps the source because `cargo test` then exercises the reference semantics, and the A/B
//! proof runs both paths in one binary (`ONDE_BOOTSTRAP=source|bytecode`). A release build has no
//! source to fall back to, and says so rather than booting slowly: a release that cannot read its
//! own snapshot is a build bug, and D72 records the choice.
//!
//! # Why the snapshot is validated first
//!
//! `JS_READ_OBJ_BYTECODE` trusts the stream it is given, so the envelope's `BC_VERSION`, byte order
//! and atom-table hash are checked before the engine sees a byte. Both sides come from the same
//! vendored tree, so a mismatch means a stale build directory or a mixed toolchain — not a runtime
//! condition to recover from.

use ln_engine::{CaughtError, Engine};

/// The minified bootstrap, written by `build.rs`. Debug builds embed it; a release build would
/// otherwise carry ~550 KiB it can never use.
#[cfg(any(debug_assertions, feature = "bootstrap-source"))]
const SOURCE: &str = include_str!(concat!(env!("OUT_DIR"), "/js/bootstrap.js"));

/// The compiled bootstrap: `ln_payload::snapshot` envelope plus QuickJS bytecode.
const SNAPSHOT: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/js/bootstrap.bc"));

/// The script name a source boot uses. The snapshot bakes the same name in at compile time, so a
/// stack frame looks identical on both paths.
pub(crate) const BOOTSTRAP_NAME: &str = "<onde:bootstrap>";

/// Install the bootstrap into `engine`.
///
/// Errors carry the snapshot's validation failure verbatim: the message names the two numbers that
/// disagree, which is the whole diagnosis.
pub(crate) fn install(engine: &Engine) -> Result<(), CaughtError> {
    if use_snapshot().map_err(|message| CaughtError {
        name: "InternalError".to_owned(),
        display: message.clone(),
        message,
        stack: None,
        is_error: true,
        code: None,
    })? {
        return install_snapshot(engine);
    }
    #[cfg(any(debug_assertions, feature = "bootstrap-source"))]
    {
        engine.eval_global(SOURCE, BOOTSTRAP_NAME).map(|_| ())
    }
    #[cfg(not(any(debug_assertions, feature = "bootstrap-source")))]
    {
        // Unreachable: `use_snapshot` is always true here, because `parse_override` panics on the
        // only other value (D72). Kept rather than `unreachable!()` so a future default change is a
        // compile error about a missing source, not a runtime surprise.
        let _ = engine;
        unreachable!("a release build without bootstrap-source has no source path")
    }
}

/// True when this run should load the compiled bootstrap.
///
/// `ONDE_BOOTSTRAP=bytecode` selects it in any build; `source` is a compile-time question (D72), so
/// it either works or panics here rather than falling back silently.
fn use_snapshot() -> Result<bool, String> {
    match std::env::var("ONDE_BOOTSTRAP").as_deref() {
        Ok("bytecode") => Ok(true),
        // The override exists for the A/B proof; see the module docs.
        Ok("source") => using_source().map(|()| false),
        Ok(other) if !other.is_empty() => Err(format!(
            "ONDE_BOOTSTRAP={other} is not a bootstrap path; use \"source\" or \"bytecode\""
        )),
        _ => Ok(!cfg!(debug_assertions)),
    }
}

#[cfg(any(debug_assertions, feature = "bootstrap-source"))]
fn using_source() -> Result<(), String> {
    // `use_snapshot` asks "load bytecode?"; a source override answers no, and needs the source to
    // be compiled in, which this build configuration guarantees.
    Ok(())
}

/// D72: a shipped release embeds the snapshot only, so asking for the source is a build mistake and
/// must not be silently ignored — silently switching to bytecode would make the A/B comparison lie.
/// The `bootstrap-source` feature is the one build that carries both (m7-plan §4.3).
#[cfg(not(any(debug_assertions, feature = "bootstrap-source")))]
fn using_source() -> Result<(), String> {
    Err(
        "ONDE_BOOTSTRAP=source: this build embeds the bootstrap snapshot only (docs/m7-plan.md §4.3)"
            .to_owned(),
    )
}

fn install_snapshot(engine: &Engine) -> Result<(), CaughtError> {
    let stamp = ln_engine::engine_stamp_parsed();
    let snapshot = match ln_payload::snapshot::parse(SNAPSHOT, &stamp) {
        Ok(snapshot) => snapshot,
        // A release build cannot boot without a usable snapshot, and a debug build that asked for
        // the bytecode path is asserting that it works: both are fatal.
        Err(error) => {
            return Err(CaughtError {
                name: "InternalError".to_owned(),
                display: format!("bootstrap snapshot: {error}"),
                message: format!(
                    "bootstrap snapshot: {error} (this engine: {})",
                    engine_version()
                ),
                stack: None,
                is_error: true,
                code: None,
            })
        }
    };
    engine
        .eval_script_bytecode(snapshot.bytecode, BOOTSTRAP_NAME)
        .map(|_| ())
}

fn engine_version() -> String {
    ln_engine::engine_stamp_parsed().summary()
}
