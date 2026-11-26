//! Allow-list rules and the matching they do.
//!
//! A rule is data, not a closure: it is built once from a policy file or a command-line flag and
//! then matched against already-resolved paths and addresses. Resolution belongs to the crate that
//! is about to make the syscall (`ln-io`), except for grant paths, which are canonicalised here as
//! far as they exist so that a write grant for a directory that is created later still matches.

use std::ffi::OsStr;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::path::{Component, Path, PathBuf};

/// Lexically normalise an absolute path: `.` is dropped and `..` pops a component (but never above
/// the root). Returns `None` for a relative path whose leading `..` cannot be resolved.
pub fn normalize_lexical(path: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    let mut rooted = false;
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => {
                out.push(Component::RootDir.as_os_str());
                rooted = true;
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() && !rooted {
                    return None;
                }
            }
            Component::Normal(part) => out.push(part),
        }
    }
    if out.as_os_str().is_empty() {
        if rooted {
            out.push(Component::RootDir.as_os_str());
        } else {
            return None;
        }
    }
    Some(out)
}

/// `realpath` as far as the path exists: canonicalise the deepest existing ancestor and append the
/// remaining components unchanged.
///
/// This is what lets a `fs.write` grant name a cache directory that has not been created yet. It is
/// deliberately not the gate's resolution: the gate resolves the path it is about to open, so a
/// symlink created after the policy was read is still caught there.
pub fn canonicalize_as_far_as_possible(path: &Path) -> io::Result<PathBuf> {
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path is not absolute",
        ));
    }
    let mut existing = path.to_path_buf();
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match std::fs::canonicalize(&existing) {
            Ok(mut resolved) => {
                for part in rest.iter().rev() {
                    resolved.push(part);
                }
                return Ok(resolved);
            }
            Err(error) => {
                let Some(name) = existing.file_name().map(OsStr::to_os_string) else {
                    return Err(error);
                };
                let Some(parent) = existing.parent() else {
                    return Err(error);
                };
                if parent.as_os_str().is_empty() || parent == existing {
                    return Err(error);
                }
                rest.push(name);
                existing = parent.to_path_buf();
            }
        }
    }
}

/// Resolve one grant string against `base` (the policy file's directory or the working directory).
///
/// Relative values are joined to `base`; `..` is normalised lexically; the existing prefix is
/// canonicalised. A NUL and an empty value are rejected because neither can name a file.
pub fn resolve_grant(base: &Path, value: &str) -> Result<PathBuf, String> {
    if value.is_empty() {
        return Err("an empty path".to_owned());
    }
    if value.contains('\0') {
        return Err("a path containing NUL".to_owned());
    }
    let path = Path::new(value);
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    if !joined.is_absolute() {
        return Err(format!("'{value}' does not resolve from an absolute base"));
    }
    let normalized = normalize_lexical(&joined)
        .ok_or_else(|| format!("'{value}' does not resolve to an absolute path"))?;
    canonicalize_as_far_as_possible(&normalized).map_err(|error| format!("'{value}': {error}"))
}

/// A path prefix: the resolved target must equal the root or sit below it.
///
/// [`Path::starts_with`] compares components, so `/data` matches `/data/a` and not `/database`.
/// There is no case folding and no Unicode normalisation: an odd-case spelling of a granted path is
/// simply not granted (ADR-0011 §4.2).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct PathRule {
    root: PathBuf,
}

impl PathRule {
    pub fn new(root: PathBuf) -> Self {
        PathRule { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn matches(&self, resolved: &Path) -> bool {
        resolved.starts_with(&self.root)
    }
}

/// A host grant: a name, a `*.suffix` wildcard, a literal address, or "any local address" for a
/// `:port` listen grant.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostPattern {
    Any,
    Name(String),
    Wildcard(String),
    Ip(IpAddr),
}

impl HostPattern {
    /// Parse one host field. `allow_any` is true only for `net.listen`, where a leading `:` names
    /// every local address (ADR-0011 §5.3: `:port` is listen-only).
    pub fn parse(value: &str, allow_any: bool) -> Result<Self, String> {
        if value.is_empty() {
            return if allow_any {
                Ok(HostPattern::Any)
            } else {
                Err("an empty host".to_owned())
            };
        }
        if value.contains('\0')
            || value.chars().any(char::is_whitespace)
            || value.contains('/')
            || value.contains('\\')
        {
            return Err(format!("invalid host '{value}'"));
        }
        if let Some(suffix) = value.strip_prefix("*.") {
            let suffix = suffix.trim_end_matches('.');
            if suffix.is_empty() || suffix.contains('*') || suffix.contains(':') {
                return Err(format!("invalid host wildcard '{value}'"));
            }
            return Ok(HostPattern::Wildcard(suffix.to_ascii_lowercase()));
        }
        if value.contains('*') {
            return Err(format!(
                "'{value}': a wildcard is only allowed as a leading '*.'"
            ));
        }
        if let Ok(address) = value.parse::<IpAddr>() {
            return Ok(HostPattern::Ip(address));
        }
        let name = value.trim_end_matches('.');
        if name.is_empty() || name.contains(':') {
            return Err(format!("invalid host '{value}'"));
        }
        Ok(HostPattern::Name(name.to_ascii_lowercase()))
    }

