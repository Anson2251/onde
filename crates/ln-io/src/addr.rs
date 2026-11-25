//! Addresses and address families, independent of the `net` feature.
//!
//! `dns.lookup` is an op, not a handle, and stays available in a build without the network
//! transports: it reports addresses through [`Addr`]/[`IpFamily`], so those live here rather
//! than in `net`. `net` re-exports them, so `ln_io::net::{Addr, IpFamily}` keeps working when
//! the feature is on.

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;

/// Address family requested by the JS layer (`net.connect({ family })`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum IpFamily {
    V4,
    V6,
    #[default]
    Either,
}

/// A bound or connected endpoint, as `server.address()` / `socket.address()` report it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Addr {
    Ip(SocketAddr),
    Unix(PathBuf),
}

impl Addr {
    /// Node's `family` string: `"IPv4"`, `"IPv6"` or `"unix"`.
    pub fn family(&self) -> &'static str {
        match self {
            Addr::Ip(address) if address.is_ipv4() => "IPv4",
            Addr::Ip(_) => "IPv6",
            Addr::Unix(_) => "unix",
        }
    }

    /// The port; Unix sockets have none, so `0`.
    pub fn port(&self) -> u16 {
        match self {
            Addr::Ip(address) => address.port(),
            Addr::Unix(_) => 0,
        }
    }

    pub fn ip(&self) -> Option<IpAddr> {
        match self {
            Addr::Ip(address) => Some(address.ip()),
            Addr::Unix(_) => None,
        }
    }
}

impl From<SocketAddr> for Addr {
    fn from(address: SocketAddr) -> Self {
        Addr::Ip(address)
    }
}

/// Address-family filter shared by `net.connect({ family })`, `server.listen` and
/// `dns.lookup({ family })`: `Either` accepts both, the others keep one family only.
pub(crate) fn family_matches(address: IpAddr, family: IpFamily) -> bool {
    match family {
        IpFamily::Either => true,
        IpFamily::V4 => address.is_ipv4(),
        IpFamily::V6 => address.is_ipv6(),
    }
}
