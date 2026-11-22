//! The C ABI of a compiled onde app.
//!
//! A compiled app is a C `main` plus `libonde.a`. This crate is the bridge between them: it owns
//! the exported symbols (`onde_main_payload`, `onde_engine_stamp`, `onde_version`), the header
//! next to it (`include/onde.h`), and the engine-identity marker the build tool scans the archive
//! for.
//!
//! # The contract
//!
//! - **The payload must outlive the call and must not be written to.** QuickJS reads module
//!   bytecode in place (`JS_READ_OBJ_ROM_DATA`), so a linked `const` array, a linker section or a
//!   read-only mapping are all fine; a stack buffer that gets reused is not.
//! - **One Rust static library per program.** `libonde.a` carries `std`, so linking a second Rust
//!   `staticlib` into the same program yields thousands of duplicate symbols. Link the other one
//!   as a `cdylib`, or fold it into this archive.
//! - **`panic = "abort"`.** A Rust panic aborts the process; there is no unwinding across
//!   `onde_main_payload` and no exception a C caller could catch.
//! - **One isolate per thread.** The thread that calls `onde_main_payload` is the isolate thread;
//!   the call returns when the event loop drains.
//! - **Signals are installed lazily.** `ln-io` installs its handlers the first time the program
//!   registers a listener (`process.on('SIGINT')`), not at startup.
//!
//! # Why the marker is a byte string
//!
//! `ondec` links the app against an archive it did not build. It has to answer "is this archive
//! the same engine as the bytecode I just compiled?" without a linker, a symbol table or a
//! disassembler — and without knowing the target architecture. So the answer is written into
//! `.rodata` as text (see `ONDE_ABI_MARKER`), and the tool scans for it. `ln-engine` bakes the
//! same string into the runtime; `onde_engine_stamp()` returns it; a payload header repeats the
//! part of it that bytecode depends on.

use std::ffi::{c_char, c_int, CStr};
use std::io::Write;

use ln_runtime::{Config, Failure, Isolate, PayloadBytes};

mod abi {
    include!(concat!(env!("OUT_DIR"), "/abi_marker.rs"));
}

pub use abi::ENGINE_STAMP;

/// `ONDE_ABI_VERSION` from `onde.h`, so a host can compare without parsing the header.
pub const ABI_VERSION: u32 = 1;

/// The version string `onde_version()` returns.
static ONDE_VERSION_C: &[u8] = concat!(env!("CARGO_PKG_VERSION"), "\0").as_bytes();

/// Run a payload in this process and return the exit code.
///
/// This is what a generated `main` calls, and what a long-lived C host calls to embed onde. It
/// borrows the payload; nothing is copied.
///
/// # Safety
///
/// `blob` must point to `len` bytes that stay readable, valid module bytecode for this build, and
/// immutable for the whole call. `argv` must be a valid C `argv` of `argc` entries. In practice
/// both come from a generated `main`, which is why the contract is documented here rather than
/// defended against: a payload that violates it is a build-tool bug, and `onde_main_payload`
/// checks the parts it can (format, engine identity) before the engine sees it.
#[no_mangle]
pub unsafe extern "C" fn onde_main_payload(
    blob: *const u8,
    len: usize,
    argc: c_int,
    argv: *const *const c_char,
) -> c_int {
    if blob.is_null() || len == 0 {
        let mut err = std::io::stderr().lock();
        let _ = writeln!(err, "onde: the payload is empty or missing");
        return 1;
    }

    // SAFETY: the caller guarantees `blob` is `len` readable bytes that outlive the call, and
    // `'static` is the only lifetime that can be promised here. The bytes are never written.
    let payload: &'static [u8] = unsafe { std::slice::from_raw_parts(blob, len) };
    // SAFETY: same contract for the C argv.
    let args = unsafe { collect_argv(argc, argv) };
    run(payload, args)
}

/// Run a payload from Rust (tests, and hosts that already have the bytes).
///
/// `args` is the process's `argv` as the OS passed it; [`node_argv`] turns it into Node's shape.
pub fn run(payload: &'static [u8], args: Vec<String>) -> i32 {
    let mut config = Config::new(node_argv(args));
    config.payload = Some(PayloadBytes(payload));

    let mut isolate = match Isolate::new(config) {
        Ok(isolate) => isolate,
        Err(failure) => return report(failure),
    };
    match isolate.run_payload() {
        Ok(outcome) => outcome.exit_code,
        Err(failure) => report(failure),
    }
}

