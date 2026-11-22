//! Signing a built app.
//!
//! Signing is a platform service, so the tool drives the platform's own signer instead of
//! reimplementing it:
//!
//! - **macOS**: `codesign --force --sign <identity>` (optionally with the hardened runtime).
//! - **Windows**: `signtool sign /fd sha256 /f <cert>`.
//! - **Linux**: no signing story in v1; the flag is refused rather than silently ignored.
//!
//! # What signing can and cannot cover
//!
//! Both placements this tool produces — a C array and a linker section — are part of the image
//! before the linker writes it, so the signature covers the payload. That is the whole reason
//! append-based packers are not the default here: an appending packer leaves the payload outside
//! the signed code, and re-signing the result does not seal it (verified: `codesign --verify`
//! passed but `spctl` rejected the appended binary; see the design doc's appendix).
//!
//! Signing happens **after** stripping, and nothing may modify the file afterwards.
//!
//! # A template is a command, not a shell
//!
//! `--sign @<template>` tokenizes the template and substitutes `{path}`; it is not run through a
//! shell, so a path with a space is one argv entry.

use std::path::Path;

use crate::target::{Libc, Target};
use crate::toolchain::{quote, tokenize, Toolchain};

/// A parsed `--sign` specification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Spec {
    /// `none`: no signing (the default).
    None,
    /// `codesign:<identity>`.
    CodeSign(String),
    /// `signtool:<certificate>`.
    SignTool(String),
    /// `@<template>`: an argv template with a `{path}` placeholder.
    Template(String),
}

impl Spec {
    /// Parse a `--sign` value.
    pub fn parse(spec: &str) -> Result<Spec, String> {
        let spec = spec.trim();
        if spec.is_empty() || spec == "none" {
            return Ok(Spec::None);
        }
        if let Some(identity) = spec.strip_prefix("codesign:") {
            if identity.trim().is_empty() {
                return Err("--sign codesign: needs an identity".to_owned());
            }
            return Ok(Spec::CodeSign(identity.trim().to_owned()));
        }
        if let Some(certificate) = spec.strip_prefix("signtool:") {
            if certificate.trim().is_empty() {
                return Err("--sign signtool: needs a certificate".to_owned());
            }
            return Ok(Spec::SignTool(certificate.trim().to_owned()));
        }
        if let Some(template) = spec.strip_prefix('@') {
            if !template.contains("{path}") {
                return Err(
                    "--sign @<template> must contain {path}; it is replaced with the built file"
                        .to_owned(),
                );
            }
            return Ok(Spec::Template(template.to_owned()));
        }
        Err(format!(
            "unknown --sign {spec:?}; expected none, codesign:<identity>, signtool:<cert>, or \
             @<template>"
        ))
    }
}

/// The command for `spec` on `path`, or `None` when nothing is to be done.
pub fn command(spec: &Spec, path: &Path, target: &Target) -> Result<Option<Vec<String>>, String> {
    let file = path.display().to_string();
    match spec {
        Spec::None => Ok(None),
        Spec::CodeSign(identity) => {
            if target.libc != Libc::Darwin {
                return Err(format!(
                    "--sign codesign: is macOS-only; {} is a {} build",
                    target.tuple,
                    target.libc_name()
                ));
            }
            Ok(Some(vec![
                "codesign".to_owned(),
                "--force".to_owned(),
                "--sign".to_owned(),
                identity.clone(),
                file,
            ]))
        }
        Spec::SignTool(certificate) => {
            if target.libc != Libc::Msvc {
                return Err(format!(
                    "--sign signtool: is Windows-only; {} is a {} build",
                    target.tuple,
                    target.libc_name()
                ));
            }
            Ok(Some(vec![
                "signtool".to_owned(),
                "sign".to_owned(),
                "/fd".to_owned(),
                "sha256".to_owned(),
                "/f".to_owned(),
                certificate.clone(),
                file,
            ]))
        }
        Spec::Template(template) => {
            let tokens = tokenize(template)?;
            let command = tokens
                .into_iter()
                .map(|token| token.replace("{path}", &file))
                .collect::<Vec<_>>();
            if command.is_empty() {
                return Err("--sign @<template> is empty".to_owned());
            }
            Ok(Some(command))
        }
    }
}

/// Run (or print) the signing step.
pub fn run(spec: &Spec, path: &Path, target: &Target, print_only: bool) -> Result<(), String> {
    let Some(command) = command(spec, path, target)? else {
        return Ok(());
    };
    if print_only {
        println!("{}", Toolchain::render(&command));
        return Ok(());
    }
    let (program, args) = command.split_first().expect("a non-empty command");
    let status = std::process::Command::new(program)
        .args(args)
        .status()
        .map_err(|error| format!("cannot run {program}: {error}"))?;
    if !status.success() {
        return Err(format!(
            "signing failed ({status}); nothing was published\n  {}",
            quote(&Toolchain::render(&command))
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::target::Target;

    fn darwin() -> Target {
        Target::parse("aarch64-apple-darwin").unwrap()
    }

    #[test]
    fn parses_the_four_forms() {
        assert_eq!(Spec::parse("none"), Ok(Spec::None));
        assert_eq!(Spec::parse(""), Ok(Spec::None));
        assert_eq!(
            Spec::parse("codesign:Developer ID Application: Me (TEAM)"),
            Ok(Spec::CodeSign(
                "Developer ID Application: Me (TEAM)".to_owned()
            ))
        );
        assert_eq!(
            Spec::parse("signtool:cert.pfx"),
            Ok(Spec::SignTool("cert.pfx".to_owned()))
        );
        assert_eq!(
            Spec::parse("@rcodesign sign {path}"),
            Ok(Spec::Template("rcodesign sign {path}".to_owned()))
        );
        assert!(Spec::parse("codesign:").is_err());
        assert!(Spec::parse("@echo no placeholder").is_err());
        assert!(Spec::parse("sign-me").is_err());
    }

    #[test]
    fn codesign_is_a_macos_command() {
        let command = command(
            &Spec::CodeSign("Me".to_owned()),
            Path::new("/tmp/app"),
            &darwin(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(command[0], "codesign");
        assert!(command.contains(&"/tmp/app".to_owned()));
        assert!(command.contains(&"Me".to_owned()));
    }

    #[test]
    fn codesign_on_linux_is_refused() {
        let target = Target::parse("x86_64-unknown-linux-gnu").unwrap();
        let error =
            command(&Spec::CodeSign("Me".to_owned()), Path::new("app"), &target).unwrap_err();
        assert!(error.contains("macOS-only"), "{error}");
    }

    #[test]
    fn a_template_substitutes_the_path_without_a_shell() {
        let command = command(
            &Spec::Template("rcodesign sign --file {path}".to_owned()),
            Path::new("/tmp/my app"),
            &darwin(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(command, vec!["rcodesign", "sign", "--file", "/tmp/my app"]);
    }
}
