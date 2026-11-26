//! The policy value and the matcher over it.
//!
//! `Policy` is nine grants, one per [`Capability`]. There is deliberately no allow-all variant: a
//! policy whose grants are all [`Rule::Any`] permits everything, so a second representation would be
//! a second code path and a second answer to "is this policy permissive" (ADR-0011 §5.1). `None` in
//! `Config` means the model is absent; `--permission` alone is [`Policy::deny_all`].

use std::fmt;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use crate::capability::Capability;
use crate::rule::Rule;

/// Where a grant came from. A denial names the policy file and the capability's key line, or the
/// command line when the grant was a flag (ADR-0011 §5.7).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Origin {
    CommandLine,
    File { path: PathBuf, line: Option<u32> },
}

impl Origin {
    pub fn file(path: impl Into<PathBuf>) -> Self {
        Origin::File {
            path: path.into(),
            line: None,
        }
    }

    pub fn with_line(self, line: Option<u32>) -> Self {
        match self {
            Origin::File { path, .. } => Origin::File { path, line },
            other => other,
        }
    }

    pub fn path(&self) -> Option<&Path> {
        match self {
            Origin::CommandLine => None,
            Origin::File { path, .. } => Some(path),
        }
    }

    pub fn line(&self) -> Option<u32> {
        match self {
            Origin::CommandLine => None,
            Origin::File { line, .. } => *line,
        }
    }
}

impl fmt::Display for Origin {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Origin::CommandLine => formatter.write_str("<command line>"),
            Origin::File {
                path,
                line: Some(line),
            } => {
                write!(formatter, "{}:{}", path.display(), line)
            }
            Origin::File { path, line: None } => formatter.write_str(&path.display().to_string()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CapabilityGrant {
    origin: Origin,
    allow: Vec<Rule>,
}

/// One capability's resources. An empty allow-list denies; there is no deny-list and no `default`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    grants: [CapabilityGrant; Capability::COUNT],
}

impl Policy {
    /// No grants: what `--permission` alone installs.
    pub fn deny_all() -> Self {
        Self::with_origin(Origin::CommandLine)
    }

    /// Every capability's every resource: the allow-all value. It is a value, not a variant, and
    /// the fast path is a property of the data (`Rule::Any` passes in O(1)).
    pub fn any() -> Self {
        Policy {
            grants: std::array::from_fn(|_| CapabilityGrant {
                origin: Origin::CommandLine,
                allow: vec![Rule::Any],
            }),
        }
    }

    pub(crate) fn with_origin(origin: Origin) -> Self {
        Policy {
            grants: std::array::from_fn(|_| CapabilityGrant {
                origin: origin.clone(),
                allow: Vec::new(),
            }),
        }
    }

    /// Add one rule and remember the origin it came from.
    pub fn grant(&mut self, capability: Capability, rule: Rule, origin: Origin) {
        let grant = &mut self.grants[capability.index()];
        grant.origin = origin;
        grant.allow.push(rule);
    }

    /// Set the origin without adding a rule. Used for a capability that is present in the file with
    /// an empty array, so a denial still cites its key line.
    pub(crate) fn set_origin(&mut self, capability: Capability, origin: Origin) {
        self.grants[capability.index()].origin = origin;
    }

    pub(crate) fn add_rule(&mut self, capability: Capability, rule: Rule) {
        self.grants[capability.index()].allow.push(rule);
    }

    pub fn rules(&self, capability: Capability) -> &[Rule] {
        &self.grants[capability.index()].allow
    }

    /// Whether the capability has any grant at all. `process.kill` uses this: a child process is
    /// authority over processes, so any `child.spawn` grant covers a signal (ADR-0011 §5.3).
    pub fn grants_anything(&self, capability: Capability) -> bool {
        !self.grants[capability.index()].allow.is_empty()
    }

    pub fn origin(&self, capability: Capability) -> &Origin {
        &self.grants[capability.index()].origin
    }

