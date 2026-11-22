//! The engine ABI stamp.
//!
//! QuickJS module bytecode is not a portable file format: it embeds the engine's atom indices,
//! the serialization version and the host endianness. Two builds of the same source agree on all
//! three; two different builds may not. Loading bytecode produced by another engine is not a
//! recoverable error — the engine trusts the stream — so the build tool and the runtime must be
//! able to prove they are the same engine *before* the first `JS_ReadObject`.
//!
//! The stamp is that proof, and it has exactly one representation:
//!
//! ```text
//! ONDE-ABI:1;qjs=0.17.0;bc=28;endian=le;atom=3f9a1c02;
//! ```
//!
//! `format` is the C ABI version (`ONDE_ABI_VERSION` in `onde.h`) and changes only for a breaking
//! C ABI change. The remaining fields are facts about the engine build:
//!
//! - `qjs` — the quickjs-ng version the archive was compiled from (`QJS_VERSION_*`).
//! - `bc` — `BC_VERSION` in `quickjs.c`: the bytecode serialization format.
//! - `endian` — `le` or `be`; QuickJS writes bytecode in native order unless asked to swap.
//! - `atom` — a hash of `quickjs-atom.h`: the atom table's *order* is the contract, since
//!   bytecode refers to atoms by index.
//!
//! The stamp is an **identity**, never an integrity check. It says "this archive and this payload
//! come from the same engine", not "this payload is unmodified" — the payload is inside the
//! executable, and the executable's signature is that boundary.
//!
//! # Where it lives
//!
//! One string, three carriers:
//!
//! - `ln-engine` bakes [`Stamp::host`] into its own binary at build time (`build.rs` →
//!   `OUT_DIR/abi_stamp.rs`), so [`ln_engine::engine_stamp`] always describes the linked engine.
//! - `ln-embed` writes it into the archive as a `#[used]` static (the bytes survive `ar`/`ld`,
//!   including under fat LTO), so `ondec` can find it by scanning the archive.
//! - the payload header repeats `bc`, `endian` and `atom` (not `qjs`), so the runtime can refuse a
//!   payload built for another engine even when the SDK was correct at build time.
//!
//! The hash is deliberately **not** a cryptographic digest: it must be computable identically by
//! every build toolchain, with no dependencies, and a collision between two atom tables that both
//! belong to this repository is not a threat model. FNV-1a over the header bytes is enough to
//! catch the case that matters — a stale archive.

use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

/// The C ABI version, mirrored by `ONDE_ABI_VERSION` in `onde.h`.
pub const FORMAT: u32 = 1;

/// Every stamp starts with this prefix, so an archive scan is one `memmem`.
pub const PREFIX: &str = "ONDE-ABI:";

/// Path of the vendored engine sources, relative to [`vendored_engine_dir`].
pub const VENDORED_ENGINE: &str = "../../vendor/rquickjs-sys/quickjs";

/// Byte order of the engine's bytecode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Endian {
    Little,
    Big,
}

impl Endian {
    /// The two-letter spelling used in the stamp.
    pub fn as_str(self) -> &'static str {
        match self {
            Endian::Little => "le",
            Endian::Big => "be",
        }
    }

    /// The byte order of the machine this crate was compiled for.
    pub fn host() -> Endian {
        if cfg!(target_endian = "big") {
            Endian::Big
        } else {
            Endian::Little
        }
    }
}

impl fmt::Display for Endian {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The identity of one engine build.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stamp {
    /// C ABI version.
    pub format: u32,
    /// quickjs-ng version, `MAJOR.MINOR.PATCH[-SUFFIX]`.
    pub qjs: String,
    /// `BC_VERSION` from `quickjs.c`.
    pub bc: u32,
    /// Byte order the bytecode is written in.
    pub endian: Endian,
    /// FNV-1a of `quickjs-atom.h`.
    pub atom: u32,
}

impl Stamp {
    /// Read the identity out of an engine source tree (`quickjs.c`, `quickjs.h`,
    /// `quickjs-atom.h`).
    pub fn read(dir: &Path) -> Result<Stamp, Error> {
        let quickjs_c = read_file(&dir.join("quickjs.c"))?;
        let quickjs_h = read_file(&dir.join("quickjs.h"))?;
        let atom_h = read_file(&dir.join("quickjs-atom.h"))?;

        let bc = parse_define_u32(&quickjs_c, "BC_VERSION")?;
        let qjs = parse_qjs_version(&quickjs_h)?;
        let atom = fnv1a(atom_h.as_bytes());

        Ok(Stamp {
            format: FORMAT,
            qjs,
            bc,
            endian: Endian::host(),
            atom,
        })
    }

