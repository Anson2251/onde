//! The id→state table for `host.crypto`.
//!
//! `ln-crypto` is stateless (see its crate docs); JavaScript holds an opaque numeric handle for a
//! streaming hash or HMAC, and this table maps that handle to the Rust state. Everything here
//! runs on the isolate thread, so no locking is needed beyond the surrounding `RefCell`.

use std::collections::HashMap;

use ln_crypto::{Algorithm, Hash, Hmac};
use ln_error::NodeError;

enum Entry {
    Hash(Hash),
    Hmac(Hmac),
}

/// Hash/HMAC states alive in one isolate.
#[derive(Default)]
pub(crate) struct CryptoState {
    next_id: u64,
    states: HashMap<u64, Entry>,
}

impl CryptoState {
    pub(crate) fn new() -> Self {
        CryptoState {
            // 0 is reserved for "no state", so handles start at 1.
            next_id: 1,
            states: HashMap::new(),
        }
    }

    pub(crate) fn hash_new(&mut self, algorithm: Algorithm) -> u64 {
        let id = self.allocate();
        self.states.insert(id, Entry::Hash(Hash::new(algorithm)));
        id
    }

    pub(crate) fn hash_update(&mut self, id: u64, data: &[u8]) -> Result<(), NodeError> {
        match self.states.get_mut(&id) {
            Some(Entry::Hash(hash)) => {
                hash.update(data);
                Ok(())
            }
            _ => Err(finalized()),
        }
    }

    /// Consume the state and return the digest.
    pub(crate) fn hash_digest(&mut self, id: u64) -> Result<Vec<u8>, NodeError> {
        match self.states.remove(&id) {
            Some(Entry::Hash(hash)) => Ok(hash.finish()),
            Some(other) => {
                // Put the Hmac back: it was not the state the caller asked to finish.
                self.states.insert(id, other);
                Err(finalized())
            }
            None => Err(finalized()),
        }
    }

    /// Snapshot the state under a new handle (Node's `hash.copy()`).
    pub(crate) fn hash_copy(&mut self, id: u64) -> Result<u64, NodeError> {
        let copy = match self.states.get(&id) {
            Some(Entry::Hash(hash)) => hash.copy(),
            _ => return Err(finalized()),
        };
        let new_id = self.allocate();
        self.states.insert(new_id, Entry::Hash(copy));
        Ok(new_id)
    }

    pub(crate) fn hmac_new(&mut self, algorithm: Algorithm, key: &[u8]) -> u64 {
        let id = self.allocate();
        self.states
            .insert(id, Entry::Hmac(Hmac::new(algorithm, key)));
        id
    }

    pub(crate) fn hmac_update(&mut self, id: u64, data: &[u8]) -> Result<(), NodeError> {
        match self.states.get_mut(&id) {
            Some(Entry::Hmac(hmac)) => {
                hmac.update(data);
                Ok(())
            }
            _ => Err(finalized()),
        }
    }

    pub(crate) fn hmac_digest(&mut self, id: u64) -> Result<Vec<u8>, NodeError> {
        match self.states.remove(&id) {
            Some(Entry::Hmac(hmac)) => Ok(hmac.finish()),
            Some(other) => {
                self.states.insert(id, other);
                Err(finalized())
            }
            None => Err(finalized()),
        }
    }

    fn allocate(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id = id.saturating_add(1);
        id
    }
}

/// Node's message for `update`/`digest`/`copy` on a finished (or unknown) handle.
fn finalized() -> NodeError {
    NodeError::new("ERR_CRYPTO_HASH_FINALIZED", "Digest already called")
}

/// Resolve a digest name, producing Node's argument error for an unknown algorithm.
pub(crate) fn algorithm(name: &str) -> Result<Algorithm, NodeError> {
    Algorithm::from_name(name).ok_or_else(|| {
        NodeError::invalid_arg_value("algorithm", name, "is not a supported digest algorithm")
    })
}
