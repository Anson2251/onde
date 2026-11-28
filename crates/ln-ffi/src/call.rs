//! Call plans and argument/return marshalling.
//!
//! A [`Plan`] is one prepared `ffi_cif` plus the type entries it points at. It is immutable after
//! [`prepare`], which is what lets the plan cache reuse it for every call with the same shape.
//! Everything the ABI needs is here; the JavaScript layer decides *which* plan to use.

use std::ffi::{c_void, CStr};
use std::sync::Arc;

use crate::error::{Error, Result};
use crate::raw;
use crate::types::{read_in, write_in, Type, TypeEntry, TypeTable, Value};

/// One prepared call frame.
pub struct Plan {
    cif: Box<raw::ffi_cif>,
    /// `cif.arg_types` points into this Vec; it must stay put for the plan's lifetime.
    #[allow(dead_code)]
    arg_ptrs: Vec<*mut raw::ffi_type>,
    arg_entries: Vec<Arc<TypeEntry>>,
    ret_entry: Arc<TypeEntry>,
    pub arg_ids: Vec<u32>,
    pub ret_id: u32,
    pub varargs_fixed: Option<usize>,
}

impl Plan {
    pub fn ret_type(&self) -> &Type {
        &self.ret_entry.ty
    }

    pub fn arg_count(&self) -> usize {
        self.arg_entries.len()
    }

    /// The argument entries a fast path converts against, without a registry lookup.
    pub fn arg_entries(&self) -> &[Arc<TypeEntry>] {
        &self.arg_entries
    }

    /// The return entry, kept for the same reason.
    pub fn ret_entry(&self) -> &Arc<TypeEntry> {
        &self.ret_entry
    }
}

/// Build a plan, refusing layouts the ABI cannot carry.
///
/// `varargs` is `Some(n)` for `ffi_prep_cif_var`, where `n` is the number of fixed arguments. The
/// types passed for the variadic tail must already be default-promoted by the caller (JavaScript
/// does it when it builds the plan; libffi does not promote for us).
pub fn prepare(
    table: &TypeTable,
    arg_ids: &[u32],
    ret_id: u32,
    varargs: Option<usize>,
) -> Result<Plan> {
    let ret_entry = table.get(ret_id)?;
    if let Type::Array { .. } = ret_entry.ty {
        return Err(Error::unsupported_layout(
            "an array cannot be returned by value; return a pointer to one".to_owned(),
        ));
    }
    if contains_inline_array(table, &ret_entry)? {
        return Err(Error::unsupported_layout(
            "a by-value struct containing an inline array cannot be returned in v1".to_owned(),
        ));
    }

    let mut arg_entries = Vec::with_capacity(arg_ids.len());
    for id in arg_ids {
        let entry = table.get(*id)?;
        if matches!(entry.ty, Type::Void) {
            return Err(Error::signature_conflict(
                "a void argument cannot be passed; use void* for an absent pointer".to_owned(),
            ));
        }
        if let Type::Array { .. } = entry.ty {
            return Err(Error::unsupported_layout(
                "an array cannot be an argument by value; pass a pointer to one".to_owned(),
            ));
        }
        if contains_inline_array(table, &entry)? {
            return Err(Error::unsupported_layout(
                "a by-value struct containing an inline array cannot be passed in v1; pass a pointer"
                    .to_owned(),
            ));
        }
        arg_entries.push(entry);
    }

    let mut arg_ptrs: Vec<*mut raw::ffi_type> =
        arg_entries.iter().map(|entry| entry.raw_ptr()).collect();
    let rtype = ret_entry.raw_ptr();

    // Zeroed: `ffi_cif` contains a raw `arg_types` pointer and, on macOS arm64, the variadic
    // fixed-argument count that libffi fills in.
    let mut cif: Box<raw::ffi_cif> =
        Box::new(unsafe { std::mem::MaybeUninit::<raw::ffi_cif>::zeroed().assume_init() });

    let status = unsafe {
        match varargs {
            Some(fixed) => {
                if fixed == 0 || fixed > arg_ptrs.len() {
                    return Err(Error::signature_conflict(format!(
                        "a variadic call needs 1..={} fixed arguments, got {fixed}",
                        arg_ptrs.len()
                    )));
                }
                raw::ffi_prep_cif_var(
                    &mut *cif,
                    raw::FFI_DEFAULT_ABI,
                    fixed as u32,
                    arg_ptrs.len() as u32,
                    rtype,
                    arg_ptrs.as_mut_ptr(),
                )
            }
            None => raw::ffi_prep_cif(
                &mut *cif,
                raw::FFI_DEFAULT_ABI,
                arg_ptrs.len() as u32,
                rtype,
                arg_ptrs.as_mut_ptr(),
            ),
        }
    };
    if status != raw::FFI_OK {
        return Err(Error::signature_conflict(format!(
            "libffi refused the call frame ({}); check the argument and return types",
            status_name(status)
        )));
    }

    Ok(Plan {
        cif,
        arg_ptrs,
        arg_entries,
        ret_entry,
        arg_ids: arg_ids.to_vec(),
        ret_id,
        varargs_fixed: varargs,
    })
}