    /// The identity of the engine linked into *this* program.
    ///
    /// Only meaningful for builds that link `ln-engine`; the tool that compiled this crate may
    /// have targeted another machine, in which case use [`Stamp::for_target`] instead.
    pub fn host() -> Result<Stamp, Error> {
        Stamp::read(&vendored_engine_dir())
    }

    /// The identity of the engine for `tuple`.
    ///
    /// The atom table and `BC_VERSION` are target-independent; only the byte order differs, and
    /// every cell in the v1 matrix is little-endian. An unknown tuple is treated as little-endian
    /// and the caller is expected to reject big-endian targets explicitly.
    pub fn for_target(tuple: &str) -> Result<Stamp, Error> {
        let mut stamp = Stamp::host()?;
        stamp.endian = endian_for_tuple(tuple);
        Ok(stamp)
    }

    /// `ONDE-ABI:1;qjs=0.17.0;bc=28;endian=le;atom=3f9a1c02;`
    pub fn encode(&self) -> String {
        format!(
            "{PREFIX}{};qjs={};bc={};endian={};atom={:08x};",
            self.format,
            self.qjs,
            self.bc,
            self.endian.as_str(),
            self.atom
        )
    }

    /// Parse a stamp out of a byte string, anywhere inside it.
    ///
    /// The archive scan hands over a window of the file, not a line, so the search is `memmem`-ish
    /// and the parse stops at the terminating `;`. Unknown keys are ignored (a newer archive can
    /// add one without breaking an older tool); a missing known key is a parse failure.
    pub fn parse(text: &str) -> Option<Stamp> {
        let start = text.find(PREFIX)? + PREFIX.len();
        let (head, rest) = text[start..].split_once(';')?;
        let format = head.parse::<u32>().ok()?;

        let mut qjs = None;
        let mut bc = None;
        let mut endian = None;
        let mut atom = None;

        // Fields are `key=value;`, and the stamp ends at the last field's `;` — so a slice of a
        // larger file (the next member's bytes, which need not be text) cannot be mistaken for
        // more fields. A field without `=` ends the stamp rather than failing the parse.
        for field in rest.split(';') {
            let Some((key, value)) = field.split_once('=') else {
                break;
            };
            match key {
                "qjs" => qjs = Some(value.to_owned()),
                "bc" => bc = Some(value.parse::<u32>().ok()?),
                "endian" => {
                    endian = Some(match value {
                        "le" => Endian::Little,
                        "be" => Endian::Big,
                        _ => return None,
                    })
                }
                "atom" => atom = Some(u32::from_str_radix(value, 16).ok()?),
                _ => {}
            }
        }

        // The format is the only field before the first `;`.
        Some(Stamp {
            format,
            qjs: qjs?,
            bc: bc?,
            endian: endian?,
            atom: atom?,
        })
    }

    /// One human line, for `ondec sdk verify` and mismatch reports.
    pub fn summary(&self) -> String {
        format!(
            "quickjs-ng {}, bytecode {}, {}-endian, atoms {:08x}",
            self.qjs,
            self.bc,
            self.endian.as_str(),
            self.atom
        )
    }

    /// Are these two stamps the same engine?
    ///
    /// The fields that make bytecode unsafe to share are `format` (the C ABI), `bc`, `endian` and
    /// `atom`; a difference in any of them is a hard mismatch. The quickjs-ng version is reported
    /// separately by [`Stamp::warnings`], because two patch releases with an unchanged bytecode
    /// format and atom table are interchangeable.
    pub fn check(&self, other: &Stamp) -> Result<(), Mismatch> {
        let mut differences = Vec::new();
        if self.format != other.format {
            differences.push(format!(
                "C ABI version {} (here) vs {} (SDK)",
                self.format, other.format
            ));
        }
        if self.bc != other.bc {
            differences.push(format!("bytecode version {} vs {}", self.bc, other.bc));
        }
        if self.endian != other.endian {
            differences.push(format!("endianness {} vs {}", self.endian, other.endian));
        }
        if self.atom != other.atom {
            differences.push(format!(
                "atom table {:08x} vs {:08x}",
                self.atom, other.atom
            ));
        }
        if differences.is_empty() {
            Ok(())
        } else {
            Err(Mismatch { differences })
        }
    }

