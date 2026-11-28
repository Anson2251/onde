//! Locate libffi.
//!
//! Unlike the other runtime crates this one links a C library. libffi ships with the macOS SDK
//! and is a normal package on Linux (`libffi-dev`/`libffi-devel`), so the default is to link the
//! system copy with `-lffi`. `LIBFFI_LIB_DIR` (and `LIBFFI_INCLUDE_DIR`) override that for a
//! toolchain that keeps it somewhere the linker does not search, which is the case for a
//! Homebrew `libffi` installed without `brew link --force`.
//!
//! The plan's stated floor is libffi 3.3 for `ffi_get_struct_offsets`; the symbol is checked at
//! link time by the raw bindings, so a 3.2 system fails loudly instead of at the first struct.

use std::path::PathBuf;

fn main() {
    // Re-run only when the hint changes; the library itself is a link-time input.
    println!("cargo:rerun-if-env-changed=LIBFFI_LIB_DIR");

    if let Some(dir) = std::env::var_os("LIBFFI_LIB_DIR") {
        let dir = PathBuf::from(dir);
        let name = ffi_library_name();
        if !dir.join(name).exists() {
            println!(
                "cargo:warning=LIBFFI_LIB_DIR={} does not contain {name}",
                dir.display()
            );
        }
        println!("cargo:rustc-link-search=native={}", dir.display());
    }

    // The crate declares the C surface by hand (see src/raw.rs), so only the linker needs the
    // library. That keeps the build independent of header locations and of bindgen/libclang.
    //
    // No extra search directories are emitted: the system compiler already knows its own default
    // and multiarch paths. `LIBFFI_LIB_DIR` covers a layout it does not know (for example a
    // Homebrew keg that is not linked).
    println!("cargo:rustc-link-lib=ffi");
}

/// The target library name, from Cargo's target facts rather than the build host's.
fn ffi_library_name() -> &'static str {
    match std::env::var("CARGO_CFG_TARGET_OS").as_deref() {
        Ok("macos") | Ok("ios") => "libffi.dylib",
        _ => "libffi.so",
    }
}
