//! The nine capability ids (ADR-0011 §3).
//!
//! One id per authority, spelled the same in the policy file, on the command line and in
//! `process.permission.has`. The two surfaces that name a nested file key still map to the same id:
//! `"child_process": { "spawn": [...] }` and `--allow-child-process` are both
//! [`Capability::ChildSpawn`], whose id is `child.spawn`.

/// One authority a policy can grant. The order is the storage order in [`crate::Policy`] and must
/// stay in sync with [`Capability::ALL`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[repr(usize)]
pub enum Capability {
    FsRead,
    FsWrite,
    NetConnect,
    NetListen,
    NetResolve,
    ChildSpawn,
    WorkerSpawn,
    EnvRead,
    FfiLoad,
}

impl Capability {
    /// Number of capabilities. The policy stores one grant per id.
    pub const COUNT: usize = 9;

    /// Every capability, in storage order.
    pub const ALL: [Capability; Self::COUNT] = [
        Capability::FsRead,
        Capability::FsWrite,
        Capability::NetConnect,
        Capability::NetListen,
        Capability::NetResolve,
        Capability::ChildSpawn,
        Capability::WorkerSpawn,
        Capability::EnvRead,
        Capability::FfiLoad,
    ];

    /// The public spelling: `fs.read`, `net.listen`, `child.spawn`, ...
    pub const fn id(self) -> &'static str {
        match self {
            Capability::FsRead => "fs.read",
            Capability::FsWrite => "fs.write",
            Capability::NetConnect => "net.connect",
            Capability::NetListen => "net.listen",
            Capability::NetResolve => "net.resolve",
            Capability::ChildSpawn => "child.spawn",
            Capability::WorkerSpawn => "worker.spawn",
            Capability::EnvRead => "env.read",
            Capability::FfiLoad => "ffi.load",
        }
    }

    /// The index into the policy's grant array.
    pub const fn index(self) -> usize {
        self as usize
    }

    /// The two capabilities whose policy file value is a boolean rather than an array.
    pub const fn is_toggle(self) -> bool {
        matches!(self, Capability::WorkerSpawn | Capability::FfiLoad)
    }

    /// Parse a public id. Unlike `process.permission.has`, this is strict: the two Node aliases
    /// (`child`, `worker`) are the runtime's job, not the policy grammar's.
    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|capability| capability.id() == id)
    }
}

impl std::fmt::Display for Capability {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.id())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn every_id_is_unique_and_round_trips() {
        let mut ids = HashSet::new();
        for (index, capability) in Capability::ALL.iter().copied().enumerate() {
            assert_eq!(capability.index(), index);
            assert!(ids.insert(capability.id()));
            assert_eq!(Capability::from_id(capability.id()), Some(capability));
        }
        assert_eq!(ids.len(), Capability::COUNT);
        assert_eq!(Capability::from_id("child"), None);
        assert_eq!(Capability::from_id("fs"), None);
    }

    #[test]
    fn only_the_two_booleans_are_toggles() {
        let toggles: Vec<_> = Capability::ALL
            .iter()
            .copied()
            .filter(|capability| capability.is_toggle())
            .collect();
        assert_eq!(toggles, vec![Capability::WorkerSpawn, Capability::FfiLoad]);
    }
}
