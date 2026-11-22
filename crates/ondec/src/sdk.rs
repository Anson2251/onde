//! Finding the SDK: `onde.h` plus one archive per cell.
//!
//! The SDK is two files. `--sdk <dir>` uses an unpacked directory as-is; otherwise the tool looks
//! in a per-version, per-cell cache, downloads from the release URL if it is missing, verifies the
//! SHA-256 from `SHA256SUMS`, and finally checks the archive's **ABI stamp** against the engine
//! linked into this tool. That last check is the one that matters: `ondec` compiles the bytecode,
//! so the archive has to be the same engine, and a stale download is otherwise a mysterious crash
//! at run time.
//!
//! # Why the stamp and not a manifest
//!
//! The stamp is a byte string in the archive's `.rodata` (`ONDE-ABI:1;qjs=…;bc=28;…;`). Scanning
//! for it needs no linker, no symbol table, no disassembler and no knowledge of the target
//! architecture, which is what lets one host tool verify a cross archive. `SHA256SUMS` protects
//! the download in transit; the stamp proves the bytes are the *right* engine.
//!
//! # Downloading
//!
//! HTTPS GETs are delegated to `curl` (`-fsSL`), the same way this repository's `wasi-sdk` build
//! step does. That keeps a TLS stack and an HTTP client out of a build tool whose job is
//! bytecode and `cc`, and `curl` is present on macOS, most Linux distributions, and Windows 10
//! and later. `--sdk <dir>` and a warm cache need no network at all.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use ln_abi::{Stamp, PREFIX};
use sha2::{Digest, Sha256};

/// The release URL root, before `/v<version>`.
pub const DEFAULT_SDK_BASE_URL: &str = "https://github.com/Anson2251/onde/releases/download";

/// Every cell in the v1 matrix, in the order the docs list them.
pub const CELLS: [&str; 8] = [
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "aarch64-unknown-linux-gnu",
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-musl",
    "x86_64-unknown-linux-musl",
    "x86_64-pc-windows-msvc",
    "aarch64-pc-windows-msvc",
];

/// An unpacked, verified SDK.
#[derive(Debug, Clone)]
pub struct Sdk {
    /// The directory holding the two files.
    pub dir: PathBuf,
    /// `libonde-<tuple>.a` (or `onde-<tuple>.lib`).
    pub archive: PathBuf,
    /// The engine identity the archive carries.
    pub stamp: Stamp,
}

/// Where to look and whether downloading is allowed.
#[derive(Debug, Clone)]
pub struct Options {
    /// `--sdk`: an unpacked directory, used as-is.
    pub dir: Option<PathBuf>,
    /// `--sdk-version`; defaults to this tool's version.
    pub version: String,
    /// `--no-fetch`: fail on a cache miss instead of downloading.
    pub no_fetch: bool,
    /// `--sdk-base-url`, `ONDE_SDK_BASE_URL`, or the release default.
    pub base_url: Option<String>,
}

/// Resolve, and if needed download, the SDK for `target`.
pub fn resolve(target: &crate::target::Target, options: &Options) -> Result<Sdk, String> {
    let dir = match &options.dir {
        Some(dir) => {
            if !dir.is_dir() {
                return Err(format!("--sdk {} is not a directory", dir.display()));
            }
            dir.clone()
        }
        None => {
            let dir = cache_dir(&options.version, target)?;
            if !is_populated(&dir) {
                if options.no_fetch {
                    return Err(format!(
                        "no SDK for {} in the cache ({}) and --no-fetch was given\n  \
                         run `ondec sdk install --target {}` on a machine with network access, or \
                         pass --sdk <dir>",
                        target,
                        dir.display(),
                        target
                    ));
                }
                download(&dir, target, options)?;
            }
            dir
        }
    };

    verify(&dir, target)
}

/// Check an unpacked SDK directory and read its engine identity.
pub fn verify(dir: &Path, target: &crate::target::Target) -> Result<Sdk, String> {
    let header = dir.join("onde.h");
    let archive = dir.join(target.archive_name());

    if !header.is_file() {
        return Err(format!("{} is missing onde.h", dir.display()));
    }
    if !archive.is_file() {
        return Err(format!(
            "{} is missing {} (is this SDK for another target?)",
            dir.display(),
            target.archive_name()
        ));
    }

    let bytes =
        fs::read(&archive).map_err(|error| format!("read {}: {error}", archive.display()))?;
    let stamp = scan_stamp(&bytes).ok_or_else(|| {
        format!(
            "{} carries no ABI stamp: not an onde archive, or from a build older than the stamp",
            archive.display()
        )
    })?;

    let engine = ln_engine::engine_stamp_parsed();
    if let Err(mismatch) = engine.check(&stamp) {
        return Err(format!(
            "the SDK archive was built for a different engine, so its bytecode would be unreadable\n  \
             ondec:  {}\n  \
             archive: {}\n  \
             difference: {mismatch}",
            engine.encode(),
            stamp.encode()
        ));
    }
    for warning in engine.warnings(&stamp) {
        eprintln!("ondec: warning: {warning}");
    }

    Ok(Sdk {
        dir: dir.to_path_buf(),
        archive,
        stamp,
    })
}

