//! The policy file and the command-line grant builder.
//!
//! Both channels build the same [`Policy`] value, so the plugin host (a file) and the ad-hoc
//! command line (flags) exercise one grammar and one matcher. The file is a security input: it is
//! realpathed, must be a regular file, is capped at 1 MiB, and may not be group- or world-writable
//! (ADR-0011 §3). Any failure is fatal; there is no implicit fall back to allow-all.

use std::fmt;
use std::fs;
use std::io::Read;
use std::net::IpAddr;
use std::path::{Path, PathBuf};

use json_comments::{CommentSettings, StripComments};
use serde::Deserialize;

use crate::capability::Capability;
use crate::policy::{Origin, Policy};
use crate::rule::{resolve_grant, EndpointRule, ExecRule, HostPattern, PathRule, Rule};
use crate::spans;

/// The largest policy file the parser reads. A policy is a reviewed, hand-written artifact; a
/// megabyte of it is a bug or an attack, not a policy.
pub const MAX_POLICY_BYTES: u64 = 1024 * 1024;

/// A policy that could not be read, parsed or built.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParseError {
    pub path: Option<PathBuf>,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub message: String,
}

impl ParseError {
    pub fn new(message: impl Into<String>) -> Self {
        ParseError {
            path: None,
            line: None,
            column: None,
            message: message.into(),
        }
    }

    fn in_file(path: &Path, message: impl Into<String>) -> Self {
        ParseError {
            path: Some(path.to_path_buf()),
            line: None,
            column: None,
            message: message.into(),
        }
    }

    fn in_capability(
        path: &Path,
        capability: Capability,
        line: Option<u32>,
        message: impl Into<String>,
    ) -> Self {
        ParseError {
            path: Some(path.to_path_buf()),
            line,
            column: None,
            message: format!("{capability}: {}", message.into()),
        }
    }

    fn json(path: &Path, error: serde_json::Error) -> Self {
        ParseError {
            path: Some(path.to_path_buf()),
            line: u32::try_from(error.line()).ok(),
            column: u32::try_from(error.column()).ok(),
            message: error.to_string(),
        }
    }
}

impl fmt::Display for ParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match (&self.path, self.line, self.column) {
            (Some(path), Some(line), Some(column)) => {
                write!(
                    formatter,
                    "{}:{}:{}: {}",
                    path.display(),
                    line,
                    column,
                    self.message
                )
            }
            (Some(path), Some(line), None) => {
                write!(formatter, "{}:{}: {}", path.display(), line, self.message)
            }
            (Some(path), None, _) => write!(formatter, "{}: {}", path.display(), self.message),
            (None, _, _) => formatter.write_str(&self.message),
        }
    }
}

