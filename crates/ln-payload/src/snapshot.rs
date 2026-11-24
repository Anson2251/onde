//! The bootstrap snapshot: one compiled script plus the engine facts needed to read it.
//!
//! The runtime's JavaScript bootstrap is evaluated on every start. Compiling it to bytecode at
//! build time removes that parse from startup (m7-plan §3.1–3.2), and this module is the envelope
//! that makes the bytes loadable safely.
//!
//! ```text
//! header (25 bytes, little-endian)
//!   magic "ONDESNAP\0" | format u16 | flags u16
//!   bc_version u8 | endian u8 | reserved u16
//!   len u32 | atom u32
//! body
//!   QuickJS bytecode for one global-scope function
//! ```
//!
//! # Why a header at all
//!
//! `JS_READ_OBJ_BYTECODE` is documented as unsafe against a stream it did not produce: a wrong
//! `BC_VERSION` can surface as "read after the end of the buffer" rather than as a version error
//! ([qjsc.md §4.2](../../docs/research/qjsc.md)). The payload's header already exists for that
//! reason, and the snapshot repeats it for the same three facts — bytecode version, byte order and
//! atom table hash — checked *before* the engine sees a byte.
//!
//! What the check cannot do is request a byte order. quickjs-ng 0.17 defines
//! `JS_WRITE_OBJ_BSWAP` as 0 ("obsolete, handled transparently"), so bytecode is always written in
//! the producer's native order; a cross-built snapshot is therefore refused by the `endian` byte
//! rather than converted. That is why the field is recorded even though both ends are little-endian.
//!
//! # Why it lives in this crate
//!
//! Both the writer and the reader need it: `ln-runtime`'s build script writes the blob and the
//! runtime reads it. A build script cannot depend on the crate it builds, so the format cannot live
//! in `ln-runtime`; it sits beside the app payload, which has the same job and the same rules.

use ln_abi::{Endian, Stamp};

/// An uncompressed bootstrap snapshot starts with these bytes.
pub const MAGIC: [u8; 9] = *b"ONDESNAP\0";

/// The snapshot format this crate reads and writes.
pub const FORMAT: u16 = 1;

/// Size of the fixed header.
pub const HEADER_LEN: usize = 25;

/// Reserved flag bits; no flag is defined in format 1.
pub const FLAG_NONE: u16 = 0;

/// A validated snapshot, borrowing its body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Snapshot<'a> {
    /// The QuickJS bytecode for one global-scope function.
    pub bytecode: &'a [u8],
    /// `BC_VERSION` of the engine that wrote it.
    pub bc_version: u8,
    /// Byte order of the producer.
    pub endian: Endian,
    /// FNV-1a of the producer's atom table.
    pub atom: u32,
}

/// Why a blob is not a snapshot this runtime can read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// Shorter than one header, or the length field points past the end.
    Truncated,
    /// The magic is not `ONDESNAP\0`.
    NotASnapshot,
    /// A format this build does not know.
    UnsupportedFormat(u16),
    /// A flag this build does not know.
    UnsupportedFlags(u16),
    /// The bytecode was produced by an engine with a different `BC_VERSION`.
    BytecodeVersion { snapshot: u8, engine: u8 },
    /// The producer and this runtime are of different byte order.
    Endian { snapshot: Endian, engine: Endian },
    /// The producer's atom table differs, so every atom index in the bytecode is meaningless.
    AtomTable { snapshot: u32, engine: u32 },
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Truncated => write!(f, "the snapshot is truncated"),
            Error::NotASnapshot => write!(f, "not an onde bootstrap snapshot"),
            Error::UnsupportedFormat(format) => {
                write!(f, "snapshot format {format} is not supported by this build")
            }
            Error::UnsupportedFlags(flags) => {
                write!(
                    f,
                    "snapshot flags {flags:#06x} are not understood by this build"
                )
            }
            Error::BytecodeVersion { snapshot, engine } => write!(
                f,
                "snapshot bytecode version {snapshot} does not match this engine's {engine}"
            ),
            Error::Endian { snapshot, engine } => write!(
                f,
                "snapshot is {} endian and this engine is {}",
                snapshot.as_str(),
                engine.as_str()
            ),
            Error::AtomTable { snapshot, engine } => write!(
                f,
                "snapshot atom table {snapshot:#010x} does not match this engine's {engine:#010x}"
            ),
        }
    }
}

impl std::error::Error for Error {}

/// Encode one snapshot from bytecode, taking the compatibility facts from `stamp`.
///
/// `stamp` must be the stamp of the engine that *produced* the bytecode. The build script passes
/// `ln_engine::engine_stamp_parsed()`, which is baked in from the same vendored tree the runtime
/// links, so the two agree by construction and the check only catches a stale build directory.
pub fn encode(bytecode: &[u8], stamp: &Stamp) -> Vec<u8> {
    let len = u32::try_from(bytecode.len()).expect("bootstrap bytecode fits in u32");
    let mut out = Vec::with_capacity(HEADER_LEN + bytecode.len());
    out.extend_from_slice(&MAGIC);
    out.extend_from_slice(&FORMAT.to_le_bytes());
    out.extend_from_slice(&FLAG_NONE.to_le_bytes());
    out.push(stamp.bc as u8);
    out.push(endian_byte(stamp.endian));
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(&stamp.atom.to_le_bytes());
    debug_assert_eq!(out.len(), HEADER_LEN);
    out.extend_from_slice(bytecode);
    out
}

