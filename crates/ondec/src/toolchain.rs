//! Choosing and driving the C toolchain.
//!
//! The tool never guesses. A tuple fixes the cell; the user names the compiler (`--cc`), or an
//! existing cross setup names it for us (`CC_<tuple>`, cargo's convention), or — for the host
//! tuple only — `$CC`/`cc` is used. Anything else is an error that prints the flag and the exact
//! environment variable to set.
//!
//! The command is always run as `spawn(program, args, { stdio: inherit })`, never through a shell.
//! Paths with spaces, `&` or quotes therefore work on every platform, and `--cc "zig cc -target
//! aarch64-linux-musl"` is split by an argv-aware tokenizer rather than `sh`.

use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::target::{Family, Libc, Target};

/// Everything that decides the command line, resolved once.
#[derive(Debug, Clone)]
pub struct Toolchain {
    /// The program to spawn (`cc`, `zig`, `cl`, …).
    pub program: String,
    /// Arguments that belong to the driver before the file names (`cc`'s `-target …`).
    pub prefix: Vec<String>,
    /// Flag spelling.
    pub family: Family,
    /// The cell.
    pub target: Target,
    /// Extra compiler flags, verbatim, after the driver's own.
    pub cflags: Vec<String>,
    /// Extra linker flags, verbatim.
    pub ldflags: Vec<String>,
    /// Cross sysroot, if one was given.
    pub sysroot: Option<PathBuf>,
}

/// The user's toolchain choices, before resolution.
#[derive(Debug, Clone, Default)]
pub struct Options {
    /// `--cc`, a full command line.
    pub cc: Option<String>,
    /// `--cc-family`.
    pub family: Option<String>,
    /// `--cflags`.
    pub cflags: Vec<String>,
    /// `--ldflags`.
    pub ldflags: Vec<String>,
    /// `--sysroot`.
    pub sysroot: Option<PathBuf>,
}

impl Toolchain {
    /// Resolve the program, family and flags for `target`.
    pub fn resolve(target: &Target, options: &Options) -> Result<Toolchain, String> {
        let family = match &options.family {
            Some(name) => Family::parse(name)?,
            None => target.default_family(),
        };

        let (program, prefix) = resolve_program(target, family, options.cc.as_deref())?;

        Ok(Toolchain {
            program,
            prefix,
            family,
            target: target.clone(),
            cflags: options.cflags.clone(),
            ldflags: options.ldflags.clone(),
            sysroot: options.sysroot.clone(),
        })
    }

    /// Everything the link needs besides the toolchain.
    ///
    /// `section` is `Some(path)` for `--embed section`: the linker is told to place that file's
    /// bytes in a named section, and the generated C reads them back.
    pub fn link_command(&self, job: &LinkJob<'_>) -> Vec<String> {
        let mut args = vec![self.program.clone()];
        args.extend(self.prefix.iter().cloned());

        if self.family.is_msvc() {
            self.msvc_args(&mut args, job);
            return args;
        }

        args.extend(self.cflags.iter().cloned());
        if let Some(sysroot) = &self.sysroot {
            args.push(format!("-isysroot{}", sysroot.display()));
        }
        args.push(format!("-I{}", job.include_dir.display()));

        args.push(job.c_file.display().to_string());
        if let Some(assembly) = job.assembly {
            args.push(assembly.display().to_string());
        }

        if self.target.libc == Libc::Musl {
            args.extend(
                self.target
                    .link_flags()
                    .iter()
                    .map(|flag| (*flag).to_owned()),
            );
        }

        if let Some(section) = job.section_file {
            if self.target.is_macho() {
                args.push(format!(
                    "-Wl,-sectcreate,__DATA,__onde,{}",
                    section.display()
                ));
            } else {
                // ELF: the section is placed by the generated `.S`, which `.incbin`s the payload.
                // Nothing to tell the linker, but keep `--gc-sections` from dropping it: the C
                // file references the start/end symbols, which is enough.
                let _ = section;
            }
        }

        args.push(job.archive.display().to_string());
        args.push("-o".to_owned());
        args.push(job.output.display().to_string());

        args.extend(self.ldflags.iter().cloned());
        args.extend(self.target.link_libs().iter().map(|lib| (*lib).to_owned()));
        args
    }