impl std::error::Error for ParseError {}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawPolicy {
    #[serde(default)]
    fs: RawFs,
    #[serde(default)]
    net: RawNet,
    #[serde(default)]
    child_process: RawChild,
    #[serde(default)]
    worker: RawWorker,
    #[serde(default)]
    env: RawEnv,
    #[serde(default)]
    ffi: RawFfi,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawFs {
    #[serde(default)]
    read: Vec<String>,
    #[serde(default)]
    write: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawNet {
    #[serde(default)]
    connect: Vec<String>,
    #[serde(default)]
    listen: Vec<String>,
    #[serde(default)]
    resolve: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawChild {
    #[serde(default)]
    spawn: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawWorker {
    #[serde(default)]
    spawn: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawEnv {
    #[serde(default)]
    read: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawFfi {
    #[serde(default)]
    load: bool,
}

impl Policy {
    /// Read and validate a policy file.
    ///
    /// The path is realpathed; the result must be a regular file, no larger than
    /// [`MAX_POLICY_BYTES`], and (on unix) not group- or world-writable. Relative grants root at the
    /// realpathed file's directory, never at the caller's working directory.
    pub fn from_file(path: &Path) -> Result<Policy, ParseError> {
        let canonical = fs::canonicalize(path)
            .map_err(|error| ParseError::in_file(path, format!("cannot open: {error}")))?;
        let metadata = fs::metadata(&canonical)
            .map_err(|error| ParseError::in_file(&canonical, format!("cannot stat: {error}")))?;
        if !metadata.is_file() {
            return Err(ParseError::in_file(&canonical, "not a regular file"));
        }
        if metadata.len() > MAX_POLICY_BYTES {
            return Err(ParseError::in_file(
                &canonical,
                format!("larger than {MAX_POLICY_BYTES} bytes"),
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // The sudoers rule: a policy a group or the world can write is not a policy.
            if metadata.permissions().mode() & 0o022 != 0 {
                return Err(ParseError::in_file(&canonical, "group- or world-writable"));
            }
        }
        let text = fs::read_to_string(&canonical)
            .map_err(|error| ParseError::in_file(&canonical, format!("cannot read: {error}")))?;
        let base = canonical
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("/"));
        Policy::parse_str(&text, &canonical, base)
    }

    /// Parse policy text. `path` is the file the text came from (for errors and denial origins);
    /// `base` is the directory relative grants resolve against.
    pub fn parse_str(text: &str, path: &Path, base: &Path) -> Result<Policy, ParseError> {
        let mut stripped = String::new();
        StripComments::with_settings(CommentSettings::c_style(), text.as_bytes())
            .read_to_string(&mut stripped)
            .map_err(|error| {
                ParseError::in_file(path, format!("cannot strip comments: {error}"))
            })?;
        let raw: RawPolicy =
            serde_json::from_str(&stripped).map_err(|error| ParseError::json(path, error))?;
        let lines = spans::capability_lines(&stripped);

        let mut policy = Policy::with_origin(Origin::file(path));
        for capability in Capability::ALL {
            if let Some(line) = lines[capability.index()] {
                policy.set_origin(capability, Origin::file(path).with_line(Some(line)));
            }
        }

        for value in raw.fs.read {
            let rule = path_rule(path, Capability::FsRead, lines, base, &value)?;
            policy.add_rule(Capability::FsRead, rule);
        }
        for value in raw.fs.write {
            let rule = path_rule(path, Capability::FsWrite, lines, base, &value)?;
            policy.add_rule(Capability::FsWrite, rule);
        }
        for value in raw.net.connect {
            let rule = endpoint_rule(path, Capability::NetConnect, lines, base, &value)?;
            policy.add_rule(Capability::NetConnect, rule);
        }
        for value in raw.net.listen {
            let rule = endpoint_rule(path, Capability::NetListen, lines, base, &value)?;
            policy.add_rule(Capability::NetListen, rule);
        }
        for value in raw.net.resolve {
            let rule = host_rule(path, Capability::NetResolve, lines, &value)?;
            policy.add_rule(Capability::NetResolve, rule);
        }
        for value in raw.child_process.spawn {
            let rule = ExecRule::parse(&value, base).map_err(|message| {
                ParseError::in_capability(
                    path,
                    Capability::ChildSpawn,
                    lines[Capability::ChildSpawn.index()],
                    message,
                )
            })?;
            policy.add_rule(Capability::ChildSpawn, Rule::Exec(rule));
        }
        for value in raw.env.read {
            validate_env_name(&value).map_err(|message| {
                ParseError::in_capability(
                    path,
                    Capability::EnvRead,
                    lines[Capability::EnvRead.index()],
                    message,
                )
            })?;
            policy.add_rule(Capability::EnvRead, Rule::Name(value));
        }
        if raw.worker.spawn {
            policy.add_rule(Capability::WorkerSpawn, Rule::Any);
        }
        if raw.ffi.load {
            policy.add_rule(Capability::FfiLoad, Rule::Any);
        }
        Ok(policy)
    }

    /// Build a policy from command-line grants. The only behavioural difference from
    /// [`Policy::from_file`] is the base: flags resolve against `cwd`, and their origin is
    /// `CommandLine`.
    pub fn from_args(args: &GrantArgs) -> Result<Policy, ParseError> {
        let base = resolve_base(&args.cwd)?;
        let mut policy = Policy::with_origin(Origin::CommandLine);

        for value in &args.fs_read {
            let rule = cli_path_rule("--allow-fs-read", &base, value)?;
            policy.add_rule(Capability::FsRead, rule);
        }
        for value in &args.fs_write {
            let rule = cli_path_rule("--allow-fs-write", &base, value)?;
            policy.add_rule(Capability::FsWrite, rule);
        }
        for value in &args.net_connect {
            let rule = parse_endpoint(value, Capability::NetConnect, &base)
                .map_err(|message| cli_error("--allow-net-connect", value, message))?;
            policy.add_rule(Capability::NetConnect, rule);
        }
        for value in &args.net_listen {
            let rule = parse_endpoint(value, Capability::NetListen, &base)
                .map_err(|message| cli_error("--allow-net-listen", value, message))?;
            policy.add_rule(Capability::NetListen, rule);
        }
        for value in &args.net_resolve {
            let rule = parse_host_rule(value)
                .map_err(|message| cli_error("--allow-net-resolve", value, message))?;
            policy.add_rule(Capability::NetResolve, rule);
        }
        for value in &args.child_spawn {
            let rule = ExecRule::parse(value, &base)
                .map_err(|message| cli_error("--allow-child-process", value, message))?;
            policy.add_rule(Capability::ChildSpawn, Rule::Exec(rule));
        }
        for value in &args.env_read {
            validate_env_name(value).map_err(|message| cli_error("--allow-env", value, message))?;
            policy.add_rule(Capability::EnvRead, Rule::Name(value.clone()));
        }
        if args.worker {
            policy.add_rule(Capability::WorkerSpawn, Rule::Any);
        }
        if args.ffi {
            policy.add_rule(Capability::FfiLoad, Rule::Any);
        }
        Ok(policy)
    }
}

/// The values the CLI parsed. It is clap-free on purpose: `ln-perm` owns the grammar, the CLI owns
/// only argv.
#[derive(Clone, Debug)]
pub struct GrantArgs {
    pub cwd: PathBuf,
    pub fs_read: Vec<String>,
    pub fs_write: Vec<String>,
    pub net_connect: Vec<String>,
    pub net_listen: Vec<String>,
    pub net_resolve: Vec<String>,
    pub child_spawn: Vec<String>,
    pub env_read: Vec<String>,
    pub worker: bool,
    pub ffi: bool,
}

impl GrantArgs {
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        GrantArgs {
            cwd: cwd.into(),
            fs_read: Vec::new(),
            fs_write: Vec::new(),
            net_connect: Vec::new(),
            net_listen: Vec::new(),
            net_resolve: Vec::new(),
            child_spawn: Vec::new(),
            env_read: Vec::new(),
            worker: false,
            ffi: false,
        }
    }
}

fn resolve_base(cwd: &Path) -> Result<PathBuf, ParseError> {
    if let Ok(canonical) = fs::canonicalize(cwd) {
        return Ok(canonical);
    }
    if cwd.is_absolute() {
        return Ok(cwd.to_path_buf());
    }
    std::env::current_dir()
        .map(|current| current.join(cwd))
        .map_err(|error| ParseError::new(format!("cannot resolve the working directory: {error}")))
}

fn cli_path_rule(flag: &str, base: &Path, value: &str) -> Result<Rule, ParseError> {
    let resolved = resolve_grant(base, value).map_err(|message| cli_error(flag, value, message))?;
    Ok(Rule::Path(PathRule::new(resolved)))
}

fn cli_error(flag: &str, value: &str, message: impl Into<String>) -> ParseError {
    ParseError::new(format!("{flag}={value}: {}", message.into()))
}

fn path_rule(
    path: &Path,
    capability: Capability,
    lines: [Option<u32>; Capability::COUNT],
    base: &Path,
    value: &str,
) -> Result<Rule, ParseError> {
    let resolved = resolve_grant(base, value).map_err(|message| {
        ParseError::in_capability(path, capability, lines[capability.index()], message)
    })?;
    Ok(Rule::Path(PathRule::new(resolved)))
}

fn endpoint_rule(
    path: &Path,
    capability: Capability,
    lines: [Option<u32>; Capability::COUNT],
    base: &Path,
    value: &str,
) -> Result<Rule, ParseError> {
    let line = lines[capability.index()];
    parse_endpoint(value, capability, base)
        .map_err(|message| ParseError::in_capability(path, capability, line, message))
}

fn host_rule(
    path: &Path,
    capability: Capability,
    lines: [Option<u32>; Capability::COUNT],
    value: &str,
) -> Result<Rule, ParseError> {
    parse_host_rule(value).map_err(|message| {
        ParseError::in_capability(path, capability, lines[capability.index()], message)
    })
}

fn parse_endpoint(value: &str, capability: Capability, base: &Path) -> Result<Rule, String> {
    if value.is_empty() {
        return Err("an empty endpoint".to_owned());
    }
    if value == "."
        || value == ".."
        || value.starts_with('/')
        || value.starts_with("./")
        || value.starts_with("../")
    {
        let resolved = resolve_grant(base, value)?;
        return Ok(Rule::UnixPath(PathRule::new(resolved)));
    }
    if value.contains('\0') {
        return Err("an endpoint containing NUL".to_owned());
    }
    let (host, port) = split_endpoint(value, capability)?;
    let pattern = HostPattern::parse(host, capability == Capability::NetListen)?;
    Ok(Rule::Endpoint(EndpointRule::new(pattern, port)))
}

fn parse_host_rule(value: &str) -> Result<Rule, String> {
    if value.is_empty() {
        return Err("an empty host".to_owned());
    }
    if value.contains('/') || value.contains('\\') {
        return Err(format!(
            "'{value}': net.resolve takes a host name, not a path"
        ));
    }
    if value.contains('[') || value.contains(']') {
        return Err(format!(
            "'{value}': net.resolve takes a host name, not an address"
        ));
    }
    if value.parse::<IpAddr>().is_ok() {
        // A literal address needs no resolution grant; listing one in a policy would be dead.
        return Err(format!(
            "'{value}': a literal address needs no net.resolve grant"
        ));
    }
    if value.contains(':') {
        return Err(format!(
            "'{value}': net.resolve takes a host name, not a port or address"
        ));
    }
    Ok(Rule::Host(HostPattern::parse(value, false)?))
}

/// Split `host[:port]`, `:port` (listen only), or `[ipv6][:port]` into a host field and a port.
fn split_endpoint(value: &str, capability: Capability) -> Result<(&str, Option<u16>), String> {
    if let Some(rest) = value.strip_prefix('[') {
        let Some((inside, after)) = rest.split_once(']') else {
            return Err(format!("'{value}': unterminated IPv6 literal"));
        };
        if inside.is_empty() {
            return Err(format!("'{value}': an empty address"));
        }
        if after.is_empty() {
            return Ok((inside, None));
        }
        let Some(port) = after.strip_prefix(':') else {
            return Err(format!("'{value}': expected ':' after the address"));
        };
        return Ok((inside, Some(parse_port(port)?)));
    }
    // An unbracketed value with more than one colon is an IPv6 literal the policy cannot spell
    // unambiguously; require brackets.
    if value.matches(':').count() > 1 {
        return Err(format!("'{value}': bracket an IPv6 literal"));
    }
    if let Some(port) = value.strip_prefix(':') {
        if capability != Capability::NetListen {
            return Err(format!("'{value}': an omitted host is listen-only"));
        }
        return Ok(("", Some(parse_port(port)?)));
    }
    match value.rsplit_once(':') {
        None => Ok((value, None)),
        Some((host, port)) => Ok((host, Some(parse_port(port)?))),
    }
}

fn parse_port(text: &str) -> Result<u16, String> {
    if text.is_empty() {
        return Err("an empty port".to_owned());
    }
    if !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!("invalid port '{text}'"));
    }
    text.parse::<u16>()
        .map_err(|_| format!("invalid port '{text}'"))
}

fn validate_env_name(value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err("an empty environment variable name".to_owned());
    }
    if value.contains('=') {
        return Err(format!(
            "'{value}': an environment variable name cannot contain '='"
        ));
    }
    if value.contains('\0') {
        return Err("an environment variable name containing NUL".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::Request;
    use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};

    const ADR_EXAMPLE: &str = r#"{
  // Relative paths resolve against this file's directory, after realpath.
  "fs": {
    "read":  ["./data", "/usr/share/zoneinfo"],
    "write": ["./cache"]
  },
  "net": {
    "connect": ["api.example.com:443", "*.internal.example.com"],
    "listen":  [":8080"],
    "resolve": ["api.example.com"]
  },
  "child_process": { "spawn": ["git", "/usr/bin/make"] },
  "worker": { "spawn": true },
  "env": { "read": ["PORT", "NODE_ENV"] },
  "ffi": { "load": true }
}
"#;

    fn path(value: &str) -> PathBuf {
        PathBuf::from(value)
    }

    fn canonical(path: &Path) -> PathBuf {
        fs::canonicalize(path).expect("canonical")
    }

    fn write_policy(dir: &Path, text: &str) -> PathBuf {
        let path = dir.join("ci.json");
        fs::write(&path, text).expect("write policy");
        path
    }

    #[test]
    fn the_adr_example_parses_and_grants_every_capability() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::create_dir(dir.path().join("data")).expect("data");
        let file = write_policy(dir.path(), ADR_EXAMPLE);
        let base = canonical(dir.path());
        let policy = Policy::from_file(&file).expect("policy");

        assert!(policy
            .check(&Request::Path {
                capability: Capability::FsRead,
                resolved: &base.join("data/a")
            })
            .is_ok());
        assert!(policy
            .check(&Request::Path {
                capability: Capability::FsRead,
                resolved: &path("/etc/passwd")
            })
            .is_err());
        assert!(policy
            .check(&Request::Path {
                capability: Capability::FsWrite,
                resolved: &base.join("cache/x")
            })
            .is_ok());
        assert!(policy.check(&Request::Env { name: "PORT" }).is_ok());
        assert!(policy.check(&Request::Env { name: "HOME" }).is_err());
        assert!(policy
            .check(&Request::Toggle {
                capability: Capability::WorkerSpawn
            })
            .is_ok());
        assert!(policy
            .check(&Request::Toggle {
                capability: Capability::FfiLoad
            })
            .is_ok());
        assert!(policy
            .check(&Request::Executable {
                resolved: &path("/usr/bin/git")
            })
            .is_ok());
        assert!(policy
            .check(&Request::Executable {
                resolved: &path("/usr/bin/make")
            })
            .is_ok());
        assert!(policy
            .check(&Request::Executable {
                resolved: &path("/bin/sh")
            })
            .is_err());
        assert!(policy
            .check(&Request::Host {
                host: "api.example.com"
            })
            .is_ok());
        assert!(policy
            .check(&Request::Host {
                host: "a.internal.example.com"
            })
            .is_ok());
    }

    #[test]
    fn relative_grants_root_at_the_file_directory_not_the_cwd() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::create_dir(dir.path().join("data")).expect("data");
        let file = write_policy(dir.path(), r#"{ "fs": { "read": ["./data"] } }"#);
        let base = canonical(dir.path());
        let policy = Policy::from_file(&file).expect("policy");
        assert!(policy
            .check(&Request::Path {
                capability: Capability::FsRead,
                resolved: &base.join("data/a")
            })
            .is_ok());
    }

    fn in_temp_dir(text: &str) -> Result<Policy, ParseError> {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = write_policy(dir.path(), text);
        Policy::from_file(&file)
    }

    #[test]
    fn unknown_keys_and_wrong_types_are_errors() {
        assert!(in_temp_dir(r#"{ "fs": { "execute": [] } }"#).is_err());
        assert!(in_temp_dir(r#"{ "fs": { "read": "./x" } }"#).is_err());
        assert!(in_temp_dir(r#"{ "fs": { "read": [1] } }"#).is_err());
        assert!(in_temp_dir(r#"{ "worker": { "spawn": "yes" } }"#).is_err());
        assert!(in_temp_dir(r#"{ "fs": null }"#).is_err());
        assert!(in_temp_dir(r#"{ "surprise": {} }"#).is_err());
        assert!(in_temp_dir(r#"[1, 2]"#).is_err());
        assert!(in_temp_dir("").is_err());
    }

    #[test]
    fn comments_are_stripped_but_hash_comments_and_trailing_commas_are_not() {
        assert!(in_temp_dir("{\n// a comment\n\"env\": { \"read\": [\"PORT\"] }\n}").is_ok());
        assert!(in_temp_dir("{\n/* block */\n\"env\": { \"read\": [\"PORT\"] }\n}").is_ok());
        assert!(in_temp_dir("{\n# not a comment\n\"env\": {}\n}").is_err());
        assert!(in_temp_dir("{\"env\": { \"read\": [\"PORT\"] },}").is_err());
    }

    #[test]
    fn a_comment_like_string_is_left_alone() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::create_dir(dir.path().join("a")).expect("a");
        fs::create_dir(dir.path().join("a//b")).expect("weird");
        let file = write_policy(dir.path(), r#"{ "fs": { "read": ["./a//b"] } }"#);
        let base = canonical(dir.path());
        let policy = Policy::from_file(&file).expect("policy");
        assert!(policy
            .check(&Request::Path {
                capability: Capability::FsRead,
                resolved: &base.join("a/b/x")
            })
            .is_ok());
    }

    #[test]
    fn net_endpoints_reject_connect_wildcards_and_bad_ports() {
        assert!(in_temp_dir(r#"{ "net": { "connect": [":8080"] } }"#).is_err());
        assert!(in_temp_dir(r#"{ "net": { "listen": ["host:notaport"] } }"#).is_err());
        assert!(in_temp_dir(r#"{ "net": { "connect": ["::1"] } }"#).is_err());
        assert!(in_temp_dir(r#"{ "net": { "connect": ["[::1]:443"] } }"#).is_ok());
        assert!(in_temp_dir(r#"{ "net": { "listen": ["[::1]:443"] } }"#).is_ok());
        assert!(in_temp_dir(r#"{ "net": { "resolve": ["host:443"] } }"#).is_err());
        assert!(in_temp_dir(r#"{ "net": { "resolve": ["a/b"] } }"#).is_err());
        assert!(in_temp_dir(r#"{ "net": { "connect": ["*"] } }"#).is_err());
        assert!(in_temp_dir(r#"{ "net": { "connect": ["a.*.b"] } }"#).is_err());
    }

    #[test]
    fn a_literal_address_is_not_a_resolve_grant() {
        assert!(in_temp_dir(r#"{ "net": { "resolve": ["127.0.0.1"] } }"#).is_err());
    }

    #[test]
    fn port_zero_is_literal() {
        let policy = in_temp_dir(r#"{ "net": { "listen": [":0"] } }"#).expect("policy");
        assert!(policy
            .check(&Request::Endpoint {
                capability: Capability::NetListen,
                host: None,
                port: 0,
                address: None
            })
            .is_ok());
        assert!(policy
            .check(&Request::Endpoint {
                capability: Capability::NetListen,
                host: None,
                port: 8080,
                address: None
            })
            .is_err());
    }

    #[test]
    fn a_present_capability_cites_its_key_line() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = write_policy(
            dir.path(),
            "{\n  \"fs\": {\n    \"read\": [\"./data\"]\n  }\n}\n",
        );
        let policy = Policy::from_file(&file).expect("policy");
        let denial = policy
            .check(&Request::Path {
                capability: Capability::FsRead,
                resolved: canonical(dir.path()).join("other").as_path(),
            })
            .expect_err("denied");
        assert_eq!(denial.origin.line(), Some(3));
        assert!(denial.message().contains(":3"), "{}", denial.message());
    }

    #[test]
    fn an_absent_capability_cites_the_file_without_a_line() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = write_policy(dir.path(), "{\n  \"fs\": {}\n}\n");
        let policy = Policy::from_file(&file).expect("policy");
        let denial = policy
            .check(&Request::Path {
                capability: Capability::FsRead,
                resolved: &path("/etc/passwd"),
            })
            .expect_err("denied");
        assert_eq!(denial.origin.line(), None);
        assert_eq!(denial.origin.path(), Some(canonical(&file).as_path()));
    }

    #[test]
    fn the_file_is_a_security_input() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = write_policy(dir.path(), r#"{ "fs": { "read": ["/"] } }"#);

        // A directory is not a policy.
        let mut directory = dir.path().to_path_buf();
        directory.push("sub");
        fs::create_dir(&directory).expect("dir");
        assert!(Policy::from_file(&directory).is_err());

        // Missing is fatal.
        assert!(Policy::from_file(&dir.path().join("missing.json")).is_err());

        // Over the cap is fatal before parsing.
        let big = dir.path().join("big.json");
        fs::write(&big, vec![b' '; (MAX_POLICY_BYTES + 1) as usize]).expect("big");
        assert!(Policy::from_file(&big).is_err());

        // The regular file is accepted.
        assert!(Policy::from_file(&file).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn a_group_or_world_writable_policy_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let file = write_policy(dir.path(), r#"{ "fs": { "read": ["/"] } }"#);
        for mode in [0o664, 0o666, 0o606] {
            fs::set_permissions(&file, fs::Permissions::from_mode(mode)).expect("chmod");
            assert!(Policy::from_file(&file).is_err(), "mode {mode:o}");
        }
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).expect("chmod");
        assert!(Policy::from_file(&file).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_policy_is_resolved_not_refused() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().expect("tempdir");
        let target = write_policy(dir.path(), r#"{ "fs": { "read": ["/"] } }"#);
        let link = dir.path().join("link.json");
        symlink(&target, &link).expect("symlink");
        let policy = Policy::from_file(&link).expect("policy");
        let denial = policy
            .check(&Request::Path {
                capability: Capability::FsWrite,
                resolved: &path("/x"),
            })
            .expect_err("write is not granted");
        assert_eq!(
            denial.origin.path(),
            Some(fs::canonicalize(&target).expect("canonical").as_path())
        );
    }

    #[test]
    fn the_two_grant_channels_share_one_grammar() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = write_policy(
            dir.path(),
            r#"{
  "fs": { "read": ["./data"] },
  "net": { "connect": ["api.example.com:443"] },
  "env": { "read": ["PORT"] },
  "worker": { "spawn": true }
}"#,
        );
        let from_file = Policy::from_file(&file).expect("policy");

        let mut args = GrantArgs::new(dir.path());
        args.fs_read.push("./data".to_owned());
        args.net_connect.push("api.example.com:443".to_owned());
        args.env_read.push("PORT".to_owned());
        args.worker = true;
        let from_args = Policy::from_args(&args).expect("policy");

        for capability in Capability::ALL {
            assert_eq!(
                from_file.rules(capability),
                from_args.rules(capability),
                "{capability}"
            );
        }
        assert_eq!(from_args.origin(Capability::FsRead), &Origin::CommandLine);
    }

    #[test]
    fn cli_paths_resolve_against_the_cwd() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut args = GrantArgs::new(dir.path());
        args.fs_read.push("data".to_owned());
        let policy = Policy::from_args(&args).expect("policy");
        assert!(policy
            .check(&Request::Path {
                capability: Capability::FsRead,
                resolved: &canonical(dir.path()).join("data/a"),
            })
            .is_ok());
    }

    #[test]
    fn a_cli_mistake_names_the_flag_and_value() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut args = GrantArgs::new(dir.path());
        args.net_connect.push(":8080".to_owned());
        let error = Policy::from_args(&args).expect_err("listen-only");
        assert!(error.to_string().contains("--allow-net-connect=:8080"));
    }

    #[test]
    fn an_endpoint_matches_the_name_or_the_resolved_address() {
        let policy = in_temp_dir(r#"{ "net": { "connect": ["127.0.0.1:443"] } }"#).expect("policy");
        let address = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 443));
        assert!(policy
            .check(&Request::Endpoint {
                capability: Capability::NetConnect,
                host: Some("example.invalid"),
                port: 443,
                address: Some(&address),
            })
            .is_ok());
    }
}