    /// Check one request. `Ok(())` means allowed; the caller turns [`Denial`] into
    /// `ERR_ACCESS_DENIED`.
    pub fn check(&self, request: &Request<'_>) -> Result<(), Denial> {
        let allowed = match request {
            Request::Path {
                capability,
                resolved,
            } => self.any_rule(*capability, |rule| match rule {
                Rule::Path(path) => path.matches(resolved),
                Rule::Any => true,
                _ => false,
            }),
            Request::Unix {
                capability,
                resolved,
            } => self.any_rule(*capability, |rule| match rule {
                Rule::UnixPath(path) => path.matches(resolved),
                Rule::Any => true,
                _ => false,
            }),
            Request::Endpoint {
                capability,
                host,
                port,
                address,
            } => self.any_rule(*capability, |rule| match rule {
                Rule::Endpoint(endpoint) => endpoint.matches(*host, *port, *address),
                Rule::Any => true,
                _ => false,
            }),
            Request::Host { host } => {
                self.any_rule(Capability::NetResolve, |rule| match rule {
                    Rule::Host(pattern) => pattern.matches_host(host),
                    Rule::Any => true,
                    _ => false,
                }) || self.any_rule(Capability::NetConnect, |rule| match rule {
                    // A connect grant for a host implies resolve for it (ADR-0011 §5.3).
                    Rule::Endpoint(endpoint) => endpoint.covers_host_name(host),
                    Rule::Any => true,
                    _ => false,
                }) || self.any_rule(Capability::NetListen, |rule| match rule {
                    // D7: a listen grant for a name likewise implies resolving the bind host.
                    Rule::Endpoint(endpoint) => endpoint.covers_host_name(host),
                    Rule::Any => true,
                    _ => false,
                })
            }
            Request::Executable { resolved } => {
                self.any_rule(Capability::ChildSpawn, |rule| match rule {
                    Rule::Exec(exec) => exec.matches(resolved),
                    Rule::Any => true,
                    _ => false,
                })
            }
            Request::Env { name } => self.any_rule(Capability::EnvRead, |rule| match rule {
                Rule::Name(granted) => granted == name,
                Rule::Any => true,
                _ => false,
            }),
            Request::Toggle { capability } | Request::AnyGrant { capability } => {
                self.grants_anything(*capability)
            }
        };

        if allowed {
            Ok(())
        } else {
            let capability = request.capability();
            Err(Denial {
                capability,
                resource: request.resource(),
                origin: self.grants[capability.index()].origin.clone(),
            })
        }
    }

