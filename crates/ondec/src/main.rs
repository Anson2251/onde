//! `ondec` — the onde deployment compiler.
//!
//! Bundle a JavaScript app, compile it to QuickJS bytecode, and link it with the onde runtime into
//! one executable. This tool is host-only and is not part of the SDK: the built app links
//! `libonde.a` and never contains the bundler or this binary.
//!
//! ```text
//! ondec build src/main.js -o app
//! ondec sdk install --target x86_64-unknown-linux-musl
//! ```

use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};

use ondec::build_cmd;
use ondec::build_cmd::{Packager, Request};
use ondec::emit::Embed;
use ondec::frontend;
use ondec::payload;
use ondec::sdk;
use ondec::target::Target;
use ondec::toolchain;
use ondec::wrappe;
use ondec::wrappe::Unpack;

#[derive(Debug, Parser)]
#[command(
    name = "ondec",
    version,
    about = "Build a standalone onde app: bundle JavaScript into one executable",
    disable_help_subcommand = true
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
// The build options are parsed once, before anything else runs; the size difference between the
// variants is a stack copy at startup, not a hot path worth a box.
#[allow(clippy::large_enum_variant)]
enum Command {
    /// Bundle a JavaScript app and link it with the onde runtime
    Build(Build),
    /// Inspect, install and verify the SDK
    Sdk(Sdk),
}

#[derive(Debug, Args)]
struct Build {
    /// The app's entry point
    #[arg(value_name = "ENTRY")]
    entry: PathBuf,

    /// Target tuple (default: this machine's)
    #[arg(long, value_name = "TUPLE")]
    target: Option<String>,

    /// Where to write the executable (default: the entry's name)
    #[arg(short = 'o', long = "out", value_name = "FILE")]
    output: Option<PathBuf>,

    /// How the app is packaged: link, or wrappe (no C toolchain, unpacks at run time)
    #[arg(long, value_name = "link|wrappe", default_value = "link")]
    packager: String,

    /// The `onde` binary to embed with --packager wrappe
    #[arg(long, value_name = "PATH")]
    runtime: Option<PathBuf>,

    /// The wrappe command
    #[arg(long, value_name = "PATH", default_value = "wrappe")]
    wrappe: String,

    /// Copy a file or directory into the wrappe payload (repeatable)
    #[arg(long = "asset", value_name = "PATH")]
    assets: Vec<PathBuf>,

    /// Where wrappe unpacks: temp, local or cwd
    #[arg(long, value_name = "temp|local|cwd", default_value = "temp")]
    unpack_target: String,

    /// Additional entry point, repeatable (workers, CLI tools)
    #[arg(long = "entry", value_name = "FILE")]
    extra_entries: Vec<PathBuf>,

    /// Project root for payload keys (default: the nearest package.json)
    #[arg(long, value_name = "DIR")]
    outbase: Option<PathBuf>,

    /// Leave these imports unresolved (comma separated)
    #[arg(long, value_name = "SPEC,…", value_delimiter = ',')]
    externals: Vec<String>,

    /// Let dynamic imports become separate chunks
    #[arg(long)]
    splitting: bool,

    /// Minify the bundle
    #[arg(long)]
    minify: bool,

    /// Write source maps next to the executable (not yet consumed by the runtime)
    #[arg(long)]
    sourcemap: bool,

    /// Store source instead of bytecode (debugging)
    #[arg(long = "no-bytecode")]
    no_bytecode: bool,

    /// Smaller payload, losing Function.prototype.toString and error excerpts
    #[arg(long = "strip-source")]
    strip_source: bool,

    /// Use this unpacked SDK instead of the cache or a download
    #[arg(long, value_name = "DIR")]
    sdk: Option<PathBuf>,

    /// SDK version to fetch (default: this tool's version)
    #[arg(long, value_name = "VERSION", default_value = env!("CARGO_PKG_VERSION"))]
    sdk_version: String,

    /// Fail instead of downloading a missing SDK
    #[arg(long = "no-fetch")]
    no_fetch: bool,

    /// Release URL root for the SDK
    #[arg(long, value_name = "URL")]
    sdk_base_url: Option<String>,