/// Find the engine identity inside an archive.
///
/// An archive of thin-LTO bitcode still carries the bytes literally (verified), so this is a scan
/// for the prefix followed by a short window parsed by `ln-abi`. It works on any architecture and
/// any object format.
pub fn scan_stamp(bytes: &[u8]) -> Option<Stamp> {
    const WINDOW: usize = 256;
    let needle = PREFIX.as_bytes();
    let mut offset = 0;
    while offset + needle.len() <= bytes.len() {
        let found = find(&bytes[offset..], needle)?;
        let start = offset + found;
        let end = (start + WINDOW).min(bytes.len());
        let window = String::from_utf8_lossy(&bytes[start..end]);
        if let Some(stamp) = Stamp::parse(&window) {
            return Some(stamp);
        }
        offset = start + needle.len();
    }
    None
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// `$ONDE_SDK_CACHE`, else `$XDG_CACHE_HOME/onde/sdk`, else `~/.cache/onde/sdk`.
pub fn cache_root() -> PathBuf {
    if let Some(dir) = env::var_os("ONDE_SDK_CACHE") {
        return PathBuf::from(dir);
    }
    if let Some(dir) = env::var_os("XDG_CACHE_HOME") {
        return PathBuf::from(dir).join("onde").join("sdk");
    }
    if let Some(home) = env::var_os("HOME") {
        return PathBuf::from(home).join(".cache").join("onde").join("sdk");
    }
    env::temp_dir().join("onde").join("sdk")
}

/// `$CACHE/<version>/<tuple>`.
pub fn cache_dir(version: &str, target: &crate::target::Target) -> Result<PathBuf, String> {
    Ok(cache_root().join(version).join(&target.tuple))
}

fn is_populated(dir: &Path) -> bool {
    dir.join("onde.h").is_file()
}

fn base_url(options: &Options, version: &str) -> String {
    let root = options
        .base_url
        .clone()
        .or_else(|| env::var("ONDE_SDK_BASE_URL").ok())
        .unwrap_or_else(|| DEFAULT_SDK_BASE_URL.to_owned());
    format!("{}/v{version}", root.trim_end_matches('/'))
}

fn download(dir: &Path, target: &crate::target::Target, options: &Options) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|error| format!("create {}: {error}", dir.display()))?;
    let url = base_url(options, &options.version);

    fetch(&format!("{url}/onde.h"), &dir.join("onde.h"))?;
    fetch(
        &format!("{url}/{}", target.archive_name()),
        &dir.join(target.archive_name()),
    )?;

    // The checksum file is release metadata, not part of the SDK; verify when it is available and
    // refuse a mismatch. A release without it still has the ABI stamp check below.
    let sums_path = dir.join("SHA256SUMS");
    match fetch(&format!("{url}/SHA256SUMS"), &sums_path) {
        Ok(()) => verify_checksum(&sums_path, dir, target)?,
        Err(error) => eprintln!("ondec: warning: no SHA256SUMS to verify the download ({error})"),
    }
    Ok(())
}

fn fetch(url: &str, destination: &Path) -> Result<(), String> {
    let status = std::process::Command::new("curl")
        .args(["-fsSL", "--retry", "2", "-o"])
        .arg(destination)
        .arg(url)
        .status()
        .map_err(|error| {
            format!(
                "cannot run curl to download the SDK: {error}\n  \
                 install curl, pass --sdk <dir>, or pre-stage the cache with `ondec sdk install`"
            )
        })?;
    if !status.success() {
        return Err(format!("download failed ({status}): {url}"));
    }
    Ok(())
}

fn verify_checksum(sums: &Path, dir: &Path, target: &crate::target::Target) -> Result<(), String> {
    let text =
        fs::read_to_string(sums).map_err(|error| format!("read {}: {error}", sums.display()))?;
    for name in ["onde.h", target.archive_name().as_str()] {
        let expected = text
            .lines()
            .find_map(|line| {
                let (hash, file) = line.split_once(char::is_whitespace)?;
                (file.trim_start_matches('*') == name).then(|| hash.to_lowercase())
            })
            .ok_or_else(|| format!("SHA256SUMS has no entry for {name}"))?;
        let actual = sha256(&dir.join(name))?;
        if actual != expected {
            return Err(format!(
                "{name} does not match SHA256SUMS\n  expected {expected}\n  actual   {actual}"
            ));
        }
    }
    Ok(())
}

/// The SHA-256 of a file, lowercase hex.
pub fn sha256(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| format!("read {}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    Ok(hex)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_a_stamp_out_of_binary_bytes() {
        let stamp = ln_engine::engine_stamp_parsed();
        let mut archive = b"\x7fELF\x02\x01\x01\x00binary junk".to_vec();
        archive.extend_from_slice(stamp.encode().as_bytes());
        archive.extend_from_slice(&[0u8, 1, 2, 3, 0xff]);
        assert_eq!(scan_stamp(&archive), Some(stamp));
        assert_eq!(scan_stamp(b"no stamp in here"), None);
    }

    #[test]
    fn rejects_a_stamp_from_another_engine() {
        let mut other = ln_engine::engine_stamp_parsed();
        other.bc = 99;
        let mut archive = Vec::new();
        archive.extend_from_slice(other.encode().as_bytes());
        let scanned = scan_stamp(&archive).expect("a stamp is found");
        assert!(ln_engine::engine_stamp_parsed().check(&scanned).is_err());
    }

    #[test]
    fn the_cache_layout_is_version_then_cell() {
        let dir = cache_dir(
            "9.9.9",
            &crate::target::Target::parse("aarch64-apple-darwin").unwrap(),
        )
        .unwrap();
        assert!(
            dir.ends_with("9.9.9/aarch64-apple-darwin"),
            "{}",
            dir.display()
        );
    }

    #[test]
    fn a_missing_sdk_names_the_file_and_the_target() {
        let dir = std::env::temp_dir().join("ondec-sdk-test-empty");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("onde.h"), b"/* header */").unwrap();
        let target = crate::target::Target::parse("aarch64-apple-darwin").unwrap();
        let error = verify(&dir, &target).unwrap_err();
        assert!(error.contains("libonde-aarch64-apple-darwin.a"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