    fn any_rule(&self, capability: Capability, predicate: impl Fn(&Rule) -> bool) -> bool {
        self.grants[capability.index()].allow.iter().any(predicate)
    }
}

/// One question for the matcher. Paths and addresses are already resolved by the caller; this type
/// never touches the filesystem.
#[derive(Clone, Copy, Debug)]
pub enum Request<'a> {
    /// A filesystem path for `fs.read` or `fs.write`.
    Path {
        capability: Capability,
        resolved: &'a Path,
    },
    /// A Unix-domain socket path, under `net.connect` or `net.listen`, never `fs`.
    Unix {
        capability: Capability,
        resolved: &'a Path,
    },
    /// One candidate endpoint, after resolution. `host` is the requested name (if any); `address`
    /// is the resolved candidate the caller is about to connect to or bind.
    Endpoint {
        capability: Capability,
        host: Option<&'a str>,
        port: u16,
        address: Option<&'a SocketAddr>,
    },
    /// A name about to be resolved, for `net.resolve`.
    Host { host: &'a str },
    /// A resolved executable, for `child.spawn`.
    Executable { resolved: &'a Path },
    /// An environment variable name, for `env.read`.
    Env { name: &'a str },
    /// A boolean capability: `worker.spawn`, `ffi.load`.
    Toggle { capability: Capability },
    /// Any grant of a capability counts, with no resource to match; `process.kill` under
    /// `child.spawn`.
    AnyGrant { capability: Capability },
}

impl Request<'_> {
    pub fn capability(&self) -> Capability {
        match self {
            Request::Path { capability, .. }
            | Request::Unix { capability, .. }
            | Request::Endpoint { capability, .. }
            | Request::Toggle { capability }
            | Request::AnyGrant { capability } => *capability,
            Request::Host { .. } => Capability::NetResolve,
            Request::Executable { .. } => Capability::ChildSpawn,
            Request::Env { .. } => Capability::EnvRead,
        }
    }

    fn resource(&self) -> String {
        match self {
            Request::Path { resolved, .. }
            | Request::Unix { resolved, .. }
            | Request::Executable { resolved } => resolved.display().to_string(),
            Request::Endpoint {
                host,
                port,
                address,
                ..
            } => {
                if let Some(host) = host {
                    format_host_port(host, *port)
                } else if let Some(address) = address {
                    address.to_string()
                } else {
                    format!("*:{port}")
                }
            }
            Request::Host { host } => (*host).to_owned(),
            Request::Env { name } => (*name).to_owned(),
            Request::Toggle { .. } | Request::AnyGrant { .. } => "*".to_owned(),
        }
    }
}

fn format_host_port(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// A refused request: the capability, the resource, and the grant that would have covered it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Denial {
    pub capability: Capability,
    pub resource: String,
    pub origin: Origin,
}

impl Denial {
    /// `fs.read is denied for '/etc/passwd' by ./ci.json:4`. The runtime prefixes
    /// `ERR_ACCESS_DENIED: `.
    pub fn message(&self) -> String {
        if self.resource == "*" {
            format!("{} is denied by {}", self.capability, self.origin)
        } else {
            format!(
                "{} is denied for '{}' by {}",
                self.capability, self.resource, self.origin
            )
        }
    }
}

impl fmt::Display for Denial {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message())
    }
}

impl std::error::Error for Denial {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rule::{EndpointRule, ExecRule, HostPattern, PathRule};
    use std::net::{Ipv4Addr, SocketAddrV4};

    fn path(value: &str) -> PathBuf {
        PathBuf::from(value)
    }

    fn path_policy() -> Policy {
        let mut policy = Policy::deny_all();
        policy.grant(
            Capability::FsRead,
            Rule::Path(PathRule::new(path("/data"))),
            Origin::file("/etc/onde/ci.json").with_line(Some(4)),
        );
        policy
    }

    #[test]
    fn deny_all_denies_everything_and_any_allows_everything() {
        let denied = Policy::deny_all();
        assert!(denied
            .check(&Request::Path {
                capability: Capability::FsRead,
                resolved: &path("/etc/passwd"),
            })
            .is_err());
        assert!(denied
            .check(&Request::Toggle {
                capability: Capability::WorkerSpawn,
            })
            .is_err());

        let any = Policy::any();
        assert!(any
            .check(&Request::Path {
                capability: Capability::FsWrite,
                resolved: &path("/etc/passwd"),
            })
            .is_ok());
        assert!(any.check(&Request::Env { name: "SECRET" }).is_ok());
    }

    #[test]
    fn read_and_write_are_separate_and_write_does_not_imply_read() {
        let policy = path_policy();
        assert!(policy
            .check(&Request::Path {
                capability: Capability::FsRead,
                resolved: &path("/data/a"),
            })
            .is_ok());
        assert!(policy
            .check(&Request::Path {
                capability: Capability::FsWrite,
                resolved: &path("/data/a"),
            })
            .is_err());
    }

    #[test]
    fn a_denied_path_reports_the_capability_resource_and_grant_origin() {
        let denial = path_policy()
            .check(&Request::Path {
                capability: Capability::FsRead,
                resolved: &path("/etc/passwd"),
            })
            .expect_err("denied");
        assert_eq!(denial.capability, Capability::FsRead);
        assert_eq!(denial.resource, "/etc/passwd");
        assert_eq!(
            denial.message(),
            "fs.read is denied for '/etc/passwd' by /etc/onde/ci.json:4"
        );
    }

    #[test]
    fn an_absurd_spelling_of_a_granted_path_is_not_granted() {
        let denial = path_policy()
            .check(&Request::Path {
                capability: Capability::FsRead,
                resolved: &path("/DATA/a"),
            })
            .expect_err("case-sensitive");
        assert_eq!(denial.resource, "/DATA/a");
    }