    /// Compress the payload: none, zlib[:level] or zstd[:level] (default level: zlib 6, zstd 9)
    #[arg(
        long,
        value_name = "CODEC[:LEVEL]",
        default_value = "none",
        default_missing_value = "zstd",
        num_args = 0..=1,
        overrides_with = "no_compress"
    )]
    compress: String,

    /// Store the payload uncompressed (the default)
    #[arg(long = "no-compress", overrides_with = "compress")]
    no_compress: bool,

    /// Compiler driver for the target
    #[arg(long, value_name = "COMMAND")]
    cc: Option<String>,

    /// Flag policy: gcc, clang, zig or msvc (default: from the tuple)
    #[arg(long, value_name = "FAMILY")]
    cc_family: Option<String>,

    /// Cross sysroot
    #[arg(long, value_name = "DIR")]
    sysroot: Option<PathBuf>,

    /// Extra compiler flags, verbatim
    #[arg(long = "cflags", value_name = "FLAGS", allow_hyphen_values = true, num_args = 1..)]
    cflags: Vec<String>,

    /// Extra linker flags, verbatim
    #[arg(long = "ldflags", value_name = "FLAGS", allow_hyphen_values = true, num_args = 1..)]
    ldflags: Vec<String>,

    /// Where the payload lives: array (portable) or section (linker placed)
    #[arg(long, value_name = "array|section", default_value = "array")]
    embed: String,

    /// Do not strip the executable
    #[arg(long = "no-strip", overrides_with = "strip")]
    no_strip: bool,

    /// Also run strip (the default)
    #[arg(long, overrides_with = "no_strip")]
    strip: bool,

    /// Sign the executable: none, codesign:<identity>, signtool:<cert>, @<template>
    #[arg(long, value_name = "SPEC", default_value = "none")]
    sign: String,

    /// Print the commands instead of running them
    #[arg(long = "print-command")]
    print_command: bool,

    /// Keep the build directory (generated C, payload, maps)
    #[arg(long = "keep-temp")]
    keep_temp: bool,

    /// One line per step
    #[arg(short = 'v', long)]
    verbose: bool,
}

#[derive(Debug, Args)]
struct Sdk {
    #[command(subcommand)]
    command: SdkCommand,
}

#[derive(Debug, Subcommand)]
enum SdkCommand {
    /// List the cells for this version and which are cached
    List {
        /// Target tuple to describe (default: this machine's)
        #[arg(long, value_name = "TUPLE")]
        target: Option<String>,
    },
    /// Download and verify the SDK for a target
    Install {
        /// Target tuple (default: this machine's)
        #[arg(long, value_name = "TUPLE")]
        target: Option<String>,
        /// SDK version to fetch
        #[arg(long, value_name = "VERSION", default_value = env!("CARGO_PKG_VERSION"))]
        version: String,
        /// Release URL root
        #[arg(long, value_name = "URL")]
        base_url: Option<String>,
    },
    /// Print the cache directory for a target
    Path {
        /// Target tuple (default: this machine's)
        #[arg(long, value_name = "TUPLE")]
        target: Option<String>,
        /// SDK version
        #[arg(long, value_name = "VERSION", default_value = env!("CARGO_PKG_VERSION"))]
        version: String,
    },
    /// Verify a cached (or --sdk) archive against this tool's engine
    Verify {
        /// Target tuple (default: this machine's)
        #[arg(long, value_name = "TUPLE")]
        target: Option<String>,
        /// An unpacked SDK to verify instead of the cache
        #[arg(long, value_name = "DIR")]
        sdk: Option<PathBuf>,
        /// SDK version
        #[arg(long, value_name = "VERSION", default_value = env!("CARGO_PKG_VERSION"))]
        version: String,
    },
}

fn main() {
    raise_thread_stack_floor();
    std::process::exit(run());
}

/// Give every thread this process spawns a generous stack.
///
/// Bundling a very large single module (a ~1.9 MB file with tens of thousands of top-level
/// declarations) overflows the default 2 MB stack inside oxc's analysis in a **debug** build —
/// reproducible with a bare `rolldown` probe, so it is the bundler's frame size, not this tool's
/// recursion. Release builds are fine, but a developer running `cargo run -p ondec` should not get
/// a crash instead of a build. `std` reads this variable on every spawn, and this runs before any
/// thread exists, so setting it here is both effective and race-free; it costs address space, not
/// memory.
fn raise_thread_stack_floor() {
    if std::env::var_os("RUST_MIN_STACK").is_none() {
        std::env::set_var("RUST_MIN_STACK", (16 * 1024 * 1024).to_string());
    }
}