/// Parse and validate a blob against the engine that will run it.
pub fn parse<'a>(blob: &'a [u8], engine: &Stamp) -> Result<Snapshot<'a>, Error> {
    if blob.len() < HEADER_LEN {
        return Err(Error::Truncated);
    }
    if blob[..MAGIC.len()] != MAGIC {
        return Err(Error::NotASnapshot);
    }
    let format = u16::from_le_bytes([blob[9], blob[10]]);
    if format != FORMAT {
        return Err(Error::UnsupportedFormat(format));
    }
    let flags = u16::from_le_bytes([blob[11], blob[12]]);
    if flags != FLAG_NONE {
        return Err(Error::UnsupportedFlags(flags));
    }
    let bc_version = blob[13];
    let endian = byte_endian(blob[14]);
    let reserved = u16::from_le_bytes([blob[15], blob[16]]);
    if reserved != 0 {
        return Err(Error::UnsupportedFlags(reserved));
    }
    let len = u32::from_le_bytes([blob[17], blob[18], blob[19], blob[20]]) as usize;
    let atom = u32::from_le_bytes([blob[21], blob[22], blob[23], blob[24]]);
    let body = blob
        .get(HEADER_LEN..HEADER_LEN + len)
        .ok_or(Error::Truncated)?;

    if bc_version != engine.bc as u8 {
        return Err(Error::BytecodeVersion {
            snapshot: bc_version,
            engine: engine.bc as u8,
        });
    }
    if endian != engine.endian {
        return Err(Error::Endian {
            snapshot: endian,
            engine: engine.endian,
        });
    }
    if atom != engine.atom {
        return Err(Error::AtomTable {
            snapshot: atom,
            engine: engine.atom,
        });
    }

    Ok(Snapshot {
        bytecode: body,
        bc_version,
        endian,
        atom,
    })
}

fn endian_byte(endian: Endian) -> u8 {
    match endian {
        Endian::Little => 0,
        Endian::Big => 1,
    }
}

fn byte_endian(byte: u8) -> Endian {
    // Any value other than 1 is little: a byte order we do not know cannot silently pass the check
    // because `Endian` has only two values and the comparison below is what refuses a foreign one.
    if byte == 1 {
        Endian::Big
    } else {
        Endian::Little
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stamp(bc: u32, atom: u32, endian: Endian) -> Stamp {
        Stamp {
            format: 1,
            qjs: "0.17.0".to_owned(),
            bc,
            endian,
            atom,
        }
    }

    fn host_stamp() -> Stamp {
        stamp(28, 0x1234_5678, Endian::Little)
    }

    #[test]
    fn a_snapshot_round_trips() {
        let bytecode = b"\x01\x02\x03bytecode";
        let blob = encode(bytecode, &host_stamp());
        assert_eq!(blob.len(), HEADER_LEN + bytecode.len());
        let parsed = parse(&blob, &host_stamp()).expect("valid snapshot");
        assert_eq!(parsed.bytecode, bytecode);
        assert_eq!(parsed.bc_version, 28);
        assert_eq!(parsed.atom, 0x1234_5678);
    }

    #[test]
    fn a_short_blob_is_refused_before_any_read() {
        assert_eq!(parse(&[], &host_stamp()), Err(Error::Truncated));
        assert_eq!(parse(&[0u8; 10], &host_stamp()), Err(Error::Truncated));
    }

    #[test]
    fn a_length_past_the_end_is_refused() {
        let mut blob = encode(b"abc", &host_stamp());
        blob[17] = 200; // len low byte
        assert_eq!(parse(&blob, &host_stamp()), Err(Error::Truncated));
    }

    #[test]
    fn a_foreign_magic_is_refused() {
        let mut blob = encode(b"abc", &host_stamp());
        blob[0] = b'X';
        assert_eq!(parse(&blob, &host_stamp()), Err(Error::NotASnapshot));
    }

    #[test]
    fn a_different_bytecode_version_is_refused_with_both_numbers() {
        let blob = encode(b"abc", &stamp(27, 0x1234_5678, Endian::Little));
        match parse(&blob, &host_stamp()) {
            Err(Error::BytecodeVersion { snapshot, engine }) => {
                assert_eq!((snapshot, engine), (27, 28));
            }
            other => panic!("expected a version mismatch, got {other:?}"),
        }
    }

    #[test]
    fn a_different_atom_table_is_refused() {
        let blob = encode(b"abc", &stamp(28, 0xdead_beef, Endian::Little));
        assert!(matches!(
            parse(&blob, &host_stamp()),
            Err(Error::AtomTable { .. })
        ));
    }

    #[test]
    fn a_foreign_byte_order_is_refused() {
        let blob = encode(b"abc", &stamp(28, 0x1234_5678, Endian::Big));
        assert!(matches!(
            parse(&blob, &host_stamp()),
            Err(Error::Endian { .. })
        ));
    }

    #[test]
    fn an_unknown_format_or_flag_is_refused() {
        let mut blob = encode(b"abc", &host_stamp());
        blob[9] = 9;
        assert!(matches!(
            parse(&blob, &host_stamp()),
            Err(Error::UnsupportedFormat(9))
        ));

        let mut blob = encode(b"abc", &host_stamp());
        blob[11] = 1;
        assert!(matches!(
            parse(&blob, &host_stamp()),
            Err(Error::UnsupportedFlags(1))
        ));
    }
}
