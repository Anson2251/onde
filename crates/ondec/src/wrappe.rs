//! The wrappe backend: a self-extracting executable, no C toolchain.
//!
//! `wrappe` appends a zstd-compressed payload to a prebuilt runner image and unpacks it at run
//! time. It is the cheap answer to "I need *a* binary and I do not have a compiler": no SDK, no
//! `cc`, no payload format, and it works on every cell wrappe ships a runner for.
//!
//! It is not the default, and it is not a replacement for the linked backend:
//!
//! - the app is **parsed at every start** (no bytecode), so startup is the bundler's source
//!   parse, not a bytecode load;
//! - it **extracts to disk** (temp, local or cwd) and spawns `lite`, so there is a directory to
//!   clean up and a child process to reason about;
//! - the appended payload is **outside the signed code**. On macOS, re-signing an appended binary
//!   does not seal the appended bytes (verified: `codesign --verify` passes and `spctl` rejects
//!   it), so a wrappe build is a development artifact or an unsigned distribution, not a
//!   notarizable app.
//!
//! The staging step is still this tool's: the same bundled modules, placed at their payload keys
//! so their relative imports keep working, plus the runtime binary and any `--asset` copies.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use crate::build_cmd::Request;
use crate::frontend::Chunk;
use crate::target::Target;
use crate::toolchain::Toolchain;

/// Wrappe-specific options.
#[derive(Debug, Clone)]
pub struct Options {
    /// `--wrappe`: the packer command.
    pub program: String,
    /// `--runtime`: the `lite` binary to embed.
    pub runtime: Option<PathBuf>,
    /// `--asset`: files or directories to copy into the payload.
    pub assets: Vec<PathBuf>,
    /// `--unpack-target`.
    pub unpack: Unpack,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            program: "wrappe".to_owned(),
            runtime: None,
            assets: Vec::new(),
            unpack: Unpack::Temp,
        }
    }
}

/// Where wrappe unpacks the payload before running it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unpack {
    /// The system temp directory (wrappe's default).
    Temp,
    /// Next to the executable.
    Local,
    /// The current directory.
    Cwd,
}

impl Unpack {
    /// Parse `--unpack-target`.
    pub fn parse(name: &str) -> Result<Unpack, String> {
        match name {
            "temp" => Ok(Unpack::Temp),
            "local" => Ok(Unpack::Local),
            "cwd" => Ok(Unpack::Cwd),
            other => Err(format!(
                "unknown --unpack-target {other:?}; expected temp, local or cwd"
            )),
        }
    }
}

