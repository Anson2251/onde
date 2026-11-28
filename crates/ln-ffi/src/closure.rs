//! libffi closures: a JavaScript function handed to C.
//!
//! The trampoline is the one place in this crate where a panic would cross an FFI boundary into C.
//! The release profile is `panic = "abort"`, so there is no unwinding safety net; the trampoline
//! therefore contains no `unwrap`, no `expect` and no indexing that can fail. Decoding an argument
//! that does not fit its type becomes a zero value rather than a panic, and the host reports the
//! JavaScript exception through its own parked-error slot after the outer call returns.

use std::ffi::c_void;
use std::rc::Rc;
use std::sync::Arc;

use crate::call::encode_return;
use crate::error::{Error, Result};
use crate::raw;
use crate::types::{read_in, Type, TypeEntry, TypeTable, Value};

/// A live closure. Dropping it calls `ffi_closure_free`.
pub struct Closure {
    closure: *mut c_void,
    code: *mut c_void,
    /// Boxed so the `user_data` pointer libffi holds never moves.
    ctx: Box<ClosureCtx>,
    #[allow(dead_code)]
    cif: Box<raw::ffi_cif>,
    #[allow(dead_code)]
    arg_ptrs: Vec<*mut raw::ffi_type>,
}

/// The host's callback body: one decoded call, one value back.
type CallbackBody = Box<dyn FnMut(&[Value]) -> Value>;

struct ClosureCtx {
    /// The isolate's type table. The closure keeps it alive for its own lifetime, so a callback
    /// can never outlive the registry it decodes through.
    table: Rc<TypeTable>,
    arg_entries: Vec<Arc<TypeEntry>>,
    ret_entry: Arc<TypeEntry>,
    callback: CallbackBody,
    /// The isolate thread that created the closure. `threadsafe: true` is refused, but C can
    /// still call the pointer from a foreign thread; entering QuickJS there is undefined. A
    /// foreign call gets a zeroed return value instead of touching the engine.
    thread: std::thread::ThreadId,
}

impl Closure {
    /// The executable address C should call.
    pub fn address(&self) -> usize {
        self.code as usize
    }

    pub fn ret_type(&self) -> &Type {
        &self.ctx.ret_entry.ty
    }

    /// Build a closure for `callback`.
    ///
    pub fn new(
        table: Rc<TypeTable>,
        arg_ids: &[u32],
        ret_id: u32,
        callback: CallbackBody,
    ) -> Result<Closure> {
        let ret_entry = table.get(ret_id)?;
        if crate::call::contains_inline_array(&table, &ret_entry)? {
            return Err(Error::unsupported_layout(
                "a callback cannot return a by-value struct containing an inline array".to_owned(),
            ));
        }
        let mut arg_entries = Vec::with_capacity(arg_ids.len());
        for id in arg_ids {
            let entry = table.get(*id)?;
            if matches!(entry.ty, Type::Void) {
                return Err(Error::signature_conflict(
                    "a callback cannot take a void argument".to_owned(),
                ));
            }
            if matches!(entry.ty, Type::Array { .. }) {
                return Err(Error::unsupported_layout(
                    "a callback cannot take an array by value; take a pointer".to_owned(),
                ));
            }
            if crate::call::contains_inline_array(&table, &entry)? {
                return Err(Error::unsupported_layout(
                    "a callback cannot take a by-value struct containing an inline array"
                        .to_owned(),
                ));
            }
            arg_entries.push(entry);
        }

        let mut arg_ptrs: Vec<*mut raw::ffi_type> =
            arg_entries.iter().map(|entry| entry.raw_ptr()).collect();
        let mut cif: Box<raw::ffi_cif> =
            Box::new(unsafe { std::mem::MaybeUninit::<raw::ffi_cif>::zeroed().assume_init() });
        let status = unsafe {
            raw::ffi_prep_cif(
                &mut *cif,
                raw::FFI_DEFAULT_ABI,
                arg_ptrs.len() as u32,
                ret_entry.raw_ptr(),
                arg_ptrs.as_mut_ptr(),
            )
        };
        if status != raw::FFI_OK {
            return Err(Error::signature_conflict(format!(
                "libffi refused the callback signature (status {status})"
            )));
        }

        // `ffi_closure_alloc` only allocates; the documented argument is `sizeof(ffi_closure)`.
        // The struct is 40 bytes on arm64 and at most 64 on x86_64, and libffi writes nothing past
        // the size it needs; 128 leaves room for a future field.
        let mut code: *mut c_void = std::ptr::null_mut();
        let closure = unsafe { raw::ffi_closure_alloc(128, &mut code) };
        if closure.is_null() || code.is_null() {
            return Err(Error::fault(
                "ERR_FFI_CALLBACK_ALLOC",
                "libffi could not allocate an executable closure (on macOS this needs the \
                 JIT/unsigned-executable-memory entitlement)"
                    .to_owned(),
            ));
        }

        let mut ctx = Box::new(ClosureCtx {
            table,
            arg_entries,
            ret_entry,
            callback,
            thread: std::thread::current().id(),
        });
        let user_data = &mut *ctx as *mut ClosureCtx as *mut c_void;
        let status =
            unsafe { raw::ffi_prep_closure_loc(closure, &mut *cif, trampoline, user_data, code) };
        if status != raw::FFI_OK {
            unsafe { raw::ffi_closure_free(closure) };
            return Err(Error::fault(
                "ERR_FFI_CALLBACK_ALLOC",
                format!("libffi refused the closure (status {status})"),
            ));
        }

        Ok(Closure {
            closure,
            code,
            ctx,
            cif,
            arg_ptrs,
        })
    }
}