    fn msvc_args(&self, args: &mut Vec<String>, job: &LinkJob<'_>) {
        args.push("/nologo".to_owned());
        // The archive is built against the dynamic CRT (`/MD`); an `/MT` object cannot link with
        // it. A user who needs `/MT` needs a `+crt-static` cell, which is a release artifact.
        args.push("/MD".to_owned());
        args.extend(self.cflags.iter().cloned());
        args.push(format!("/I{}", job.include_dir.display()));
        args.push(job.c_file.display().to_string());
        args.extend(self.ldflags.iter().cloned());
        args.push(job.archive.display().to_string());
        args.push(format!("/Fe:{}", job.output.display()));
        args.extend(self.target.link_libs().iter().map(|lib| (*lib).to_owned()));
    }

    /// A human-readable, copy-pasteable form of a command.
    pub fn render(command: &[String]) -> String {
        command
            .iter()
            .map(|argument| quote(argument))
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// Run one command with inherited stdio.
    pub fn run(&self, command: &[String]) -> Result<(), String> {
        let (program, args) = command
            .split_first()
            .ok_or_else(|| "empty command".to_owned())?;
        let status = Command::new(program)
            .args(args)
            .status()
            .map_err(|error| format!("cannot run {program}: {error}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!(
                "{program} failed ({status})\n  {}",
                Toolchain::render(command)
            ))
        }
    }
}

/// One compile-and-link invocation.
#[derive(Debug)]
pub struct LinkJob<'a> {
    /// The generated C file.
    pub c_file: &'a Path,
    /// The generated `.S` for an ELF `--embed section` build.
    pub assembly: Option<&'a Path>,
    /// The payload file placed by the linker (`--embed section` on Mach-O).
    pub section_file: Option<&'a Path>,
    /// Directory with `onde.h`.
    pub include_dir: &'a Path,
    /// The SDK archive.
    pub archive: &'a Path,
    /// The executable to write.
    pub output: &'a Path,
}

fn resolve_program(
    target: &Target,
    family: Family,
    explicit: Option<&str>,
) -> Result<(String, Vec<String>), String> {
    if let Some(command) = explicit {
        let tokens = tokenize(command)?;
        let (program, prefix) = tokens
            .split_first()
            .ok_or_else(|| "--cc is empty".to_owned())?;
        return Ok((program.clone(), prefix.to_vec()));
    }

    let variable = target.cc_env_var();
    if let Some(value) = env::var_os(&variable) {
        let value = value.to_string_lossy().into_owned();
        if !value.trim().is_empty() {
            let tokens = tokenize(&value)?;
            let (program, prefix) = tokens
                .split_first()
                .ok_or_else(|| format!("{variable} is empty"))?;
            return Ok((program.clone(), prefix.to_vec()));
        }
    }

    if target.is_host() {
        if let Some(value) = env::var_os("CC") {
            let value = value.to_string_lossy().into_owned();
            if !value.trim().is_empty() {
                let tokens = tokenize(&value)?;
                let (program, prefix) = tokens
                    .split_first()
                    .ok_or_else(|| "CC is empty".to_owned())?;
                return Ok((program.clone(), prefix.to_vec()));
            }
        }
        let program = match family {
            Family::Msvc => "cl",
            _ => "cc",
        };
        return Ok((program.to_owned(), Vec::new()));
    }

    Err(format!(
        "no compiler for target {}: pass --cc \"<command>\" or set {variable}\n  \
         (a non-host target is never compiled with the host's cc by default: the archive would be \
         for one machine and the C object for another)",
        target.tuple
    ))
}

/// Split a command line into argv, honouring quotes.
///
/// This is not a shell: no globbing, no variables, no `$()`. A double or single quote groups a
/// token (and is removed), a backslash escapes the next character outside single quotes, and
/// everything else splits on whitespace. That is enough for `--cc "zig cc -target x"` and for
/// paths with spaces.
pub fn tokenize(command: &str) -> Result<Vec<String>, String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quoted: Option<char> = None;
    let mut started = false;

    for character in command.chars() {
        match quoted {
            // Sentinel for a backslash: take exactly one character, literally.
            Some('\u{0}') => {
                current.push(character);
                quoted = None;
            }
            Some(quote) => {
                if character == quote {
                    quoted = None;
                } else {
                    current.push(character);
                }
            }
            None => match character {
                '\'' | '"' => {
                    quoted = Some(character);
                    started = true;
                }
                '\\' => {
                    // Keep the next character literally; a trailing backslash is an error.
                    started = true;
                    quoted = Some('\u{0}'); // sentinel: take exactly one character
                }
                c if c.is_whitespace() => {
                    if started {
                        tokens.push(std::mem::take(&mut current));
                        started = false;
                    }
                }
                c => {
                    current.push(c);
                    started = true;
                }
            },
        }
    }

    if quoted == Some('\u{0}') {
        return Err(format!("{command:?} ends with a backslash"));
    }
    if quoted.is_some() {
        return Err(format!("{command:?} has an unterminated quote"));
    }
    if started {
        tokens.push(current);
    }
    Ok(tokens)
}

