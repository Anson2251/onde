//! Target tuples: the cell a build produces artifacts for.
//!
//! A tuple is Rust's spelling — `<arch>-<vendor>-<os>[-<env>]` — because that is what the user
//! already knows from `rustup` and `cargo --target`. It fixes exactly three things for this tool:
//!
//! 1. which archive to download (`libonde-<tuple>.a`, or `onde-<tuple>.lib` for MSVC);
//! 2. which extra libraries and flags the link needs;
//! 3. which compiler family's flag spelling applies (`gcc`, `clang`, `zig`, `msvc`).
//!
//! It does **not** choose a compiler. A non-host tuple with no `--cc` and no `CC_<tuple>` is an
//! error that names both, rather than a guess: a wrong guess produces a binary that fails at run
//! time on someone else's machine.

use std::fmt;

/// The libc / platform family a cell belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Libc {
    /// macOS: libSystem, Apple's linker.
    Darwin,
    /// Linux with glibc.
    Gnu,
    /// Linux with musl.
    Musl,
    /// Windows with the MSVC CRT.
    Msvc,
}

impl Libc {
    /// The `libc` field the engine's ABI stamp uses for this cell.
    pub fn endian(self) -> ln_abi::Endian {
        // Every v1 cell is little-endian; `Target::parse` rejects the big-endian architectures
        // before this is ever consulted, so the answer is not a guess.
        ln_abi::Endian::Little
    }
}

/// A supported build cell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    /// The full tuple, as the user typed it.
    pub tuple: String,
    /// `aarch64`, `x86_64`, …
    pub arch: String,
    /// `apple`, `unknown`, `pc`, …
    pub vendor: String,
    /// `darwin`, `linux`, `windows`.
    pub os: String,
    /// The environment / libc part of the tuple, if any (`gnu`, `musl`, `msvc`).
    pub env: Option<String>,
    /// The family the cell belongs to.
    pub libc: Libc,
}

impl Target {
    /// Parse a tuple and refuse the cells v1 does not build.
    ///
    /// The refusals are deliberate, not missing support: 32-bit targets (pointer width is an
    /// untested axis for QuickJS bytecode), big-endian targets (bytecode is written in the
    /// target's order, and no big-endian cell exists), and Windows GNU (a second Windows
    /// toolchain for no current user).
    pub fn parse(tuple: &str) -> Result<Target, String> {
        let parts: Vec<&str> = tuple.split('-').collect();
        if parts.len() < 3 {
            return Err(format!(
                "{tuple:?} is not a target tuple; expected <arch>-<vendor>-<os>[-<env>]"
            ));
        }
        let (arch, vendor, os) = (parts[0], parts[1], parts[2]);
        let env = parts.get(3).map(|env| (*env).to_owned());

        if arch == "i686" || arch == "i586" || arch == "armv7" || arch == "thumbv7" {
            return Err(format!(
                "{tuple}: 32-bit targets are not supported (QuickJS bytecode is untested at 32-bit \
                 pointer width)"
            ));
        }
        if matches!(
            arch,
            "s390x" | "powerpc" | "powerpc64" | "sparc" | "sparc64"
        ) {
            return Err(format!(
                "{tuple}: big-endian targets are not supported (no v1 cell writes big-endian \
                 bytecode)"
            ));
        }

        let libc = match (os, env.as_deref()) {
            ("darwin", _) => Libc::Darwin,
            ("linux", Some("musl")) => Libc::Musl,
            ("linux", _) => Libc::Gnu,
            ("windows", Some("msvc")) => Libc::Msvc,
            ("windows", Some("gnu")) => {
                return Err(format!(
                    "{tuple}: Windows GNU targets are not supported; use the MSVC cell"
                ))
            }
            (os, _) => return Err(format!("{tuple}: unsupported operating system {os:?}")),
        };

        Ok(Target {
            tuple: tuple.to_owned(),
            arch: arch.to_owned(),
            vendor: vendor.to_owned(),
            os: os.to_owned(),
            env,
            libc,
        })
    }