    #[test]
    fn endpoints_use_the_name_or_the_address() {
        let address = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 443));
        let mut policy = Policy::deny_all();
        policy.grant(
            Capability::NetConnect,
            Rule::Endpoint(EndpointRule::new(
                HostPattern::parse("api.example.com", false).expect("name"),
                Some(443),
            )),
            Origin::CommandLine,
        );
        assert!(policy
            .check(&Request::Endpoint {
                capability: Capability::NetConnect,
                host: Some("api.example.com"),
                port: 443,
                address: Some(&address),
            })
            .is_ok());
        // Name grant means the name; connect still implies resolve for it.
        assert!(policy
            .check(&Request::Host {
                host: "api.example.com"
            })
            .is_ok());
        assert!(policy
            .check(&Request::Host {
                host: "169.254.169.254"
            })
            .is_err());
    }

    #[test]
    fn a_listen_name_grant_implies_resolve() {
        let mut policy = Policy::deny_all();
        policy.grant(
            Capability::NetListen,
            Rule::Endpoint(EndpointRule::new(
                HostPattern::parse("db.internal", false).expect("name"),
                Some(5432),
            )),
            Origin::CommandLine,
        );
        assert!(policy
            .check(&Request::Host {
                host: "db.internal"
            })
            .is_ok());
        assert!(policy
            .check(&Request::Host {
                host: "other.internal"
            })
            .is_err());
    }

    #[test]
    fn a_literal_grant_covers_a_name_that_resolved_to_it() {
        let metadata = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(169, 254, 169, 254), 80));
        let mut policy = Policy::deny_all();
        policy.grant(
            Capability::NetConnect,
            Rule::Endpoint(EndpointRule::new(
                HostPattern::parse("169.254.169.254", false).expect("ip"),
                None,
            )),
            Origin::CommandLine,
        );
        assert!(policy
            .check(&Request::Endpoint {
                capability: Capability::NetConnect,
                host: Some("metadata.invalid"),
                port: 80,
                address: Some(&metadata),
            })
            .is_ok());
        // A literal grant does not imply resolve: the caller resolves the name first, and the
        // address it gets is what the connect check sees.
        assert!(policy
            .check(&Request::Host {
                host: "metadata.invalid"
            })
            .is_err());
    }

    #[test]
    fn exec_env_and_toggles_match_their_own_shapes() {
        let mut policy = Policy::deny_all();
        policy.grant(
            Capability::ChildSpawn,
            Rule::Exec(ExecRule::Basename("git".to_owned())),
            Origin::CommandLine,
        );
        policy.grant(
            Capability::EnvRead,
            Rule::Name("PORT".to_owned()),
            Origin::CommandLine,
        );
        policy.grant(Capability::WorkerSpawn, Rule::Any, Origin::CommandLine);

        assert!(policy
            .check(&Request::Executable {
                resolved: &path("/usr/bin/git")
            })
            .is_ok());
        assert!(policy
            .check(&Request::Executable {
                resolved: &path("/usr/bin/make")
            })
            .is_err());
        assert!(policy.check(&Request::Env { name: "PORT" }).is_ok());
        assert!(policy.check(&Request::Env { name: "PORTA" }).is_err());
        assert!(policy
            .check(&Request::Toggle {
                capability: Capability::WorkerSpawn
            })
            .is_ok());
        assert!(policy
            .check(&Request::Toggle {
                capability: Capability::FfiLoad
            })
            .is_err());
        // process.kill: any child.spawn grant counts.
        assert!(policy
            .check(&Request::AnyGrant {
                capability: Capability::ChildSpawn
            })
            .is_ok());
    }

    #[test]
    fn a_toggle_denial_has_no_resource() {
        let denial = Policy::deny_all()
            .check(&Request::Toggle {
                capability: Capability::FfiLoad,
            })
            .expect_err("denied");
        assert_eq!(denial.message(), "ffi.load is denied by <command line>");
    }
}