/// Node's `process.argv` shape for a compiled app: `[exec, exec, ...args]`.
///
/// There is no script path, so `argv[1]` repeats `argv[0]` — exactly what Node's SEA does, and
/// what programs that skip `argv.slice(2)` expect. `process.execPath` is `argv[0]`.
pub fn node_argv(args: Vec<String>) -> Vec<String> {
    let exe = args.first().cloned().unwrap_or_else(|| "onde".to_owned());
    let mut argv = Vec::with_capacity(args.len() + 1);
    argv.push(exe.clone());
    argv.push(exe);
    argv.extend(args.into_iter().skip(1));
    argv
}

fn report(failure: Failure) -> i32 {
    let mut err = std::io::stderr().lock();
    let _ = writeln!(err, "onde: {failure}");
    let _ = err.flush();
    failure.exit_code()
}

/// Copy a C `argv` into owned strings.
///
/// Invalid UTF-8 in a path is replaced rather than rejected, like `std::env::args` on Unix: the
/// alternative is a runtime that cannot start because one argument is not text.
///
/// # Safety
///
/// `argv` must be a valid array of `argc` C strings, each NUL-terminated.
unsafe fn collect_argv(argc: c_int, argv: *const *const c_char) -> Vec<String> {
    if argc <= 0 || argv.is_null() {
        return Vec::new();
    }
    let mut args = Vec::with_capacity(argc as usize);
    for index in 0..argc as usize {
        // SAFETY: the caller guarantees `argv` has `argc` entries.
        let pointer = unsafe { *argv.add(index) };
        if pointer.is_null() {
            args.push(String::new());
            continue;
        }
        // SAFETY: each entry is a NUL-terminated C string.
        let text = unsafe { CStr::from_ptr(pointer) };
        args.push(text.to_string_lossy().into_owned());
    }
    args
}

/// The engine identity this archive was built with: `"ONDE-ABI:1;qjs=…;bc=28;…;"`.
///
/// Compare it with the payload header when embedding onde in a long-lived host: bytecode from a
/// different engine must not be loaded.
#[no_mangle]
pub extern "C" fn onde_engine_stamp() -> *const c_char {
    abi::ENGINE_STAMP_C.as_ptr().cast()
}

/// This archive's onde version, `"0.1.0"`.
///
/// The header and the archive must agree on [`ABI_VERSION`]; the version string is for logs and
/// error messages.
#[no_mangle]
pub extern "C" fn onde_version() -> *const c_char {
    ONDE_VERSION_C.as_ptr().cast()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn the_marker_is_in_the_archive_and_matches_the_engine() {
        assert_eq!(
            ENGINE_STAMP,
            ln_engine::engine_stamp(),
            "the archive and the engine must carry the same identity"
        );
        assert_eq!(
            std::str::from_utf8(&abi::ONDE_ABI_MARKER).unwrap(),
            ENGINE_STAMP
        );
        assert!(ENGINE_STAMP.starts_with("ONDE-ABI:1;"));
        // The C string has the NUL the header promises.
        assert_eq!(
            abi::ENGINE_STAMP_C.last(),
            Some(&0u8),
            "onde_engine_stamp() returns a NUL-terminated string"
        );
    }

    #[test]
    fn argv_has_the_node_sea_shape() {
        assert_eq!(
            node_argv(strings(&["/usr/local/bin/app", "--flag", "x"])),
            strings(&["/usr/local/bin/app", "/usr/local/bin/app", "--flag", "x"])
        );
        assert_eq!(
            node_argv(strings(&["app"])),
            strings(&["app", "app"]),
            "no arguments still gives Node's two entries"
        );
        assert_eq!(node_argv(Vec::new()), strings(&["onde", "onde"]));
    }

    #[test]
    fn the_version_comes_from_the_crate() {
        assert_eq!(
            std::str::from_utf8(ONDE_VERSION_C).unwrap(),
            concat!(env!("CARGO_PKG_VERSION"), "\0")
        );
    }
}