    /// The tuple of the machine this tool is running on.
    pub fn host() -> Result<Target, String> {
        let tuple = match (std::env::consts::OS, std::env::consts::ARCH) {
            ("macos", arch) => format!("{arch}-apple-darwin"),
            ("linux", arch) => {
                let env = if cfg!(target_env = "musl") {
                    "musl"
                } else {
                    "gnu"
                };
                format!("{arch}-unknown-linux-{env}")
            }
            ("windows", arch) => format!("{arch}-pc-windows-msvc"),
            (os, _) => return Err(format!("unsupported host operating system {os:?}")),
        };
        Target::parse(&tuple)
    }

    /// Is this the machine building the app?
    ///
    /// Used for exactly one decision: whether the default `cc` is allowed. Cross builds must name
    /// their compiler.
    pub fn is_host(&self) -> bool {
        Target::host()
            .map(|host| host.tuple == self.tuple)
            .unwrap_or(false)
    }

    /// The archive's file name for this cell.
    pub fn archive_name(&self) -> String {
        match self.libc {
            Libc::Msvc => format!("onde-{}.lib", self.tuple),
            _ => format!("libonde-{}.a", self.tuple),
        }
    }

    /// The executable suffix (MSVC needs `.exe`; `cc` adds it itself, but the tool has to know
    /// what file to strip and sign).
    pub fn exe_suffix(&self) -> &'static str {
        match self.libc {
            Libc::Msvc => ".exe",
            _ => "",
        }
    }

    /// Extra libraries the archive needs at link time, after the archive.
    ///
    /// This is what rustc reports for this dependency set with `--print native-static-libs`
    /// (see the design doc §2.3). They are cell facts, not user preferences; `--ldflags` is for
    /// anything else.
    pub fn link_libs(&self) -> &'static [&'static str] {
        match self.libc {
            // libSystem, libc and libm are implicit through the driver on macOS; only iconv has
            // to be named, and naming the others makes `ld` warn about duplicate libraries.
            Libc::Darwin => &["-liconv"],
            Libc::Gnu => &[
                "-lgcc_s",
                "-lutil",
                "-lrt",
                "-lpthread",
                "-lm",
                "-ldl",
                "-lc",
            ],
            // musl has thread, dl and math inside libc; the statically linked result is the point
            // of this cell.
            Libc::Musl => &["-lc"],
            Libc::Msvc => &["advapi32.lib", "userenv.lib", "ws2_32.lib", "ntdll.lib"],
        }
    }

    /// Linker flags the cell needs before `--ldflags`.
    pub fn link_flags(&self) -> &'static [&'static str] {
        match self.libc {
            Libc::Musl => &["-static"],
            _ => &[],
        }
    }

    /// The compiler family this cell defaults to.
    pub fn default_family(&self) -> Family {
        match self.libc {
            Libc::Darwin => Family::Clang,
            Libc::Gnu | Libc::Musl => Family::Gcc,
            Libc::Msvc => Family::Msvc,
        }
    }

    /// The name cargo's convention gives `CC` for this tuple.
    pub fn cc_env_var(&self) -> String {
        format!("CC_{}", self.tuple.replace('-', "_"))
    }

    /// Is the payload placed with a linker section, rather than a C array?
    pub fn supports_section(&self) -> bool {
        match self.libc {
            Libc::Darwin | Libc::Gnu | Libc::Musl => true,
            // COFF has no `.incbin`; `#pragma section` needs a different generated file and buys
            // nothing (MSVC keeps a `static const` array in `.rdata` anyway).
            Libc::Msvc => false,
        }
    }

    /// The libc family's name, for messages.
    pub fn libc_name(&self) -> &'static str {
        match self.libc {
            Libc::Darwin => "macOS",
            Libc::Gnu => "glibc",
            Libc::Musl => "musl",
            Libc::Msvc => "MSVC",
        }
    }

    /// The Mach-O section name for `--embed section`, if this is a Mach-O cell.
    pub fn is_macho(&self) -> bool {
        self.libc == Libc::Darwin
    }
}