    /// Differences that do not make bytecode unsafe, for a note in the build log.
    ///
    /// Only the quickjs-ng version lands here today: a patch release that left the atom table and
    /// `BC_VERSION` alone is compatible, but the build should still say which engine it used.
    pub fn warnings(&self, other: &Stamp) -> Vec<String> {
        if self.qjs == other.qjs {
            return Vec::new();
        }
        vec![format!(
            "built against quickjs-ng {} but the SDK carries {}; compatible, since bytecode \
             version and atom table agree",
            self.qjs, other.qjs
        )]
    }
}

impl fmt::Display for Stamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.encode())
    }
}

/// Why a stamp could not be read or parsed.
#[derive(Debug)]
pub struct Error(pub String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

/// Why two stamps disagree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mismatch {
    /// One line per differing field, in a stable order.
    pub differences: Vec<String>,
}

impl fmt::Display for Mismatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.differences.join("; "))
    }
}

impl std::error::Error for Mismatch {}

/// The vendored quickjs-ng sources this workspace builds.
///
/// `ONDE_QUICKJS_DIR` overrides it, which is what a release job uses when it builds the engine
/// from a checkout other than this one.
pub fn vendored_engine_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("ONDE_QUICKJS_DIR") {
        return PathBuf::from(dir);
    }
    Path::new(env!("CARGO_MANIFEST_DIR")).join(VENDORED_ENGINE)
}

/// Byte order for a Rust target tuple.
///
/// v1 has no big-endian cells; this exists so the tool can say "unsupported" instead of writing
/// bytecode the target cannot read.
pub fn endian_for_tuple(tuple: &str) -> Endian {
    const BIG: [&str; 6] = ["s390x", "powerpc", "powerpc64", "sparc", "sparc64", "mips-"];
    if BIG.iter().any(|arch| tuple.starts_with(arch)) {
        Endian::Big
    } else {
        Endian::Little
    }
}