    /// Does this pattern match the requested host name?
    pub fn matches_host(&self, host: &str) -> bool {
        match self {
            HostPattern::Any => true,
            HostPattern::Ip(_) => false,
            HostPattern::Name(name) => host.trim_end_matches('.').eq_ignore_ascii_case(name),
            HostPattern::Wildcard(suffix) => {
                let host = host.trim_end_matches('.').as_bytes();
                let suffix = suffix.as_bytes();
                // Need at least one label character, the separating dot, and the suffix.
                if host.len() < suffix.len() + 2 {
                    return false;
                }
                let tail = &host[host.len() - suffix.len()..];
                tail.eq_ignore_ascii_case(suffix) && host[host.len() - suffix.len() - 1] == b'.'
            }
        }
    }

    /// Does this pattern match a literal address? Only a literal grant can.
    pub fn matches_address(&self, address: &SocketAddr) -> bool {
        match self {
            HostPattern::Ip(expected) => address.ip() == *expected,
            _ => false,
        }
    }
}

/// A `net.connect` / `net.listen` grant: a host (or `:port`, listen only) and an optional port.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EndpointRule {
    host: HostPattern,
    port: Option<u16>,
}

impl EndpointRule {
    pub fn new(host: HostPattern, port: Option<u16>) -> Self {
        EndpointRule { host, port }
    }

    pub fn host(&self) -> &HostPattern {
        &self.host
    }

    pub fn port(&self) -> Option<u16> {
        self.port
    }

    /// The rule matches when the port is allowed and either the requested name matches a name
    /// grant or the resolved address matches a literal grant (ADR-0011 §5.3, D7 in the plan).
    /// Denied candidates are skipped by the caller; when every candidate is denied the run fails
    /// with the denial.
    pub fn matches(&self, host: Option<&str>, port: u16, address: Option<&SocketAddr>) -> bool {
        if let Some(expected) = self.port {
            if expected != port {
                return false;
            }
        }
        match &self.host {
            HostPattern::Any => true,
            HostPattern::Ip(_) => address.is_some_and(|address| self.host.matches_address(address)),
            HostPattern::Name(_) | HostPattern::Wildcard(_) => {
                host.is_some_and(|host| self.host.matches_host(host))
            }
        }
    }

    /// Whether a name-shaped rule of this endpoint covers `host`, ignoring the port. Used for the
    /// "a `net.connect` grant for a host implies `net.resolve`" rule.
    pub fn covers_host_name(&self, host: &str) -> bool {
        match &self.host {
            HostPattern::Name(_) | HostPattern::Wildcard(_) => self.host.matches_host(host),
            _ => false,
        }
    }
}

/// A `child.spawn` grant. A bare name matches any resolved executable with that basename; a value
/// containing a separator is canonicalised and must equal the resolved executable exactly.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExecRule {
    Basename(String),
    Path(PathBuf),
}

impl ExecRule {
    pub fn parse(value: &str, base: &Path) -> Result<Self, String> {
        if value.is_empty() {
            return Err("an empty executable".to_owned());
        }
        if value.contains('\0') {
            return Err("an executable containing NUL".to_owned());
        }
        if value.contains('/') || value.contains('\\') {
            Ok(ExecRule::Path(resolve_grant(base, value)?))
        } else {
            Ok(ExecRule::Basename(value.to_owned()))
        }
    }

    pub fn matches(&self, resolved: &Path) -> bool {
        match self {
            ExecRule::Basename(name) => resolved.file_name() == Some(OsStr::new(name)),
            ExecRule::Path(path) => resolved == path,
        }
    }
}

