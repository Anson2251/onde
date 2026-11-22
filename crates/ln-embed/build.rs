//! Bakes the ABI marker into the archive.
//!
//! `ondec` finds the engine identity by scanning the archive for `ONDE-ABI:`, so the bytes have to
//! be *in* the archive, not derived from a build script the tool would also have to run. The
//! string is the same one `ln-engine` bakes into the engine (`engine_stamp()`), so the archive and
//! the runtime it contains cannot disagree.
//!
//! Two generated constants:
//!
//! - `ENGINE_STAMP`: the identity string, without a NUL, for tests and reports;
//! - `ENGINE_STAMP_C`: the same bytes plus a NUL, so `onde_engine_stamp()` can hand C a
//!   `const char *` straight out of `.rodata` with no allocation and no static initialisation.

use std::env;
use std::fs;
use std::path::PathBuf;

use ln_abi::Stamp;

fn main() {
    let dir = ln_abi::vendored_engine_dir();
    println!("cargo:rerun-if-changed={}", dir.join("quickjs.c").display());
    println!("cargo:rerun-if-changed={}", dir.join("quickjs.h").display());
    println!(
        "cargo:rerun-if-changed={}",
        dir.join("quickjs-atom.h").display()
    );
    println!("cargo:rerun-if-env-changed=ONDE_QUICKJS_DIR");

    let mut stamp = Stamp::read(&dir).unwrap_or_else(|error| {
        panic!(
            "cannot read the engine identity from {}: {error}",
            dir.display()
        )
    });
    stamp.endian = match env::var("CARGO_CFG_TARGET_ENDIAN").as_deref() {
        Ok("big") => ln_abi::Endian::Big,
        Ok("little") => ln_abi::Endian::Little,
        other => panic!("CARGO_CFG_TARGET_ENDIAN is {other:?}; expected little or big"),
    };
    let text = stamp.encode();
    assert!(
        text.chars().all(|c| c.is_ascii_graphic()),
        "the ABI stamp must be a plain ASCII byte string: {text:?}"
    );

    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR")).join("abi_marker.rs");
    let len = text.len();
    let source = format!(
        "/// The engine identity, as the `ONDE-ABI:...;` string.\n\
         pub const ENGINE_STAMP: &str = {text:?};\n\
         \n\
         /// `ENGINE_STAMP` plus a NUL, for `onde_engine_stamp()`.\n\
         pub const ENGINE_STAMP_C: &[u8] = b\"{text}\\0\";\n\
         \n\
         /// Length of the marker bytes kept in the archive.\n\
         pub const MARKER_LEN: usize = {len};\n\
         \n\
         /// The marker `ondec` scans for in `libonde-*.a`.\n\
         ///\n\
         /// `#[used]` keeps the object alive under LTO, and `#[no_mangle]` keeps the symbol\n\
         /// findable in a debugger; the *bytes* are what the scan matches.\n\
         #[used]\n\
         #[no_mangle]\n\
         pub static ONDE_ABI_MARKER: [u8; MARKER_LEN] = *b\"{text}\";\n"
    );
    fs::write(&out, source).unwrap_or_else(|error| panic!("write {}: {error}", out.display()));
}