/// FNV-1a, 32-bit. Stable across toolchains by construction: no maps, no seeds, no platform
/// dependence.
pub fn fnv1a(bytes: &[u8]) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in bytes {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

fn read_file(path: &Path) -> Result<String, Error> {
    fs::read_to_string(path).map_err(|error| Error(format!("read {}: {error}", path.display())))
}

/// `#define NAME 28`, with the value on the same line.
fn parse_define_u32(source: &str, name: &str) -> Result<u32, Error> {
    let needle = format!("#define {name} ");
    for line in source.lines() {
        let line = line.trim_start();
        if let Some(rest) = line.strip_prefix(&needle) {
            let value = rest
                .split(|c: char| c.is_whitespace() || c == ')' || c == ',')
                .next()
                .unwrap_or_default();
            return value.parse::<u32>().map_err(|_| {
                Error(format!(
                    "{name} is not a decimal integer: {:?}",
                    rest.trim()
                ))
            });
        }
    }
    Err(Error(format!("{name} not found")))
}

/// `QJS_VERSION_MAJOR`/`MINOR`/`PATCH`/`SUFFIX` → `0.17.0`.
fn parse_qjs_version(quickjs_h: &str) -> Result<String, Error> {
    let major = parse_define_u32(quickjs_h, "QJS_VERSION_MAJOR")?;
    let minor = parse_define_u32(quickjs_h, "QJS_VERSION_MINOR")?;
    let patch = parse_define_u32(quickjs_h, "QJS_VERSION_PATCH")?;
    let suffix = quickjs_h
        .lines()
        .find_map(|line| {
            line.trim_start()
                .strip_prefix("#define QJS_VERSION_SUFFIX ")
                .map(|rest| rest.trim().trim_matches('"'))
        })
        .unwrap_or_default();
    Ok(format!("{major}.{minor}.{patch}{suffix}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Stamp {
        Stamp {
            format: 1,
            qjs: "0.17.0".to_owned(),
            bc: 28,
            endian: Endian::Little,
            atom: 0x3f9a_1c02,
        }
    }

    #[test]
    fn round_trips_through_the_wire_form() {
        let stamp = sample();
        let text = stamp.encode();
        assert_eq!(text, "ONDE-ABI:1;qjs=0.17.0;bc=28;endian=le;atom=3f9a1c02;");
        assert_eq!(Stamp::parse(&text), Some(stamp));
    }

    #[test]
    fn parses_out_of_a_larger_buffer() {
        let mut archive = b"\x7fELF junk \x00\x01".to_vec();
        archive.extend_from_slice(sample().encode().as_bytes());
        archive.extend_from_slice(b"\x00more archive bytes");
        let text = String::from_utf8_lossy(&archive);
        assert_eq!(Stamp::parse(&text), Some(sample()));
    }

    #[test]
    fn ignores_unknown_fields_for_forward_compatibility() {
        let text = "ONDE-ABI:1;qjs=0.17.0;bc=28;endian=le;atom=3f9a1c02;future=x;";
        assert_eq!(Stamp::parse(text), Some(sample()));
    }

    #[test]
    fn rejects_partial_or_garbled_stamps() {
        assert_eq!(Stamp::parse("no stamp here"), None);
        assert_eq!(Stamp::parse("ONDE-ABI:1;qjs=0.17.0;bc=28;"), None);
        assert_eq!(
            Stamp::parse("ONDE-ABI:1;qjs=0.17.0;bc=lots;endian=le;atom=3f9a1c02;"),
            None
        );
        assert_eq!(
            Stamp::parse("ONDE-ABI:1;qjs=0.17.0;bc=28;endian=le;atom=zzzz;"),
            None
        );
    }

    #[test]
    fn check_names_every_difference() {
        let mut other = sample();
        other.bc = 29;
        other.atom = 0x1111_2222;
        let mismatch = sample().check(&other).expect_err("stamps differ");
        assert_eq!(
            mismatch.differences,
            vec![
                "bytecode version 28 vs 29".to_owned(),
                "atom table 3f9a1c02 vs 11112222".to_owned(),
            ]
        );
        assert_eq!(
            mismatch.to_string(),
            "bytecode version 28 vs 29; atom table 3f9a1c02 vs 11112222"
        );
    }

    #[test]
    fn a_quickjs_patch_release_is_a_warning_not_a_mismatch() {
        let mut other = sample();
        other.qjs = "0.17.1".to_owned();
        assert_eq!(sample().check(&other), Ok(()));
        let warnings = sample().warnings(&other);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("0.17.0"));
        assert!(warnings[0].contains("0.17.1"));
        assert!(sample().warnings(&sample()).is_empty());
    }

    #[test]
    fn reads_the_vendored_engine() {
        let stamp = Stamp::host().expect("vendored engine is readable");
        assert_eq!(stamp.format, FORMAT);
        assert_eq!(stamp.bc, 28);
        assert_eq!(stamp.qjs, "0.17.0");
        assert_eq!(stamp.endian, Endian::host());
        assert_ne!(stamp.atom, 0);
        // Same input, same stamp: the hash has no seed.
        assert_eq!(Stamp::host().unwrap(), stamp);
        // And the canonical encoding round-trips.
        assert_eq!(Stamp::parse(&stamp.encode()), Some(stamp));
    }

    #[test]
    fn the_documented_example_is_the_real_stamp() {
        let stamp = Stamp::host().unwrap();
        let text = stamp.encode();
        assert!(text.starts_with("ONDE-ABI:1;qjs=0.17.0;bc=28;endian=le;atom="));
        assert!(text.ends_with(';'));
    }

    #[test]
    fn endianness_is_derived_from_the_tuple() {
        assert_eq!(endian_for_tuple("aarch64-apple-darwin"), Endian::Little);
        assert_eq!(
            endian_for_tuple("x86_64-unknown-linux-musl"),
            Endian::Little
        );
        assert_eq!(endian_for_tuple("s390x-unknown-linux-gnu"), Endian::Big);
        assert_eq!(
            endian_for_tuple("powerpc64le-unknown-linux-gnu"),
            Endian::Big,
            "the conservative answer for an untested architecture"
        );
    }

    #[test]
    fn fnv1a_matches_its_reference_values() {
        assert_eq!(fnv1a(b""), 0x811c_9dc5);
        assert_eq!(fnv1a(b"a"), 0xe40c_292c);
        assert_eq!(fnv1a(b"foobar"), 0xbf9c_f968);
    }
}