/// One allow-list entry. The variant is tied to the capability that accepts it: `fs` takes `Path`,
/// `net.connect`/`net.listen` take `UnixPath` or `Endpoint`, `net.resolve` takes `Host`,
/// `child.spawn` takes `Exec`, `env.read` takes `Name`, and the two toggles take `Any`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Rule {
    Any,
    Path(PathRule),
    UnixPath(PathRule),
    Endpoint(EndpointRule),
    Host(HostPattern),
    Exec(ExecRule),
    Name(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr, SocketAddrV4, SocketAddrV6};
    use tempfile::tempdir;

    fn path(value: &str) -> PathBuf {
        PathBuf::from(value)
    }

    #[test]
    fn lexical_normalisation_handles_dot_and_parent() {
        assert_eq!(
            normalize_lexical(&path("/data/a/../b")),
            Some(path("/data/b"))
        );
        assert_eq!(normalize_lexical(&path("/data/./a")), Some(path("/data/a")));
        assert_eq!(normalize_lexical(&path("/..")), Some(path("/")));
        assert_eq!(normalize_lexical(&path("../a")), None);
    }

    #[test]
    fn a_path_rule_matches_components_not_strings() {
        let rule = PathRule::new(path("/data"));
        assert!(rule.matches(&path("/data")));
        assert!(rule.matches(&path("/data/a")));
        assert!(rule.matches(&path("/data/a/b")));
        assert!(!rule.matches(&path("/database")));
        assert!(!rule.matches(&path("/Data")));
        assert!(!rule.matches(&path("/data2")));
    }

    #[test]
    fn a_root_grant_matches_every_absolute_path() {
        let rule = PathRule::new(path("/"));
        assert!(rule.matches(&path("/etc/passwd")));
    }

    #[test]
    fn granted_paths_are_canonicalised_as_far_as_they_exist() {
        let dir = tempdir().expect("tempdir");
        let base = std::fs::canonicalize(dir.path()).expect("canonical");
        let grant = resolve_grant(&base, "cache/not-created-yet").expect("grant");
        assert_eq!(grant, base.join("cache/not-created-yet"));
        let escaping = resolve_grant(&base, "../../etc").expect("grant");
        assert!(escaping.is_absolute());
    }

    #[test]
    fn host_names_are_case_insensitive_and_wildcards_exclude_the_apex() {
        let name = HostPattern::parse("API.Example.com", false).expect("name");
        assert!(name.matches_host("api.example.com"));
        assert!(!name.matches_host("api.example.com.evil"));

        let wildcard = HostPattern::parse("*.internal.example.com", false).expect("wildcard");
        assert!(wildcard.matches_host("a.internal.example.com"));
        assert!(wildcard.matches_host("a.b.internal.example.com"));
        assert!(!wildcard.matches_host("internal.example.com"));
        assert!(!wildcard.matches_host("a.internal.example.com.evil"));
        assert!(!wildcard.matches_host(""));
    }

    #[test]
    fn literal_hosts_match_addresses_only() {
        let literal = HostPattern::parse("127.0.0.1", false).expect("ip");
        assert!(
            literal.matches_address(&SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 443)))
        );
        assert!(!literal.matches_host("127.0.0.1"));

        let v6 = HostPattern::parse("::1", false).expect("ipv6");
        assert!(v6.matches_address(&SocketAddr::V6(SocketAddrV6::new(
            Ipv6Addr::LOCALHOST,
            80,
            0,
            0
        ))));
    }

    #[test]
    fn a_name_grant_matches_the_name_and_a_literal_grant_matches_the_address() {
        let address = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 443));
        let by_name = EndpointRule::new(
            HostPattern::parse("api.example.com", false).expect("name"),
            Some(443),
        );
        assert!(by_name.matches(Some("api.example.com"), 443, Some(&address)));
        assert!(by_name.matches(Some("api.example.com"), 443, None));
        assert!(!by_name.matches(Some("api.example.com"), 80, Some(&address)));

        let by_address = EndpointRule::new(
            HostPattern::parse("127.0.0.1", false).expect("ip"),
            Some(443),
        );
        assert!(by_address.matches(None, 443, Some(&address)));
        // A name that resolved to the granted literal is governed by the literal grant, and a
        // name that did not is not.
        assert!(by_address.matches(Some("metadata.invalid"), 443, Some(&address)));
        assert!(!by_address.matches(Some("metadata.invalid"), 443, None));
    }

    #[test]
    fn an_any_host_rule_is_port_only() {
        let rule = EndpointRule::new(HostPattern::Any, Some(8080));
        assert!(rule.matches(None, 8080, None));
        assert!(rule.matches(Some("anything"), 8080, None));
        assert!(!rule.matches(None, 8081, None));
    }

    #[test]
    fn an_exec_rule_matches_basename_or_absolute_path() {
        let dir = tempdir().expect("tempdir");
        let base = std::fs::canonicalize(dir.path()).expect("canonical");
        let basename = ExecRule::parse("git", &base).expect("basename");
        assert!(basename.matches(&path("/usr/bin/git")));
        assert!(!basename.matches(&path("/usr/bin/git2")));

        let full = ExecRule::parse("./bin/make", &base).expect("path");
        assert!(full.matches(&base.join("bin/make")));
        assert!(!full.matches(&base.join("bin/make2")));
    }
}
