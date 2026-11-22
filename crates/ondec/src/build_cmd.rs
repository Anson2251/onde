//! The build pipeline: bundle → compile → encode → emit → link → strip → sign.
//!
//! One function, [`run`], because the order is the contract: a parse error must stop the build
//! before anything is written, and a signature must be the last thing that touches the file.
//!
//! ```text
//! 1. resolve the target and the toolchain      (fails before doing any work)
//! 2. bundle the entries with rolldown          (assets in memory, keys from filenames)
//! 3. compile every asset to module bytecode    (ln-engine, same engine as the SDK)
//! 4. resolve the SDK                           (cache, download, sha256, ABI stamp)
//! 5. encode the payload                        (ln-payload: header, table, bodies)
//! 6. write the generated C                     (array, or a linker section)
//! 7. one cc invocation                         (compile + link, stdio inherited)
//! 8. strip, then sign                          (nothing may modify the file afterwards)
//! ```
//!
//! The temp directory holds the generated C, the payload and any source maps; it is removed on
//! success unless `--keep-temp`, because the next thing a user does is copy the executable.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use crate::emit::{self, Embed};
use crate::frontend;
use crate::payload::{self, Asset};
use crate::sdk;
use crate::sign;
use crate::target::Target;
use crate::toolchain::{LinkJob, Toolchain};

/// Everything one `ondec build` needs.
#[derive(Debug)]
pub struct Request {
    /// The app's entry point.
    pub entry: PathBuf,
    /// `--target`, or `None` for the host.
    pub target: Option<String>,
    /// `-o`.
    pub output: Option<PathBuf>,
    /// `--packager`.
    pub packager: Packager,
    /// Frontend options.
    pub frontend: frontend::Options,
    /// SDK options.
    pub sdk: sdk::Options,
    /// Toolchain options.
    pub toolchain: crate::toolchain::Options,
    /// `--strip-source`.
    pub strip_source: bool,
    /// `--no-bytecode`.
    pub no_bytecode: bool,
    /// `--embed`.
    pub embed: Embed,
    /// `--compress`: `None` is a bare payload.
    pub compression: Option<payload::CompressionSetting>,
    /// Strip the executable after linking (on by default).
    pub strip: bool,
    /// `--sign`.
    pub sign: String,
    /// `--print-command`.
    pub print_command: bool,
    /// `--keep-temp`.
    pub keep_temp: bool,
    /// `-v`.
    pub verbose: bool,
    /// Wrappe backend options.
    pub wrappe: crate::wrappe::Options,
}

/// Which packaging mechanism produces the executable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Packager {
    /// Link the payload into a static runtime archive.
    Link,
    /// Stage the app and hand it to `wrappe` (no C toolchain, unpacks at run time).
    Wrappe,
}

impl Packager {
    /// Parse `--packager`.
    pub fn parse(name: &str) -> Result<Packager, String> {
        match name {
            "link" => Ok(Packager::Link),
            "wrappe" => Ok(Packager::Wrappe),
            other => Err(format!(
                "unknown --packager {other:?}; expected link or wrappe"
            )),
        }
    }
}