impl fmt::Display for Target {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.tuple)
    }
}

/// A compiler family: the spelling of flags, not the program.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    /// gcc (or a driver that takes gcc's flags).
    Gcc,
    /// clang (Apple's or upstream).
    Clang,
    /// `zig cc`, which looks like clang to a version probe and is not.
    Zig,
    /// MSVC `cl`.
    Msvc,
}

impl Family {
    /// Parse `--cc-family`.
    pub fn parse(name: &str) -> Result<Family, String> {
        match name {
            "gcc" => Ok(Family::Gcc),
            "clang" => Ok(Family::Clang),
            "zig" => Ok(Family::Zig),
            "msvc" => Ok(Family::Msvc),
            other => Err(format!(
                "unknown --cc-family {other:?}; expected gcc, clang, zig or msvc"
            )),
        }
    }

    /// The family's flag spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Family::Gcc => "gcc",
            Family::Clang => "clang",
            Family::Zig => "zig",
            Family::Msvc => "msvc",
        }
    }

    /// `true` when flags are `/flag` rather than `-flag`.
    pub fn is_msvc(self) -> bool {
        self == Family::Msvc
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_v1_matrix() {
        for (tuple, libc, archive) in [
            (
                "aarch64-apple-darwin",
                Libc::Darwin,
                "libonde-aarch64-apple-darwin.a",
            ),
            (
                "x86_64-apple-darwin",
                Libc::Darwin,
                "libonde-x86_64-apple-darwin.a",
            ),
            (
                "x86_64-unknown-linux-gnu",
                Libc::Gnu,
                "libonde-x86_64-unknown-linux-gnu.a",
            ),
            (
                "aarch64-unknown-linux-musl",
                Libc::Musl,
                "libonde-aarch64-unknown-linux-musl.a",
            ),
            (
                "x86_64-pc-windows-msvc",
                Libc::Msvc,
                "onde-x86_64-pc-windows-msvc.lib",
            ),
        ] {
            let target = Target::parse(tuple).unwrap();
            assert_eq!(target.libc, libc, "{tuple}");
            assert_eq!(target.archive_name(), archive, "{tuple}");
        }
    }

    #[test]
    fn defaults_follow_the_cell() {
        assert_eq!(
            Target::parse("aarch64-apple-darwin")
                .unwrap()
                .default_family(),
            Family::Clang
        );
        assert_eq!(
            Target::parse("x86_64-unknown-linux-gnu")
                .unwrap()
                .default_family(),
            Family::Gcc
        );
        assert_eq!(
            Target::parse("x86_64-pc-windows-msvc")
                .unwrap()
                .default_family(),
            Family::Msvc
        );
        assert_eq!(
            Target::parse("aarch64-apple-darwin").unwrap().cc_env_var(),
            "CC_aarch64_apple_darwin"
        );
    }

    #[test]
    fn refuses_the_cells_v1_does_not_build() {
        for tuple in [
            "i686-unknown-linux-gnu",
            "s390x-unknown-linux-gnu",
            "x86_64-pc-windows-gnu",
            "wasm32-unknown-unknown",
        ] {
            assert!(
                Target::parse(tuple).is_err(),
                "{tuple} must be refused, not half-supported"
            );
        }
    }

    #[test]
    fn section_embedding_is_a_macho_or_elf_feature() {
        assert!(Target::parse("aarch64-apple-darwin")
            .unwrap()
            .supports_section());
        assert!(Target::parse("x86_64-unknown-linux-gnu")
            .unwrap()
            .supports_section());
        assert!(!Target::parse("x86_64-pc-windows-msvc")
            .unwrap()
            .supports_section());
    }

    #[test]
    fn the_host_parses() {
        let host = Target::host().expect("a supported host");
        assert!(!host.tuple.is_empty());
        assert!(host.is_host());
    }
}