impl Drop for Closure {
    fn drop(&mut self) {
        // Freeing while C may still call the trampoline is undefined; the caller owns that rule
        // (the plan says so explicitly). The context drop runs before the memory is returned.
        unsafe { raw::ffi_closure_free(self.closure) };
    }
}

/// The C entry point. Nothing here may panic.
unsafe extern "C" fn trampoline(
    _cif: *mut raw::ffi_cif,
    ret: *mut c_void,
    args: *mut *mut c_void,
    user: *mut c_void,
) {
    if user.is_null() {
        return;
    }
    let ctx = &mut *(user as *mut ClosureCtx);
    if args.is_null() {
        return;
    }
    if std::thread::current().id() != ctx.thread {
        // Never enter the engine from a foreign thread. A zeroed return keeps the ABI valid and
        // the isolate untouched; the plan refuses `threadsafe: true` for the same reason.
        if !ret.is_null() && ctx.ret_entry.bytes > 0 {
            std::ptr::write_bytes(ret as *mut u8, 0, ctx.ret_entry.bytes);
        }
        return;
    }
    let table = &ctx.table;

    let mut values: Vec<Value> = Vec::with_capacity(ctx.arg_entries.len());
    for (index, entry) in ctx.arg_entries.iter().enumerate() {
        let slot = match args.add(index).as_ref() {
            Some(slot) => *slot,
            None => std::ptr::null_mut(),
        };
        if slot.is_null() {
            values.push(Value::Void);
            continue;
        }
        match read_in(table, entry, slot as usize) {
            Ok(value) => values.push(value),
            // A type read that cannot be decoded becomes zero; the host has already validated the
            // signature, so this is unreachable in practice and must not abort the process.
            Err(_) => values.push(zero_value(&entry.ty)),
        }
    }

    let output = (ctx.callback)(&values);

    if !ret.is_null() && ctx.ret_entry.bytes > 0 {
        let _ = encode_return(table, &ctx.ret_entry, ret as usize, &output);
    }
}

fn zero_value(ty: &Type) -> Value {
    match ty {
        Type::Void => Value::Void,
        Type::Int { .. } => Value::Int(0),
        Type::F32 => Value::F32(0.0),
        Type::F64 => Value::F64(0.0),
        Type::Pointer(_) | Type::Callback { .. } | Type::CString => Value::Ptr(0),
        Type::Array { count, .. } => Value::Array((0..*count).map(|_| Value::Int(0)).collect()),
        Type::Struct(_) => Value::Struct(Vec::new()),
    }
}
