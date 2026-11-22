//! `ondec`, as a library.
//!
//! The binary is a thin command-line wrapper around these modules; they are public so the
//! end-to-end tests can drive the same pipeline the user does, and so an editor integration can
//! bundle without spawning a process.
//!
//! The pieces:
//!
//! - [`frontend`] — rolldown, in-process: entries in, ES modules out, keys from filenames;
//! - [`payload`] — encode the modules into the payload format the runtime reads;
//! - [`emit`] — the generated C file (array or linker section);
//! - [`toolchain`] — target tuples, compiler resolution, the one `cc` invocation;
//! - [`sdk`] — cache, download, `SHA256SUMS`, ABI stamp;
//! - [`sign`] — the platform signer;
//! - [`wrappe`] — the optional self-extracting backend;
//! - [`build_cmd`] — the pipeline that puts them in order.

pub mod build_cmd;
pub mod emit;
pub mod frontend;
pub mod payload;
pub mod sdk;
pub mod sign;
pub mod target;
pub mod toolchain;
pub mod wrappe;