fn run() -> i32 {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(error) => {
            // Help and version are output; anything else is a usage error (exit 2, as documented).
            let _ = error.print();
            return if error.use_stderr() { 2 } else { 0 };
        }
    };

    match execute(cli) {
        Ok(()) => 0,
        Err(message) => {
            eprintln!("ondec: {message}");
            1
        }
    }
}

fn execute(cli: Cli) -> Result<(), String> {
    match cli.command {
        Command::Build(build) => run_build(build),
        Command::Sdk(sdk) => run_sdk(sdk),
    }
}

fn run_build(build: Build) -> Result<(), String> {
    let packager = Packager::parse(&build.packager)?;
    let embed = Embed::parse(&build.embed)?;
    let unpack = Unpack::parse(&build.unpack_target)?;

    let mut entries = Vec::with_capacity(1 + build.extra_entries.len());
    entries.push(build.entry);
    entries.extend(build.extra_entries.iter().cloned());

    let request = Request {
        entry: entries[0].clone(),
        target: build.target,
        output: build.output,
        packager,
        frontend: frontend::Options {
            entries,
            outbase: build.outbase,
            externals: build.externals,
            splitting: build.splitting,
            minify: build.minify,
            sourcemap: build.sourcemap,
        },
        sdk: sdk::Options {
            dir: build.sdk,
            version: build.sdk_version,
            no_fetch: build.no_fetch,
            base_url: build.sdk_base_url,
        },
        toolchain: toolchain::Options {
            cc: build.cc,
            family: build.cc_family,
            cflags: build.cflags,
            ldflags: build.ldflags,
            sysroot: build.sysroot,
        },
        strip_source: build.strip_source,
        no_bytecode: build.no_bytecode,
        embed,
        compression: if build.no_compress {
            None
        } else {
            payload::CompressionSetting::parse(&build.compress)?
        },
        strip: !build.no_strip,
        sign: build.sign,
        print_command: build.print_command,
        keep_temp: build.keep_temp,
        verbose: build.verbose,
        wrappe: wrappe::Options {
            program: build.wrappe,
            runtime: build.runtime,
            assets: build.assets,
            unpack,
        },
    };

    build_cmd::run(&request)
}

fn target_for(tuple: Option<&str>) -> Result<Target, String> {
    match tuple {
        Some(tuple) => Target::parse(tuple),
        None => Target::host(),
    }
}

fn run_sdk(sdk_command: Sdk) -> Result<(), String> {
    match sdk_command.command {
        SdkCommand::List { target } => {
            let target = target_for(target.as_deref())?;
            println!("cells for ondec {}:", env!("CARGO_PKG_VERSION"));
            for cell in sdk::CELLS {
                let parsed = Target::parse(cell)?;
                let dir = sdk::cache_dir(env!("CARGO_PKG_VERSION"), &parsed)?;
                let state = if dir.join("onde.h").is_file() {
                    "cached"
                } else {
                    "not installed"
                };
                let here = if cell == target.tuple {
                    " (this target)"
                } else {
                    ""
                };
                println!("  {cell:<28} {state}{here}");
            }
            Ok(())
        }
        SdkCommand::Install {
            target,
            version,
            base_url,
        } => {
            let target = target_for(target.as_deref())?;
            let options = sdk::Options {
                dir: None,
                version,
                no_fetch: false,
                base_url,
            };
            let resolved = sdk::resolve(&target, &options)?;
            println!(
                "{}: {} verified ({})",
                resolved.dir.display(),
                resolved.archive.display(),
                resolved.stamp.summary()
            );
            Ok(())
        }
        SdkCommand::Path { target, version } => {
            let target = target_for(target.as_deref())?;
            println!("{}", sdk::cache_dir(&version, &target)?.display());
            Ok(())
        }
        SdkCommand::Verify {
            target,
            sdk: dir,
            version,
        } => {
            let target = target_for(target.as_deref())?;
            let options = sdk::Options {
                dir,
                version,
                no_fetch: true,
                base_url: None,
            };
            let resolved = sdk::resolve(&target, &options)?;
            println!("archive: {}", resolved.archive.display());
            println!("stamp:   {}", resolved.stamp.encode());
            println!("engine:  {}", resolved.stamp.summary());
            println!("sha256:  {}", sdk::sha256(&resolved.archive)?);
            Ok(())
        }
    }
}