/// Shell-quote one argument for `--print-command`, so the printed line can be pasted back.
pub fn quote(argument: &str) -> String {
    if argument.is_empty() {
        return "''".to_owned();
    }
    if argument
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "-_./:=+,@%".contains(c))
    {
        return argument.to_owned();
    }
    format!("'{}'", argument.replace('\'', "'\\''"))
}

/// The command that strips a linked executable.
pub fn strip_command(output: &Path) -> Vec<String> {
    vec!["strip".to_owned(), output.display().to_string()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenizes_quoted_commands() {
        assert_eq!(
            tokenize("zig cc -target aarch64-linux-musl").unwrap(),
            vec!["zig", "cc", "-target", "aarch64-linux-musl"]
        );
        assert_eq!(
            tokenize("'/opt/my tools/cc' -O2").unwrap(),
            vec!["/opt/my tools/cc", "-O2"]
        );
        assert_eq!(
            tokenize(r#"clang "-DNAME=a b""#).unwrap(),
            vec!["clang", "-DNAME=a b"]
        );
        assert_eq!(tokenize("cc a\\ b").unwrap(), vec!["cc", "a b"]);
        assert!(tokenize("cc 'unterminated").is_err());
    }

    #[test]
    fn renders_paths_that_need_quoting() {
        assert_eq!(quote("cc"), "cc");
        assert_eq!(quote("-O2"), "-O2");
        assert_eq!(quote("/tmp/a b/app.c"), "'/tmp/a b/app.c'");
        assert_eq!(quote("it's"), "'it'\\''s'");
    }

    #[test]
    fn the_link_command_puts_the_archive_before_the_libraries() {
        let target = Target::parse("aarch64-apple-darwin").unwrap();
        let toolchain = Toolchain::resolve(&target, &Options::default()).unwrap();
        let command = toolchain.link_command(&LinkJob {
            c_file: Path::new("app.c"),
            assembly: None,
            section_file: None,
            include_dir: Path::new("sdk"),
            archive: Path::new("sdk/libonde.a"),
            output: Path::new("app"),
        });
        let archive = command
            .iter()
            .position(|argument| argument == "sdk/libonde.a")
            .expect("the archive is on the line");
        let libc = command
            .iter()
            .position(|argument| argument == "-liconv")
            .expect("the cell's libraries are on the line");
        assert!(
            archive < libc,
            "static libraries must come after the objects that use them: {command:?}"
        );
        assert!(command.contains(&"-o".to_owned()));
    }

    #[test]
    fn musl_cells_link_statically() {
        let target = Target::parse("x86_64-unknown-linux-musl").unwrap();
        let toolchain = Toolchain::resolve(
            &target,
            &Options {
                cc: Some("cc".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        let command = toolchain.link_command(&LinkJob {
            c_file: Path::new("app.c"),
            assembly: None,
            section_file: None,
            include_dir: Path::new("sdk"),
            archive: Path::new("sdk/libonde.a"),
            output: Path::new("app"),
        });
        assert!(command.contains(&"-static".to_owned()));
        assert!(
            !command.contains(&"-lpthread".to_owned()),
            "musl has pthread inside libc; a leftover gnu flag is the classic musl failure"
        );
    }

    #[test]
    fn a_cross_target_needs_an_explicit_compiler() {
        let target = Target::parse("x86_64-unknown-linux-gnu").unwrap();
        if target.is_host() {
            return;
        }
        let error = Toolchain::resolve(&target, &Options::default()).unwrap_err();
        assert!(error.contains("--cc"), "{error}");
        assert!(error.contains("CC_x86_64_unknown_linux_gnu"), "{error}");
    }

    #[test]
    fn section_embedding_adds_the_macho_linker_flag() {
        let target = Target::parse("aarch64-apple-darwin").unwrap();
        let toolchain = Toolchain::resolve(&target, &Options::default()).unwrap();
        let command = toolchain.link_command(&LinkJob {
            c_file: Path::new("app.c"),
            assembly: None,
            section_file: Some(Path::new("app.bc")),
            include_dir: Path::new("sdk"),
            archive: Path::new("sdk/libonde.a"),
            output: Path::new("app"),
        });
        assert!(
            command
                .iter()
                .any(|argument| argument.contains("sectcreate,__DATA,__onde,app.bc")),
            "{command:?}"
        );
    }
}