fn status_name(status: i32) -> &'static str {
    match status {
        raw::FFI_BAD_TYPEDEF => "FFI_BAD_TYPEDEF",
        raw::FFI_BAD_ABI => "FFI_BAD_ABI",
        raw::FFI_BAD_ARGTYPE => "FFI_BAD_ARGTYPE",
        _ => "FFI error",
    }
}

/// Whether a value of this type holds an inline array anywhere inside.
pub fn contains_inline_array(table: &TypeTable, entry: &TypeEntry) -> Result<bool> {
    match &entry.ty {
        Type::Array { .. } => Ok(true),
        Type::Struct(_) => {
            let Some(ids) = entry.field_ids() else {
                return Ok(false);
            };
            for id in ids {
                let field = table.get(*id)?;
                if contains_inline_array(table, &field)? {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        _ => Ok(false),
    }
}

/// Call `address` through `plan` and return the decoded result and the `errno` observed
/// immediately after the call.
pub fn invoke(
    plan: &Plan,
    table: &TypeTable,
    address: usize,
    args: &[Value],
) -> Result<(Value, i32)> {
    if args.len() != plan.arg_entries.len() {
        return Err(Error::signature_conflict(format!(
            "the plan takes {} arguments, got {}",
            plan.arg_entries.len(),
            args.len()
        )));
    }
    if address == 0 {
        return Err(Error::fault(
            "ERR_FFI_SYMBOL_NOT_FOUND",
            "cannot call a null address".to_owned(),
        ));
    }

    // Reserve the whole argument area up front so the pointers handed to `ffi_call` cannot be
    // invalidated by a later allocation. Sixteen bytes of slack per slot covers alignment.
    let capacity: usize = plan
        .arg_entries
        .iter()
        .map(|entry| entry.bytes.max(8) + 16)
        .sum();
    let mut arena = ArgArena::with_capacity(capacity);

    let mut avalue: Vec<*mut c_void> = Vec::with_capacity(plan.arg_entries.len());
    for (entry, value) in plan.arg_entries.iter().zip(args) {
        let slot = arena.alloc(entry.bytes.max(8), entry.align.max(8));
        encode_value(&mut arena, table, entry, slot, value)?;
        avalue.push(slot as *mut c_void);
    }

    // At least `sizeof(ffi_arg)` and register-aligned: libffi widens narrow integral returns, so a
    // tight buffer would overrun (§7).
    let return_words = plan.ret_entry.bytes.max(8).div_ceil(16) + 1;
    let mut rvalue: Vec<u128> = vec![0; return_words];

    unsafe {
        // `ffi_call` takes a mutable `ffi_cif *` but does not modify a prepared plan; the cast
        // keeps plans immutable so the cache can hand out `&Plan` from several call sites.
        let cif = plan.cif.as_ref() as *const raw::ffi_cif as *mut raw::ffi_cif;
        raw::ffi_call(
            cif,
            address as *mut c_void,
            rvalue.as_mut_ptr() as *mut c_void,
            avalue.as_mut_ptr(),
        );
    }

    // Read `errno` before any other C work. The plan documents this ordering (§7).
    let errno = crate::errno::last_errno();

    let value = decode_return(plan, table, rvalue.as_ptr() as *const u8)?;
    Ok((value, errno))
}

fn decode_return(plan: &Plan, table: &TypeTable, bytes: *const u8) -> Result<Value> {
    let entry = &plan.ret_entry;
    Ok(match &entry.ty {
        Type::Void => Value::Void,
        Type::Int { bits, signed } => {
            // libffi writes an `ffi_arg` for every integral return; take the low `bits` and extend
            // according to the declared signedness. Reading only `bits` bytes would be wrong for
            // a signed narrow return on a big-endian target, and the targets here are little
            // endian, but the widening form is the ABI's own answer.
            let raw_value = unsafe { *(bytes as *const u64) };
            let value = match (bits, signed) {
                (8, true) => (raw_value as i8) as i64,
                (8, false) => (raw_value as u8) as i64,
                (16, true) => (raw_value as i16) as i64,
                (16, false) => (raw_value as u16) as i64,
                (32, true) => (raw_value as i32) as i64,
                (32, false) => (raw_value as u32) as i64,
                (64, true) => raw_value as i64,
                _ => raw_value as i64,
            };
            if *signed || *bits < 64 {
                Value::Int(value)
            } else {
                Value::UInt(raw_value)
            }
        }
        Type::F32 => Value::F32(unsafe { *(bytes as *const f32) }),
        Type::F64 => Value::F64(unsafe { *(bytes as *const f64) }),
        Type::Pointer(_) | Type::Callback { .. } => {
            Value::Ptr(unsafe { *(bytes as *const usize) } as u64)
        }
        Type::CString => {
            let pointer = unsafe { *(bytes as *const usize) };
            if pointer == 0 {
                Value::Ptr(0)
            } else {
                let text = unsafe { CStr::from_ptr(pointer as *const std::ffi::c_char) };
                Value::CString(text.to_string_lossy().into_owned())
            }
        }
        Type::Struct(_) => unsafe { read_in(table, entry, bytes as usize)? },
        Type::Array { .. } => {
            return Err(Error::unsupported_layout(
                "an array cannot be returned by value".to_owned(),
            ))
        }
    })
}

/// A bump allocator over one reserved, 16-byte aligned block.
///
/// The block is allocated once, so every pointer returned by [`ArgArena::alloc`] stays valid for
/// the duration of the call. C strings are owned by `strings`, whose heap buffers never move.
struct ArgArena {
    storage: Vec<u128>,
    cursor: usize,
    strings: Vec<Vec<u8>>,
}

impl ArgArena {
    fn with_capacity(bytes: usize) -> Self {
        let words = bytes.div_ceil(16) + 2;
        ArgArena {
            storage: vec![0u128; words],
            cursor: 0,
            strings: Vec::new(),
        }
    }

    fn alloc(&mut self, size: usize, align: usize) -> usize {
        let align = align.max(1);
        let base = self.storage.as_mut_ptr() as usize;
        let aligned = align_up(base + self.cursor, align) - base;
        self.cursor = aligned + size;
        base + aligned
    }

    /// Copy a string into the arena and return its NUL-terminated pointer.
    fn cstring(&mut self, text: &str) -> usize {
        let mut bytes = Vec::with_capacity(text.len() + 1);
        bytes.extend_from_slice(text.as_bytes());
        bytes.push(0);
        let pointer = bytes.as_ptr() as usize;
        self.strings.push(bytes);
        pointer
    }
}

fn align_up(value: usize, align: usize) -> usize {
    (value + align - 1) & !(align - 1)
}

/// Encode one value into `address`, keeping any C string alive in `arena`.
fn encode_value(
    arena: &mut ArgArena,
    table: &TypeTable,
    entry: &TypeEntry,
    address: usize,
    value: &Value,
) -> Result<()> {
    match &entry.ty {
        Type::CString => {
            let pointer = match value {
                Value::CString(text) => arena.cstring(text),
                Value::Ptr(0) => 0,
                Value::Ptr(address) => *address as usize,
                Value::Int(value) if *value == 0 => 0,
                Value::UInt(value) if *value == 0 => 0,
                _ => {
                    return Err(Error::fault(
                        "ERR_INVALID_ARG_TYPE",
                        "expected a string, a pointer or null for cstring".to_owned(),
                    ))
                }
            };
            unsafe { *(address as *mut usize) = pointer };
            Ok(())
        }
        Type::Pointer(_) | Type::Callback { .. } => {
            let pointer = match value {
                Value::Ptr(value) => *value as usize,
                Value::Int(value) => *value as usize,
                Value::UInt(value) => *value as usize,
                _ => {
                    return Err(Error::fault(
                        "ERR_INVALID_ARG_TYPE",
                        "expected a pointer".to_owned(),
                    ))
                }
            };
            unsafe { *(address as *mut usize) = pointer };
            Ok(())
        }
        Type::Struct(_) => {
            let Value::Struct(values) = value else {
                return Err(Error::fault(
                    "ERR_INVALID_ARG_TYPE",
                    "expected an object for a struct argument".to_owned(),
                ));
            };
            let Some(ids) = entry.field_ids() else {
                return Err(Error::unsupported_layout(
                    "struct has no field table".to_owned(),
                ));
            };
            for (index, id) in ids.iter().enumerate() {
                let Some(field_value) = values.get(index) else {
                    break;
                };
                let field = table.get(*id)?;
                let offset = entry.offsets.get(index).copied().unwrap_or(0);
                encode_value(arena, table, &field, address + offset, field_value)?;
            }
            Ok(())
        }
        Type::Array { of, count } => {
            let Value::Array(values) = value else {
                return Err(Error::fault(
                    "ERR_INVALID_ARG_TYPE",
                    "expected an array for an inline array field".to_owned(),
                ));
            };
            let element = table.get(*of)?;
            for (index, value) in values.iter().take(*count).enumerate() {
                let offset = entry.offsets.get(index).copied().unwrap_or(0);
                encode_value(arena, table, &element, address + offset, value)?;
            }
            Ok(())
        }
        _ => unsafe { crate::types::write_in(table, entry, address, value) },
    }
}

/// Encode a value for a raw pointer libffi handed us (a callback's return slot).
///
/// C strings are `malloc`ed because their lifetime extends past the trampoline; the callee owns
/// them, exactly as it would own a string returned by any C function.
///
/// # Safety
///
/// `address` must point to at least `entry.bytes` writable bytes, as libffi guarantees for the
/// `ret` pointer of a closure call.
pub unsafe fn encode_return(
    table: &TypeTable,
    entry: &TypeEntry,
    address: usize,
    value: &Value,
) -> Result<()> {
    if entry.bytes == 0 {
        return Ok(());
    }
    match (&entry.ty, value) {
        (Type::CString, Value::CString(text)) => {
            let bytes = text.as_bytes();
            let size = bytes.len() + 1;
            let memory = libc::malloc(size) as *mut u8;
            if memory.is_null() {
                *(address as *mut usize) = 0;
                return Ok(());
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), memory, bytes.len());
            *memory.add(bytes.len()) = 0;
            *(address as *mut usize) = memory as usize;
            Ok(())
        }
        (Type::CString, Value::Ptr(pointer)) => {
            *(address as *mut usize) = *pointer as usize;
            Ok(())
        }
        (Type::CString, Value::Int(value)) => {
            *(address as *mut usize) = *value as usize;
            Ok(())
        }
        _ => write_in(table, entry, address, value),
    }
}