/// Run a build. `Ok(())` means the executable exists and is signed as asked.
pub fn run(request: &Request) -> Result<(), String> {
    let started = Instant::now();
    let target = match &request.target {
        Some(tuple) => Target::parse(tuple)?,
        None => Target::host()?,
    };
    // Resolve the toolchain first: a build that would fail at the link has no business bundling
    // or downloading anything.
    let toolchain = Toolchain::resolve(&target, &request.toolchain)?;
    verbose(
        request,
        &format!(
            "target {} ({}, {})",
            target,
            toolchain.family.as_str(),
            target.libc_name()
        ),
    );

    let output = output_path(request, &target);

    // 2. The frontend. Keys come from the bundler's filenames relative to the project root.
    let frontend::Bundle {
        chunks,
        entry,
        maps,
        warnings,
    } = frontend::bundle(&request.frontend)?;
    for warning in &warnings {
        eprintln!("ondec: warning: {warning}");
    }
    verbose(
        request,
        &format!("bundled {} module(s), entry {entry}", chunks.len()),
    );

    // 3. Compile every module. This is parse-only: no loader, no evaluation, its own isolate.
    let assets = compile(&chunks, request, &target)?;

    if request.packager == Packager::Wrappe {
        return crate::wrappe::pack(request, &target, &output, &chunks, &maps, started);
    }

    // 4. The SDK: cache, download, sha256, ABI stamp.
    let sdk = sdk::resolve(&target, &request.sdk)?;
    verbose(
        request,
        &format!("sdk {} ({})", sdk.dir.display(), sdk.stamp.summary()),
    );

    // 5. The payload.
    let stamp = ln_engine::engine_stamp_parsed();
    let image = payload::encode(&stamp, &assets, &entry, request.compression)?;
    let summary = payload::summarize(&assets);
    verbose(
        request,
        &format!(
            "payload {} bytes ({} modules, {}{})",
            image.len(),
            summary.modules,
            request
                .compression
                .map(|setting| setting.label())
                .unwrap_or_else(|| "bare".to_owned()),
            if request.no_bytecode {
                ", source"
            } else {
                ", bytecode"
            }
        ),
    );

    // 6. The generated C, in a temp directory that is the only place build junk can appear.
    let temp = tempfile::Builder::new()
        .prefix("ondec-build-")
        .tempdir()
        .map_err(|error| format!("cannot create a build directory: {error}"))?;
    let (c_file, assembly, section_file) = write_sources(&temp, request, &target, &image, &entry)?;

    // 7. One compiler invocation.
    let command = toolchain.link_command(&LinkJob {
        c_file: &c_file,
        assembly: assembly.as_deref(),
        section_file: section_file.as_deref(),
        include_dir: &sdk.dir,
        archive: &sdk.archive,
        output: &output,
    });
    if request.print_command {
        println!("{}", Toolchain::render(&command));
    } else {
        verbose(request, &format!("link: {}", Toolchain::render(&command)));
        toolchain.run(&command)?;
    }

    // 8. Strip, write maps, sign. Nothing after signing may touch the file.
    if request.strip {
        let strip = crate::toolchain::strip_command(&output);
        if request.print_command {
            println!("{}", Toolchain::render(&strip));
        } else {
            verbose(request, &format!("strip: {}", Toolchain::render(&strip)));
            toolchain.run(&strip)?;
        }
    }

    if !maps.is_empty() {
        write_maps(&output, &maps)?;
    }

    let sign_spec = sign::Spec::parse(&request.sign)?;
    if request.print_command {
        sign::run(&sign_spec, &output, &target, request.print_command)?;
    } else {
        verbose(request, &format!("sign: {}", request.sign));
        sign::run(&sign_spec, &output, &target, request.print_command)?;
    }

    if request.keep_temp {
        let path = temp.keep();
        eprintln!("ondec: kept the build directory at {}", path.display());
    }

    if request.print_command {
        return Ok(());
    }

    let size = fs::metadata(&output)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    println!(
        "ondec: built {} ({}) — {} module(s), {} payload, {} executable, {:.1}s",
        output.display(),
        target,
        summary.modules,
        human(image.len()),
        human(size as usize),
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

fn compile(
    chunks: &[frontend::Chunk],
    request: &Request,
    target: &Target,
) -> Result<Vec<Asset>, String> {
    let mut assets = Vec::with_capacity(chunks.len());
    for chunk in chunks {
        let body = if request.no_bytecode {
            chunk.code.as_bytes().to_vec()
        } else {
            let options = ln_engine::compile::Options {
                // The canonical name is what the module is registered as, and what the loader
                // will look up: `file:///<key>`.
                name: format!("file:///{}", chunk.key),
                strip_source: request.strip_source,
                endian: target.libc.endian(),
            };
            ln_engine::compile::module(&chunk.code, &options)
                .map_err(|error| format!("cannot compile {}:\n{}", chunk.key, error.body()))?
        };
        assets.push(Asset {
            key: chunk.key.clone(),
            body,
            kind: payload::chunk_kind(request.no_bytecode),
        });
    }
    Ok(assets)
}

/// Write the generated C (and, for section embedding, the payload and assembly).
fn write_sources(
    temp: &tempfile::TempDir,
    request: &Request,
    target: &Target,
    image: &[u8],
    entry: &str,
) -> Result<(PathBuf, Option<PathBuf>, Option<PathBuf>), String> {
    let payload_path = temp.path().join("app.bc");
    let c_path = temp.path().join("app.c");
    let mut assembly = None;
    let mut section_file = None;

    let payload_for_c = match request.embed {
        Embed::Array => String::new(),
        Embed::Section => {
            if !target.supports_section() {
                return Err(format!(
                    "--embed section is not available for {}: COFF has no .incbin, and the array \
                     placement costs nothing extra there",
                    target
                ));
            }
            fs::write(&payload_path, image)
                .map_err(|error| format!("write {}: {error}", payload_path.display()))?;
            let absolute = payload_path
                .canonicalize()
                .unwrap_or_else(|_| payload_path.clone());
            if target.is_macho() {
                // `-sectcreate` copies the file when linking; the C file reads the section.
                section_file = Some(absolute.clone());
            } else {
                let s_path = temp.path().join("payload.s");
                fs::write(
                    &s_path,
                    emit::elf_payload_assembly(&absolute.display().to_string()),
                )
                .map_err(|error| format!("write {}: {error}", s_path.display()))?;
                assembly = Some(s_path);
            }
            absolute.display().to_string()
        }
    };

    let source = emit::c_file(
        request.embed,
        target,
        env!("CARGO_PKG_VERSION"),
        ln_engine::engine_stamp(),
        image,
        &payload_for_c,
    )?;
    fs::write(&c_path, source).map_err(|error| format!("write {}: {error}", c_path.display()))?;
    let _ = entry;
    Ok((c_path, assembly, section_file))
}

/// Source maps go next to the executable, under `<name>.maps/`, because the payload itself is
/// embedded: a debugger needs the map on disk.
fn write_maps(output: &Path, maps: &[(String, String)]) -> Result<(), String> {
    let directory = match output.file_name() {
        Some(name) => output.with_file_name(format!("{}.maps", name.to_string_lossy())),
        None => return Err("cannot place source maps: the output has no file name".to_owned()),
    };
    for (key, map) in maps {
        let path = directory.join(key);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("create {}: {error}", parent.display()))?;
        }
        fs::write(&path, map).map_err(|error| format!("write {}: {error}", path.display()))?;
    }
    Ok(())
}

