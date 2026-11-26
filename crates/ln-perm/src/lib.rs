//! The opt-in permission policy for onde (ADR-0011).
//!
//! This crate is engine-free and tokio-free: it owns the *data* of a policy (the nine capabilities,
//! their allow-list rules, the parser and the matcher) and nothing that makes a syscall. `ln-io`
//! asks it about paths and endpoints it has already resolved, `ln-runtime` asks it about host
//! calls, and the CLI builds the same value from `--permission-file` or `--allow-*`.
//!
//! Two properties are deliberate:
//!
//! * **Allow-lists only.** A capability that lists nothing is denied. There is no `default` field
//!   and no deny-list, because a path deny-list cannot be right about case, normalisation and hard
//!   links and therefore fails open (ADR-0011 §4.2).
//! * **One value, two doors.** [`Policy::from_file`] and [`Policy::from_args`] produce the same
//!   type and go through the same matchers; the plugin-host case and the ad-hoc command line cannot
//!   drift into different security semantics.
//!
//! The matcher never canonicalises the target: the caller resolves the path or address immediately
//! before the syscall and passes the resolved value in, so what is checked is what is opened.

#![forbid(unsafe_code)]

mod capability;
mod parse;
mod policy;
mod rule;
mod spans;

pub use capability::Capability;
pub use parse::{GrantArgs, ParseError, MAX_POLICY_BYTES};
pub use policy::{Denial, Origin, Policy, Request};
pub use rule::{EndpointRule, ExecRule, HostPattern, PathRule, Rule};
