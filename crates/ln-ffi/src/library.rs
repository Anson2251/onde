//! `dlopen` handles, symbol lookup and the per-symbol plan cache.
//!
//! A [`Library`] is one `libloading::Library` plus the declarations JavaScript gave at `dlopen`
//! time. Symbol addresses are resolved lazily and cached; a closed handle is simply dropped, and
//! the host never calls into it again because the JavaScript object carries the closed flag.
//!
//! The plan cache is the "guess once" rule of §4.5: each symbol keeps at most four distinct
//! argument/return shapes, and a fifth is an immediate error instead of a silent wrong call.

use std::collections::HashMap;
use std::ffi::{c_void, CStr};
use std::rc::Rc;

use crate::call::{prepare, Plan};
use crate::error::{Error, Result};
use crate::types::TypeTable;

/// One `dlopen` declaration.
#[derive(Clone, Debug)]
pub struct Declaration {
    pub arg_ids: Vec<u32>,
    pub ret_id: u32,
    /// True when the declared `args` are only the fixed prefix.
    pub varargs: bool,
}

/// The image a resolved address belongs to, from `dladdr`.
fn image_path(address: usize) -> Option<String> {
    let mut info: libc::Dl_info = unsafe { std::mem::zeroed() };
    let resolved = unsafe { libc::dladdr(address as *const c_void, &mut info) };
    if resolved == 0 || info.dli_fname.is_null() {
        return None;
    }
    Some(
        unsafe { CStr::from_ptr(info.dli_fname) }
            .to_string_lossy()
            .into_owned(),
    )
}

/// One library loaded by this isolate.
pub struct Library {
    path: String,
    /// The canonical path, for comparing against a deallocator's `dladdr` name.
    canonical: Option<String>,
    lib: libloading::Library,
    symbols: HashMap<String, usize>,
    declarations: HashMap<String, Declaration>,
    /// symbol -> plans. At most [`MAX_PLANS_PER_SYMBOL`] entries per symbol. The `Rc` lets the
    /// host drop its library borrow before calling: a callback may re-enter FFI, and a borrow
    /// held across `ffi_call` would deadlock (or worse, panic) on the reentry.
    plans: HashMap<String, Vec<PlanEntry>>,
}

struct PlanEntry {
    shape: String,
    ret_id: u32,
    plan: Rc<Plan>,
}

/// §4.5: at most four inferred plans per symbol.
pub const MAX_PLANS_PER_SYMBOL: usize = 4;

impl Library {
    /// Open a shared library.
    ///
    /// The path is passed to the platform loader unchanged: a bare name uses the loader's own
    /// search path (`libc.dylib`, `libz.so.1`), an absolute path is opened directly.
    pub fn open(path: &str) -> Result<Library> {
        if path.as_bytes().contains(&0) {
            return Err(Error::dlopen(
                "the library path contains a NUL byte".to_owned(),
            ));
        }
        // SAFETY: `libloading` owns the mapping and unloads it on drop; no symbol outlives the
        // `Library` because the host drops plans and symbols with it.
        let lib = unsafe { libloading::Library::new(path) }
            .map_err(|error| Error::dlopen(format!("dlopen({path}) failed: {error}")))?;
        Ok(Library {
            path: path.to_owned(),
            canonical: std::fs::canonicalize(path)
                .ok()
                .and_then(|path| path.to_str().map(str::to_owned)),
            lib,
            symbols: HashMap::new(),
            declarations: HashMap::new(),
            plans: HashMap::new(),
        })
    }

    pub fn path(&self) -> &str {
        &self.path
    }

    pub fn canonical_path(&self) -> Option<&str> {
        self.canonical.as_deref()
    }

    /// Resolve a symbol once and cache its address.
    pub fn address_of(&mut self, name: &str) -> Result<usize> {
        if let Some(address) = self.symbols.get(name) {
            return Ok(*address);
        }
        if name.as_bytes().contains(&0) {
            return Err(Error::symbol_not_found(name));
        }
        let bytes = name.as_bytes();
        // SAFETY: `get` copies nothing; the returned symbol is a `*mut c_void` value, not a
        // reference we keep. The address is valid while this `Library` is alive.
        let address = unsafe {
            match self.lib.get::<*mut std::ffi::c_void>(bytes) {
                Ok(symbol) => *symbol as usize,
                Err(_) => return Err(Error::symbol_not_found(name)),
            }
        };
        self.symbols.insert(name.to_owned(), address);
        // A bare name (`libc.dylib`) is not a path, so `canonicalize` at open time cannot resolve
        // it. `dladdr` on any resolved symbol gives the loaded image's real path instead, which is
        // what the host compares a deallocator against for `close()`'s live-reference rule.
        if self.canonical.is_none() {
            if let Some(image) = image_path(address) {
                self.canonical = std::fs::canonicalize(&image)
                    .ok()
                    .and_then(|path| path.to_str().map(str::to_owned))
                    .or(Some(image));
            }
        }
        Ok(address)
    }

    pub fn declare(&mut self, name: &str, declaration: Declaration) {
        self.declarations.insert(name.to_owned(), declaration);
    }

    pub fn declaration(&self, name: &str) -> Option<&Declaration> {
        self.declarations.get(name)
    }

    /// Return a prepared plan for this symbol, preparing and caching one on first use.
    ///
    /// `shape` is the JavaScript-computed argument shape (`"cstring,ptr,i32"`) and the return id
    /// is folded into the key, so a symbol called with the same kinds of values does not rebuild
    /// its `ffi_cif`.
    pub fn plan(
        &mut self,
        table: &TypeTable,
        symbol: &str,
        arg_ids: &[u32],
        ret_id: u32,
        varargs: Option<usize>,
        shape: &str,
    ) -> Result<Rc<Plan>> {
        // Hot path: no allocation when the plan is already cached (the normal case).
        if let Some(entry) = self.plans.get(symbol) {
            if let Some(existing) = entry
                .iter()
                .find(|entry| entry.shape == shape && entry.ret_id == ret_id)
            {
                return Ok(existing.plan.clone());
            }
        }
        let entry_count = self.plans.get(symbol).map_or(0, Vec::len);
        if entry_count >= MAX_PLANS_PER_SYMBOL {
            return Err(Error::fault(
                "ERR_FFI_SHAPE_LIMIT",
                format!(
                    "symbol `{symbol}` was called with more than {MAX_PLANS_PER_SYMBOL} argument \
                     shapes; declare its signature at dlopen"
                ),
            ));
        }
        let plan = Rc::new(prepare(table, arg_ids, ret_id, varargs)?);
        self.plans
            .entry(symbol.to_owned())
            .or_default()
            .push(PlanEntry {
                shape: shape.to_owned(),
                ret_id,
                plan: plan.clone(),
            });
        Ok(plan)
    }
}
