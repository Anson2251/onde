//! `dns.lookup`: the OS resolver as an op, not a handle.
//!
//! `dns.lookup` is bounded work with exactly one result, so it stays an [`Op`](crate::Op)
//! (m4-plan §2.6): `Op::Lookup` runs on the blocking pool, where a synchronous `getaddrinfo` is
//! correct, and settles one `OpValue::Addrs`. `dns.resolve*` (which needs a DNS client, not the OS
//! resolver) stays out of M4.

use std::net::ToSocketAddrs;

use ln_error::NodeError;

use super::error::{not_found, resolve_error};
use super::{family_matches, Addr, IpFamily};
use crate::OpValue;

/// Resolve `host` for `dns.lookup(host, { family, all })`.
///
/// `all: false` returns the first matching address, like Node's default single-result form. The
/// returned [`Addr::Ip`] values carry port `0`: `dns.lookup` reports addresses, not endpoints, and
/// the JS layer attaches the port when it builds a connection target.
pub(crate) fn lookup(host: &str, family: IpFamily, all: bool) -> Result<OpValue, NodeError> {
    if host.is_empty() {
        return Err(not_found(host));
    }
    let resolved = (host, 0u16)
        .to_socket_addrs()
        .map_err(|error| resolve_error(host, &error))?;

    let mut addresses: Vec<Addr> = Vec::new();
    for address in resolved {
        if !family_matches(address.ip(), family) {
            continue;
        }
        addresses.push(Addr::Ip(address));
        if !all {
            break;
        }
    }
    if addresses.is_empty() {
        // The host resolved to addresses, but none of the requested family; Node reports
        // ENOTFOUND for that too.
        return Err(not_found(host));
    }
    Ok(OpValue::Addrs(addresses))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_host_is_enotfound_without_calling_the_resolver() {
        let error = lookup("", IpFamily::Either, false).expect_err("empty host");
        assert_eq!(error.code, "ENOTFOUND");
        assert_eq!(error.syscall, Some("getaddrinfo"));
    }
}