fn output_path(request: &Request, target: &Target) -> PathBuf {
    let mut path = request.output.clone().unwrap_or_else(|| {
        let stem = request
            .entry
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_else(|| "app".to_owned());
        PathBuf::from(stem)
    });
    let suffix = target.exe_suffix();
    if !suffix.is_empty() && !path.to_string_lossy().ends_with(suffix) {
        path = PathBuf::from(format!("{}{suffix}", path.display()));
    }
    path
}

fn verbose(request: &Request, message: &str) {
    if request.verbose {
        eprintln!("ondec: {message}");
    }
}

pub(crate) fn human(bytes: usize) -> String {
    const UNITS: [&str; 4] = ["B", "KiB", "MiB", "GiB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_output_defaults_to_the_entry_stem() {
        let request = Request {
            entry: PathBuf::from("/project/src/main.ts"),
            target: None,
            output: None,
            packager: Packager::Link,
            frontend: frontend::Options::default(),
            sdk: sdk::Options {
                dir: None,
                version: "0.1.0".to_owned(),
                no_fetch: true,
                base_url: None,
            },
            toolchain: crate::toolchain::Options::default(),
            strip_source: false,
            no_bytecode: false,
            embed: Embed::Array,
            compression: None,
            strip: true,
            sign: "none".to_owned(),
            print_command: false,
            keep_temp: false,
            verbose: false,
            wrappe: crate::wrappe::Options::default(),
        };
        let target = Target::parse("aarch64-apple-darwin").unwrap();
        assert_eq!(output_path(&request, &target), PathBuf::from("main"));
    }

    #[test]
    fn msvc_outputs_get_the_exe_suffix() {
        let target = Target::parse("x86_64-pc-windows-msvc").unwrap();
        let request = Request {
            entry: PathBuf::from("main.js"),
            target: Some(target.tuple.clone()),
            output: Some(PathBuf::from("app")),
            packager: Packager::Link,
            frontend: frontend::Options::default(),
            sdk: sdk::Options {
                dir: None,
                version: "0.1.0".to_owned(),
                no_fetch: true,
                base_url: None,
            },
            toolchain: crate::toolchain::Options::default(),
            strip_source: false,
            no_bytecode: false,
            embed: Embed::Array,
            compression: None,
            strip: true,
            sign: "none".to_owned(),
            print_command: false,
            keep_temp: false,
            verbose: false,
            wrappe: crate::wrappe::Options::default(),
        };
        assert_eq!(output_path(&request, &target), PathBuf::from("app.exe"));
    }

    #[test]
    fn sizes_are_human_readable() {
        assert_eq!(human(512), "512 B");
        assert_eq!(human(1536), "1.5 KiB");
        assert_eq!(human(5 * 1024 * 1024), "5.0 MiB");
    }

    #[test]
    fn packager_names_are_exact() {
        assert_eq!(Packager::parse("link"), Ok(Packager::Link));
        assert_eq!(Packager::parse("wrappe"), Ok(Packager::Wrappe));
        assert!(Packager::parse("append").is_err());
    }
}