/// Stage the app and run wrappe.
pub fn pack(
    request: &Request,
    target: &Target,
    output: &Path,
    chunks: &[Chunk],
    maps: &[(String, String)],
    started: Instant,
) -> Result<(), String> {
    let stage = tempfile::Builder::new()
        .prefix("ondec-wrappe-")
        .tempdir()
        .map_err(|error| format!("cannot create a staging directory: {error}"))?;

    // Modules keep their keys: their imports are relative paths, and moving a chunk would break
    // every `../chunks/x.js` that points at it.
    for chunk in chunks {
        let path = stage.path().join(&chunk.key);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("create {}: {error}", parent.display()))?;
        }
        fs::write(&path, &chunk.code)
            .map_err(|error| format!("write {}: {error}", path.display()))?;
    }
    for (key, map) in maps {
        let path = stage.path().join(key);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("create {}: {error}", parent.display()))?;
        }
        fs::write(&path, map).map_err(|error| format!("write {}: {error}", path.display()))?;
    }

    let runtime = runtime_path(request, target)?;
    let runtime_name = if target.libc == crate::target::Libc::Msvc {
        "lite.exe"
    } else {
        "lite"
    };
    fs::copy(&runtime, stage.path().join(runtime_name))
        .map_err(|error| format!("copy {}: {error}", runtime.display()))?;

    for asset in &request.wrappe.assets {
        copy_asset(asset, stage.path())?;
    }

    let entry_key = chunks
        .iter()
        .find(|chunk| chunk.is_entry)
        .map(|chunk| chunk.key.clone())
        .ok_or_else(|| "the bundle has no entry chunk".to_owned())?;

    let command = vec![
        request.wrappe.program.clone(),
        "--input".to_owned(),
        stage.path().display().to_string(),
        "--runner".to_owned(),
        target.tuple.clone(),
        "--unpack-target".to_owned(),
        match request.wrappe.unpack {
            Unpack::Temp => "temp",
            Unpack::Local => "local",
            Unpack::Cwd => "cwd",
        }
        .to_owned(),
        "-o".to_owned(),
        output.display().to_string(),
        runtime_name.to_owned(),
        entry_key,
    ];
    if request.print_command {
        println!("{}", Toolchain::render(&command));
        return Ok(());
    }
    if request.verbose {
        eprintln!("ondec: wrappe: {}", Toolchain::render(&command));
    }

    let (program, args) = command.split_first().expect("a non-empty command");
    let status = std::process::Command::new(program)
        .args(args)
        .status()
        .map_err(|error| {
            format!(
                "cannot run {}: {error}\n  install wrappe, or pass --wrappe <path>; the linked \
                 backend (--packager link) needs no extra tool",
                request.wrappe.program
            )
        })?;
    if !status.success() {
        return Err(format!("wrappe failed ({status})"));
    }

    let size = fs::metadata(output)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    println!(
        "ondec: built {} ({}, wrappe) — {} module(s), {} executable, {:.1}s",
        output.display(),
        target,
        chunks.len(),
        crate::build_cmd::human(size as usize),
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

/// The runtime binary to embed: `--runtime`, else a `lite-<tuple>` next to this tool.
fn runtime_path(request: &Request, target: &Target) -> Result<PathBuf, String> {
    if let Some(runtime) = &request.wrappe.runtime {
        if !runtime.is_file() {
            return Err(format!("--runtime {} is not a file", runtime.display()));
        }
        return Ok(runtime.clone());
    }
    let name = if target.libc == crate::target::Libc::Msvc {
        format!("lite-{}.exe", target.tuple)
    } else {
        format!("lite-{}", target.tuple)
    };
    let beside = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .map(|dir| dir.join(&name));
    match beside {
        Some(path) if path.is_file() => Ok(path),
        _ => Err(format!(
            "no runtime for {}: pass --runtime <path> to a {} binary, or publish it next to ondec \
             as {name}",
            target, name
        )),
    }
}

fn copy_asset(asset: &Path, stage: &Path) -> Result<(), String> {
    let name = asset
        .file_name()
        .ok_or_else(|| format!("{} has no file name", asset.display()))?;
    let destination = stage.join(name);
    if asset.is_dir() {
        copy_directory(asset, &destination)
    } else {
        fs::copy(asset, &destination)
            .map(|_| ())
            .map_err(|error| format!("copy {}: {error}", asset.display()))
    }
}

fn copy_directory(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|error| format!("create {}: {error}", to.display()))?;
    let entries =
        fs::read_dir(from).map_err(|error| format!("read {}: {error}", from.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("read {}: {error}", from.display()))?;
        let source = entry.path();
        let destination = to.join(entry.file_name());
        if source.is_dir() {
            copy_directory(&source, &destination)?;
        } else {
            fs::copy(&source, &destination)
                .map_err(|error| format!("copy {}: {error}", source.display()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpack_targets_are_exact() {
        assert_eq!(Unpack::parse("temp"), Ok(Unpack::Temp));
        assert_eq!(Unpack::parse("local"), Ok(Unpack::Local));
        assert_eq!(Unpack::parse("cwd"), Ok(Unpack::Cwd));
        assert!(Unpack::parse("tmp").is_err());
    }

    #[test]
    fn copying_a_directory_keeps_its_shape() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("assets");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::write(source.join("a.txt"), b"a").unwrap();
        fs::write(source.join("nested/b.txt"), b"b").unwrap();

        let stage = dir.path().join("stage");
        fs::create_dir_all(&stage).unwrap();
        copy_asset(&source, &stage).unwrap();

        assert_eq!(fs::read(stage.join("assets/a.txt")).unwrap(), b"a");
        assert_eq!(fs::read(stage.join("assets/nested/b.txt")).unwrap(), b"b");
    }
}
