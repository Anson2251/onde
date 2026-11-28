//! `__ln_host.ffi`: the primitives behind `onde:ffi`.
//!
//! `ln-ffi` owns the ABI; this module owns the JavaScript boundary. The split is deliberate and
//! is the review surface ADR-0010 §7 asks for: one host submodule, small enough to read, with
//! type inference, `Struct` and the public API in `js/lib/ffi.js`.
//!
//! # Value convention
//!
//! JavaScript reduces every argument to a plain value before it reaches the host: a `Ptr` becomes
//! a BigInt address, a struct instance becomes an array of field values, a byte view becomes a
//! `Uint8Array`. The host then converts that plain value according to the registered type entry,
//! range-checking integers and refusing the wrong shape. Returns go the other way: the host
//! produces plain values and `js/lib/ffi.js` wraps them (`Ptr`, `Callback`, struct classes).
//!
//! # Lifetimes
//!
//! `FfiState` lives in the isolate for as long as the isolate does. Libraries and closures are
//! dropped by [`FfiState::shutdown`] *before* the engine goes away, because a closure holds a
//! persistent reference to a JavaScript function. The type registry is interior-mutable so a
//! callback that re-enters FFI can register a type while an outer call is on the stack.

use std::cell::RefCell;
use std::ffi::{c_void, CStr};
use std::rc::Rc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use ln_engine::js;
use ln_error::NodeError;
use ln_ffi::{
    read_in, write_in, Closure, Declaration, Error as FfiError, Library, Type, TypeEntry,
    TypeTable, Value as FfiValue,
};
use ln_perm::{Capability, Request};

use crate::host_error::{throw_node_error, throw_node_error_value};
use crate::trace::FfiTrace;

use super::HostState;

/// The isolate's FFI state.
pub(crate) struct FfiState {
    types: Rc<TypeTable>,
    inner: RefCell<FfiInner>,
    /// `--trace-ffi` / `ONDE_FFI_TRACE`: write every boundary event to stderr, synchronously.
    trace: FfiTrace,
    /// A JavaScript exception raised inside a callback, parked until the outer call returns.
    pending: RefCell<Option<js::Persistent<js::Value<'static>>>>,
}

struct FfiInner {
    /// Slot 0 is reserved so a closed handle (which JavaScript reports as 0) never names a real
    /// library.
    libraries: Vec<Option<LibraryEntry>>,
    closures: Vec<Option<Closure>>,
    /// The `errno` observed immediately after the last call.
    last_errno: i32,
    /// Calls currently on the stack. A callback can re-enter FFI, so a `close()` (or a callback
    /// `close()`) from inside a call must not unload an image that `ffi_call` is still using.
    calls_in_flight: usize,
    /// Every live deallocator-backed buffer, whatever library owns it. A handle opened by a bare
    /// name never resolves an image path, so `close()` uses this counter to refuse
    /// conservatively instead of missing an unreleasable deallocator.
    external_live: Arc<AtomicUsize>,
    /// Plans prepared once at `dlopen` for declared, non-variadic symbols. Slot 0 is reserved.
    /// The fast path avoids rebuilding the argument-id vector, shape string and options object
    /// for every call.
    declared_plans: Vec<Option<DeclaredPlan>>,
}

struct DeclaredPlan {
    handle: u32,
    symbol: String,
    plan: Rc<ln_ffi::Plan>,
    address: usize,
    resolved: bool,
}

struct LibraryEntry {
    library: Library,
    /// Deallocator-backed external buffers whose deallocator resolves into this library. A
    /// `close()` while any is live is refused: the deallocator's code may live in the library.
    live_external: Arc<AtomicUsize>,
    /// True once `--trace-ffi` printed this image's load address.
    image_logged: bool,
}

impl FfiState {
    pub(crate) fn new(trace: FfiTrace) -> Rc<Self> {
        Rc::new(FfiState {
            types: Rc::new(TypeTable::new()),
            inner: RefCell::new(FfiInner {
                libraries: vec![None],
                closures: Vec::new(),
                last_errno: 0,
                calls_in_flight: 0,
                external_live: Arc::new(AtomicUsize::new(0)),
                declared_plans: vec![None],
            }),
            trace,
            pending: RefCell::new(None),
        })
    }

    /// Drop the closures and libraries while the engine is still alive.
    pub(crate) fn shutdown(&self) {
        let mut inner = self.inner.borrow_mut();
        // The persistent function references must be released before the runtime is freed.
        inner.closures.clear();
        inner.libraries.clear();
        let _ = self.pending.borrow_mut().take();
    }
}

/// Install `host.ffi`. Only compiled with the `ffi` feature.
pub(crate) fn install<'js>(
    ctx: &js::Ctx<'js>,
    host: &js::Object<'js>,
    state: &HostState,
) -> js::Result<()> {
    let ffi = js::Object::new(ctx.clone())?;
    let ffi_state = state.ffi.clone();

    // --- dlopen / dlsym / declare ------------------------------------------------------------

    {
        let ffi_state = ffi_state.clone();
        let permit = state.permit.clone();
        ffi.set(
            "load",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, path: String| -> js::Result<u32> {
                    // The capability check happens before the loader is touched, so a denied
                    // script learns nothing about the filesystem through the error text.
                    permit
                        .check(&Request::Toggle {
                            capability: Capability::FfiLoad,
                        })
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let mut inner = ffi_state.inner.borrow_mut();
                    let library = Library::open(&path).map_err(|error| ffi_error(&ctx, error))?;
                    inner.libraries.push(Some(LibraryEntry {
                        library,
                        live_external: Arc::new(AtomicUsize::new(0)),
                        image_logged: false,
                    }));
                    if ffi_state.trace.enabled() {
                        trace_line(ffi_state.trace, format_args!("open {path}"));
                    }
                    Ok((inner.libraries.len() - 1) as u32)
                },
            )?,
        )?;
    }

    {
        let ffi_state = ffi_state.clone();
        ffi.set(
            "close",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, handle: u32| -> js::Result<bool> {
                    let mut inner = ffi_state.inner.borrow_mut();
                    let Some(entry) = inner
                        .libraries
                        .get(handle as usize)
                        .and_then(Option::as_ref)
                    else {
                        return Err(ffi_error(&ctx, FfiError::closed()));
                    };
                    let owns_live = entry.live_external.load(Ordering::SeqCst) > 0;
                    // A bare library name does not canonicalize, and the handle may never have
                    // resolved a symbol, so its image is unknown. Refuse while any owned buffer
                    // is live rather than letting an unreleasable deallocator outlive the image.
                    let image_unknown = entry.library.canonical_path().is_none();
                    let global_live = inner.external_live.load(Ordering::SeqCst);
                    if owns_live || (image_unknown && global_live > 0) {
                        return Err(ffi_error(
                            &ctx,
                            FfiError::new(
                                "ERR_FFI_LIVE_REFERENCES",
                                "cannot close: a deallocator-backed external buffer is still live",
                            ),
                        ));
                    }
                    if inner.calls_in_flight > 0 {
                        return Err(ffi_error(
                            &ctx,
                            FfiError::new(
                                "ERR_FFI_LIVE_REFERENCES",
                                "cannot close from inside a call: the image is still on the stack",
                            ),
                        ));
                    }
                    // Dropping the `Library` unloads it. No symbol can be called afterwards
                    // because JavaScript's handle object is marked closed first.
                    let path = entry.library.path().to_owned();
                    inner.libraries[handle as usize] = None;
                    if ffi_state.trace.enabled() {
                        trace_line(ffi_state.trace, format_args!("close {path}"));
                    }
                    Ok(true)
                },
            )?,
        )?;
    }

    {
        let ffi_state = ffi_state.clone();
        ffi.set(
            "declare",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      handle: u32,
                      name: String,
                      args: Vec<u32>,
                      ret: u32,
                      varargs: bool,
                      strict: bool|
                      -> js::Result<u32> {
                    // Validate the declaration now: a bad type id must fail at dlopen, not at the
                    // first call (the plan's WP0 exit criterion).
                    for id in args.iter().chain(std::iter::once(&ret)) {
                        ffi_state
                            .types
                            .get(*id)
                            .map_err(|error| ffi_error(&ctx, error))?;
                    }
                    let mut inner = ffi_state.inner.borrow_mut();
                    let FfiInner {
                        libraries,
                        declared_plans,
                        ..
                    } = &mut *inner;
                    let Some(entry) = libraries.get_mut(handle as usize).and_then(Option::as_mut)
                    else {
                        return Err(ffi_error(&ctx, FfiError::closed()));
                    };
                    entry.library.declare(
                        &name,
                        Declaration {
                            arg_ids: args.clone(),
                            ret_id: ret,
                            varargs,
                        },
                    );
                    // `strict` binds now, so a typo in the declaration fails at dlopen instead of
                    // at the first call. The default stays lazy for libraries that resolve a
                    // symbol only after an init entry point.
                    if strict {
                        entry
                            .library
                            .address_of(&name)
                            .map_err(|error| ffi_error(&ctx, error))?;
                    }
                    if ffi_state.trace.enabled() {
                        let type_name = |id: u32| {
                            ffi_state
                                .types
                                .get(id)
                                .map(|entry| entry.ty.name())
                                .unwrap_or_else(|_| "?".to_owned())
                        };
                        let mut params = args
                            .iter()
                            .map(|id| type_name(*id))
                            .collect::<Vec<_>>()
                            .join(", ");
                        if varargs {
                            if !params.is_empty() {
                                params.push_str(", ");
                            }
                            params.push_str("...");
                        }
                        trace_line(
                            ffi_state.trace,
                            format_args!(
                                "declare {} {name}({params}) -> {}",
                                entry.library.path(),
                                type_name(ret)
                            ),
                        );
                        // Resolve one symbol now so the log carries the image's load address,
                        // which is what `atos -l` / `addr2line` need later. A missing symbol is
                        // still reported by the call, exactly as before.
                        if let Ok(address) = entry.library.address_of(&name) {
                            log_image_once(entry, ffi_state.trace, address);
                        }
                    }
                    // A variadic signature has a per-call tail, so it keeps the generic path.
                    // An unsupported layout (an array by value, for example) also falls back:
                    // the generic call reports the precise error when it is actually used.
                    if varargs {
                        return Ok(0);
                    }
                    let Ok(plan) = ln_ffi::prepare(&ffi_state.types, &args, ret, None) else {
                        return Ok(0);
                    };
                    let id = declared_plans.len() as u32;
                    declared_plans.push(Some(DeclaredPlan {
                        handle,
                        symbol: name,
                        plan: Rc::new(plan),
                        address: 0,
                        resolved: false,
                    }));
                    Ok(id)
                },
            )?,
        )?;
    }

    {
        let ffi_state = ffi_state.clone();
        ffi.set(
            "address",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      handle: u32,
                      name: String|
                      -> js::Result<js::BigInt<'js>> {
                    let mut inner = ffi_state.inner.borrow_mut();
                    let Some(entry) = inner
                        .libraries
                        .get_mut(handle as usize)
                        .and_then(Option::as_mut)
                    else {
                        return Err(ffi_error(&ctx, FfiError::closed()));
                    };
                    let address = entry
                        .library
                        .address_of(&name)
                        .map_err(|error| ffi_error(&ctx, error))?;
                    js::BigInt::from_u64(ctx.clone(), address as u64)
                },
            )?,
        )?;
    }

    // --- target widths -----------------------------------------------------------------------
    //
    // `isize`/`usize` follow the pointer width and `cLong` follows the C `long` width. They are
    // host facts, not constants: LP64 gives 8 for both, LLP64 gives a 4-byte `long`, and a
    // 32-bit target gives 4 for the pointer types too.
    {
        let ffi_state = ffi_state.clone();
        ffi.set(
            "target",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>| -> js::Result<js::Object<'js>> {
                    let info = js::Object::new(ctx.clone())?;
                    info.set("pointerBits", (std::mem::size_of::<usize>() * 8) as u32)?;
                    info.set(
                        "longBits",
                        (std::mem::size_of::<std::os::raw::c_long>() * 8) as u32,
                    )?;
                    info.set("libcName", target_libc())?;
                    // 0 off, 1 summary, 2 full. `onde:ffi` reads this once and captures a call
                    // site per call only when it is nonzero.
                    info.set("trace", ffi_state.trace.level())?;
                    Ok(info)
                },
            )?,
        )?;
    }

    // --- type registry -----------------------------------------------------------------------

    {
        let ffi_state = ffi_state.clone();
        ffi.set(
            "typeRegister",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, descriptor: js::Value<'js>| -> js::Result<u32> {
                    let ty = parse_type(&descriptor)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    ffi_state
                        .types
                        .register(ty)
                        .map_err(|error| ffi_error(&ctx, error))
                },
            )?,
        )?;
    }

    {
        let ffi_state = ffi_state.clone();
        ffi.set(
            "typeInfo",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: u32| -> js::Result<js::Object<'js>> {
                    let entry = ffi_state
                        .types
                        .get(id)
                        .map_err(|error| ffi_error(&ctx, error))?;
                    let info = js::Object::new(ctx.clone())?;
                    info.set("bytes", entry.bytes)?;
                    info.set("align", entry.align)?;
                    Ok(info)
                },
            )?,
        )?;
    }

    {
        let ffi_state = ffi_state.clone();
        ffi.set(
            "structType",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      field_ids: Vec<u32>,
                      label: String,
                      names: Vec<String>|
                      -> js::Result<js::Object<'js>> {
                    let id = ffi_state
                        .types
                        .define_struct(&field_ids)
                        .map_err(|error| ffi_error(&ctx, error))?;
                    let entry = ffi_state
                        .types
                        .get(id)
                        .map_err(|error| ffi_error(&ctx, error))?;
                    if ffi_state.trace.full() {
                        let mut fields = String::new();
                        for ((name, field_id), offset) in
                            names.iter().zip(&field_ids).zip(&entry.offsets)
                        {
                            if !fields.is_empty() {
                                fields.push_str(", ");
                            }
                            let ty = ffi_state
                                .types
                                .get(*field_id)
                                .map(|field| field.ty.name())
                                .unwrap_or_else(|_| "?".to_owned());
                            let _ = std::fmt::Write::write_fmt(
                                &mut fields,
                                format_args!("{name}:{ty}@{offset}"),
                            );
                        }
                        trace_line(
                            ffi_state.trace,
                            format_args!(
                                "struct {label} bytes={} align={} {fields}",
                                entry.bytes, entry.align
                            ),
                        );
                    }
                    let info = js::Object::new(ctx.clone())?;
                    info.set("id", id)?;
                    info.set("bytes", entry.bytes)?;
                    info.set("align", entry.align)?;
                    let offsets = js::Array::new(ctx.clone())?;
                    for (index, offset) in entry.offsets.iter().enumerate() {
                        offsets.set(index, *offset)?;
                    }
                    info.set("offsets", offsets)?;
                    Ok(info)
                },
            )?,
        )?;
    }

    // --- calls -------------------------------------------------------------------------------

    {
        let ffi_state = ffi_state.clone();
        ffi.set(
            "call",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      handle: u32,
                      name: String,
                      arg_ids: Vec<u32>,
                      values: js::Array<'js>,
                      ret_id: u32,
                      options: js::Value<'js>|
                      -> js::Result<js::Value<'js>> {
                    let (shape, varargs) = parse_call_options(&options);
                    // Off the trace path, do not pay for a property lookup per call.
                    let frame = if ffi_state.trace.enabled() {
                        options.as_object().and_then(|object| {
                            object.get::<_, Option<String>>("frame").ok().flatten()
                        })
                    } else {
                        None
                    };
                    let args = convert_args(&ctx, &ffi_state.types, &arg_ids, &values)?;
                    let (plan, address, trace_info) = {
                        let mut inner = ffi_state.inner.borrow_mut();
                        let entry = match inner
                            .libraries
                            .get_mut(handle as usize)
                            .and_then(Option::as_mut)
                        {
                            Some(entry) => entry,
                            None => return Err(ffi_error(&ctx, FfiError::closed())),
                        };
                        let trace_info = ffi_state
                            .trace
                            .enabled()
                            .then(|| (entry.library.path().to_owned(), name.clone()));
                        let address = entry
                            .library
                            .address_of(&name)
                            .map_err(|error| ffi_error(&ctx, error))?;
                        log_image_once(entry, ffi_state.trace, address);
                        // A declaration fixes the ABI: a variadic declaration carries its fixed
                        // count, and a non-variadic one ignores `options.varargs` rather than
                        // silently switching to `ffi_prep_cif_var`. Only a symbol with no
                        // declaration takes the per-call count.
                        let declared = entry
                            .library
                            .declaration(&name)
                            .map(|declaration| (declaration.varargs, declaration.arg_ids.len()));
                        let plan_varargs = match declared {
                            Some((true, fixed)) => Some(fixed),
                            Some((false, _)) => None,
                            None => varargs,
                        };
                        let plan = entry
                            .library
                            .plan(
                                &ffi_state.types,
                                &name,
                                &arg_ids,
                                ret_id,
                                plan_varargs,
                                &shape,
                            )
                            .map_err(|error| ffi_error(&ctx, error))?;
                        (plan, address, trace_info)
                    };

                    if let Some((path, symbol)) = &trace_info {
                        trace_call(
                            ffi_state.trace,
                            path,
                            symbol,
                            plan.arg_entries(),
                            &args,
                            frame.as_deref(),
                        );
                    }
                    let ret_entry = ffi_state
                        .types
                        .get(ret_id)
                        .map_err(|error| ffi_error(&ctx, error))?;
                    ffi_state.inner.borrow_mut().calls_in_flight += 1;
                    let outcome = ln_ffi::invoke(&plan, &ffi_state.types, address, &args);
                    ffi_state.inner.borrow_mut().calls_in_flight -= 1;
                    let (value, errno) = outcome.map_err(|error| ffi_error(&ctx, error))?;
                    ffi_state.inner.borrow_mut().last_errno = errno;

                    // A callback that threw records the exception here. Rethrow it after the
                    // outer call has returned, exactly as the plan says (§9): leaving it pending
                    // would make every later engine call fail inside the same C frame.
                    let pending = ffi_state.pending.borrow_mut().take();
                    if let Some(pending) = pending {
                        let value = pending
                            .restore(&ctx)
                            .map_err(|_| ffi_error(&ctx, FfiError::closed()))?;
                        return Err(ctx.throw(value));
                    }

                    value_to_js(&ctx, &ffi_state.types, &ret_entry, value)
                },
            )?,
        )?;
    }

    {
        // Fast path for a symbol that was declared at `dlopen`. The plan, argument entries and
        // (after the first call) the resolved symbol address are all held host-side.
        let ffi_state = ffi_state.clone();
        ffi.set(
            "callPlan",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      handle: u32,
                      plan_id: u32,
                      values: js::Array<'js>,
                      frame: js::Value<'js>|
                      -> js::Result<js::Value<'js>> {
                    let frame = frame.as_string().and_then(|text| text.to_string().ok());
                    let (plan, address, trace_info) = {
                        let mut inner = ffi_state.inner.borrow_mut();
                        let FfiInner {
                            libraries,
                            declared_plans,
                            ..
                        } = &mut *inner;
                        let Some(slot) = declared_plans
                            .get_mut(plan_id as usize)
                            .and_then(Option::as_mut)
                        else {
                            return Err(ffi_error(
                                &ctx,
                                FfiError::new("ERR_FFI_CLOSED", "unknown declared plan"),
                            ));
                        };
                        if slot.handle != handle {
                            return Err(ffi_error(&ctx, FfiError::closed()));
                        }
                        // Check the library even when the address is cached: a close may have
                        // happened after the first call.
                        let Some(entry) =
                            libraries.get_mut(handle as usize).and_then(Option::as_mut)
                        else {
                            return Err(ffi_error(&ctx, FfiError::closed()));
                        };
                        let trace_info = ffi_state
                            .trace
                            .enabled()
                            .then(|| (entry.library.path().to_owned(), slot.symbol.clone()));
                        let address = if slot.resolved {
                            slot.address
                        } else {
                            let address = entry
                                .library
                                .address_of(&slot.symbol)
                                .map_err(|error| ffi_error(&ctx, error))?;
                            slot.address = address;
                            slot.resolved = true;
                            address
                        };
                        log_image_once(entry, ffi_state.trace, address);
                        (slot.plan.clone(), address, trace_info)
                    };

                    if values.len() != plan.arg_entries().len() {
                        return Err(throw_node_error(
                            &ctx,
                            "ERR_FFI_MISSING_ARGUMENT",
                            &format!(
                                "symbol takes {} arguments, got {}",
                                plan.arg_entries().len(),
                                values.len()
                            ),
                        ));
                    }
                    let mut args = Vec::with_capacity(plan.arg_entries().len());
                    for (index, entry) in plan.arg_entries().iter().enumerate() {
                        let value: js::Value = values.get(index)?;
                        args.push(js_to_value(&ctx, &ffi_state.types, entry, &value)?);
                    }
                    if let Some((path, symbol)) = &trace_info {
                        trace_call(
                            ffi_state.trace,
                            path,
                            symbol,
                            plan.arg_entries(),
                            &args,
                            frame.as_deref(),
                        );
                    }
                    let ret_entry = plan.ret_entry().clone();
                    ffi_state.inner.borrow_mut().calls_in_flight += 1;
                    let outcome = ln_ffi::invoke(&plan, &ffi_state.types, address, &args);
                    ffi_state.inner.borrow_mut().calls_in_flight -= 1;
                    let (value, errno) = outcome.map_err(|error| ffi_error(&ctx, error))?;
                    ffi_state.inner.borrow_mut().last_errno = errno;

                    let pending = ffi_state.pending.borrow_mut().take();
                    if let Some(pending) = pending {
                        let value = pending
                            .restore(&ctx)
                            .map_err(|_| ffi_error(&ctx, FfiError::closed()))?;
                        return Err(ctx.throw(value));
                    }
                    value_to_js(&ctx, &ffi_state.types, &ret_entry, value)
                },
            )?,
        )?;
    }

    // --- memory ------------------------------------------------------------------------------

    {
        let ffi_state = ffi_state.clone();
        ffi.set(
            "read",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      type_id: u32,
                      address: js::Value<'js>,
                      offset: f64|
                      -> js::Result<js::Value<'js>> {
                    let entry = ffi_state
                        .types
                        .get(type_id)
                        .map_err(|error| ffi_error(&ctx, error))?;
                    let base = as_address(&ctx, &address)?;
                    let pointer = base.wrapping_add(offset.max(0.0) as u64);
                    // SAFETY: the caller owns the address; this is the same contract as C.
                    let value = unsafe { read_in(&ffi_state.types, &entry, pointer as usize) }
                        .map_err(|error| ffi_error(&ctx, error))?;
                    value_to_js(&ctx, &ffi_state.types, &entry, value)
                },
            )?,
        )?;
    }

    {
        // `CString(ptr, offset, length)` clones out of native memory, so the result is safe after
        // the pointer is freed. A missing length means NUL-terminated.
        let ffi_state = ffi_state.clone();
        ffi.set(
            "cstring",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      address: js::Value<'js>,
                      offset: f64,
                      length: js::Value<'js>|
                      -> js::Result<js::Value<'js>> {
                    let _ = &ffi_state;
                    let base = as_address(&ctx, &address)?;
                    if base == 0 {
                        return Ok(js::Value::new_null(ctx.clone()));
                    }
                    let start = base.wrapping_add(offset.max(0.0) as u64) as *const u8;
                    let text = if length.is_null() || length.is_undefined() {
                        let cstr = unsafe { CStr::from_ptr(start as *const std::ffi::c_char) };
                        cstr.to_string_lossy().into_owned()
                    } else {
                        let count = length.as_number().unwrap_or(0.0).max(0.0) as usize;
                        let bytes = unsafe { std::slice::from_raw_parts(start, count) };
                        String::from_utf8_lossy(bytes).into_owned()
                    };
                    Ok(js::String::from_str(ctx.clone(), &text)?.into_value())
                },
            )?,
        )?;
    }

    {
        let ffi_state = ffi_state.clone();
        ffi.set(
            "write",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      type_id: u32,
                      address: js::Value<'js>,
                      offset: f64,
                      value: js::Value<'js>|
                      -> js::Result<()> {
                    let entry = ffi_state
                        .types
                        .get(type_id)
                        .map_err(|error| ffi_error(&ctx, error))?;
                    let base = as_address(&ctx, &address)?;
                    let pointer = base.wrapping_add(offset.max(0.0) as u64);
                    let reduced = js_to_value(&ctx, &ffi_state.types, &entry, &value)?;
                    // SAFETY: the caller owns the address; the same contract as `read`.
                    unsafe { write_in(&ffi_state.types, &entry, pointer as usize, &reduced) }
                        .map_err(|error| ffi_error(&ctx, error))
                },
            )?,
        )?;
    }

    {
        let ffi_state = ffi_state.clone();
        ffi.set(
            "pointer",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      view: js::TypedArray<'js, u8>|
                      -> js::Result<js::BigInt<'js>> {
                    let _ = (&ffi_state, &ctx);
                    let address = view
                        .as_raw()
                        .map(|raw| raw.as_ptr() as *mut u8 as usize)
                        .unwrap_or(0);
                    js::BigInt::from_u64(ctx.clone(), address as u64)
                },
            )?,
        )?;
    }

    {
        ffi.set(
            "alloc",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, size: f64| -> js::Result<js::BigInt<'js>> {
                    let size = size.max(0.0) as usize;
                    let pointer = if size == 0 {
                        0
                    } else {
                        // SAFETY: a plain malloc; a null return is reported as 0.
                        unsafe { libc::malloc(size) as usize }
                    };
                    js::BigInt::from_u64(ctx.clone(), pointer as u64)
                },
            )?,
        )?;
    }

    {
        ffi.set(
            "free",
            js::Function::new(
                ctx.clone(),
                move |_ctx: js::Ctx<'js>, address: js::Value<'js>| -> js::Result<()> {
                    let pointer = as_address(&_ctx, &address)? as usize;
                    if pointer != 0 {
                        // SAFETY: the caller promises the pointer came from `alloc` (or a C
                        // allocation it owns) and is freed once.
                        unsafe { libc::free(pointer as *mut c_void) };
                    }
                    Ok(())
                },
            )?,
        )?;
    }

    {
        let ffi_state = ffi_state.clone();
        ffi.set(
            "toArrayBuffer",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      address: js::Value<'js>,
                      length: f64,
                      deallocator: js::Value<'js>,
                      context_value: js::Value<'js>|
                      -> js::Result<js::ArrayBuffer<'js>> {
                    let address = as_address(&ctx, &address)? as usize;
                    let length = length.max(0.0) as usize;
                    if address == 0 && length != 0 {
                        return Err(throw_node_error(
                            &ctx,
                            "ERR_FFI_INVALID_ADDRESS",
                            "toArrayBuffer needs a non-null address",
                        ));
                    }
                    let deallocator = as_address(&ctx, &deallocator)? as usize;
                    let context_pointer = as_address(&ctx, &context_value)? as usize;
                    let (owner, global) = if deallocator == 0 {
                        (None, None)
                    } else {
                        let global = ffi_state.inner.borrow().external_live.clone();
                        global.fetch_add(1, Ordering::SeqCst);
                        let owner = owner_for_deallocator(&ffi_state, deallocator);
                        if let Some(counter) = &owner {
                            counter.fetch_add(1, Ordering::SeqCst);
                        }
                        (owner, Some(global))
                    };
                    let buffer = ExternalBuffer {
                        address,
                        length,
                        deallocator,
                        context: context_pointer,
                        live_owner: owner.clone(),
                        live_global: global.clone(),
                    };
                    match js::ArrayBuffer::from_source(ctx.clone(), buffer) {
                        Ok(buffer) => Ok(buffer),
                        Err(error) => {
                            if let Some(counter) = &owner {
                                counter.fetch_sub(1, Ordering::SeqCst);
                            }
                            if let Some(counter) = &global {
                                counter.fetch_sub(1, Ordering::SeqCst);
                            }
                            Err(error)
                        }
                    }
                },
            )?,
        )?;
    }

    {
        // The inference rule of §4.3 reads QuickJS's number tag: an int-tagged number may infer
        // `i32`, a float-tagged one may not. JavaScript cannot see that distinction itself.
        ffi.set(
            "numberTag",
            js::Function::new(ctx.clone(), move |value: js::Value<'_>| -> u32 {
                if value.is_int() {
                    0
                } else if value.is_float() {
                    1
                } else {
                    2
                }
            })?,
        )?;
    }

    {
        ffi.set(
            "allocZeroed",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, size: f64| -> js::Result<js::BigInt<'js>> {
                    let size = size.max(0.0) as usize;
                    let pointer = if size == 0 {
                        0
                    } else {
                        // SAFETY: calloc is zero-filled, which is what `ref(T)` promises.
                        unsafe { libc::calloc(1, size) as usize }
                    };
                    js::BigInt::from_u64(ctx.clone(), pointer as u64)
                },
            )?,
        )?;
    }

    {
        // A callback-typed return is callable (§4.1's `dlsym` example). The address has no
        // library handle behind it, so this path prepares a plan directly instead of consulting
        // the handle's cache.
        let ffi_state = ffi_state.clone();
        ffi.set(
            "callAt",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      address: js::Value<'js>,
                      arg_ids: Vec<u32>,
                      values: js::Array<'js>,
                      ret_id: u32,
                      options: js::Value<'js>|
                      -> js::Result<js::Value<'js>> {
                    let (_shape, varargs) = parse_call_options(&options);
                    let args = convert_args(&ctx, &ffi_state.types, &arg_ids, &values)?;
                    let target = as_address(&ctx, &address)?;
                    let ret_entry = ffi_state
                        .types
                        .get(ret_id)
                        .map_err(|error| ffi_error(&ctx, error))?;
                    let plan = ln_ffi::prepare(&ffi_state.types, &arg_ids, ret_id, varargs)
                        .map_err(|error| ffi_error(&ctx, error))?;
                    ffi_state.inner.borrow_mut().calls_in_flight += 1;
                    let outcome = ln_ffi::invoke(&plan, &ffi_state.types, target as usize, &args);
                    ffi_state.inner.borrow_mut().calls_in_flight -= 1;
                    let (value, errno) = outcome.map_err(|error| ffi_error(&ctx, error))?;
                    ffi_state.inner.borrow_mut().last_errno = errno;
                    let pending = ffi_state.pending.borrow_mut().take();
                    if let Some(pending) = pending {
                        let value = pending
                            .restore(&ctx)
                            .map_err(|_| ffi_error(&ctx, FfiError::closed()))?;
                        return Err(ctx.throw(value));
                    }
                    value_to_js(&ctx, &ffi_state.types, &ret_entry, value)
                },
            )?,
        )?;
    }

    {
        let ffi_state = ffi_state.clone();
        ffi.set(
            "errno",
            js::Function::new(ctx.clone(), move || -> js::Result<f64> {
                let mut inner = ffi_state.inner.borrow_mut();
                let value = inner.last_errno;
                inner.last_errno = 0;
                Ok(value as f64)
            })?,
        )?;
    }

    // --- callbacks ---------------------------------------------------------------------------

    {
        let ffi_state = ffi_state.clone();
        ffi.set(
            "callback",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      arg_ids: Vec<u32>,
                      ret_id: u32,
                      threadsafe: bool,
                      wrapper: js::Function<'js>|
                      -> js::Result<js::Object<'js>> {
                    if threadsafe {
                        // v1 invokes callbacks on the isolate thread only. A foreign-thread call
                        // cannot enter the engine, and the deferred queue is deliberately not
                        // half-implemented: see docs/ffi-plan.md §13.
                        return Err(throw_node_error(
                            &ctx,
                            "ERR_FFI_UNSUPPORTED_THREADSAFE",
                            "threadsafe callbacks are not implemented in v1; call back on the \
                             isolate thread",
                        ));
                    }
                    for id in arg_ids.iter().chain(std::iter::once(&ret_id)) {
                        ffi_state
                            .types
                            .get(*id)
                            .map_err(|error| ffi_error(&ctx, error))?;
                    }
                    let arg_entries: Vec<_> = arg_ids
                        .iter()
                        .filter_map(|id| ffi_state.types.get(*id).ok())
                        .collect();
                    let ret_entry = ffi_state
                        .types
                        .get(ret_id)
                        .map_err(|error| ffi_error(&ctx, error))?;
                    let table = ffi_state.types.clone();
                    let raw_ctx = ctx.as_raw();
                    let persistent = js::Persistent::save(&ctx, wrapper);
                    let arg_entries_for_call = arg_entries.clone();
                    let ret_entry_for_call = ret_entry.clone();
                    let table_for_call = table.clone();
                    let pending_state = ffi_state.clone();
                    let callback = Box::new(move |args: &[FfiValue]| -> FfiValue {
                        // SAFETY: a closure is only invoked from C on the isolate thread while
                        // the isolate (and its context) is alive. `shutdown` frees every closure
                        // before the engine goes away.
                        let ctx = unsafe { js::Ctx::from_raw(raw_ctx) };
                        let array = match js::Array::new(ctx.clone()) {
                            Ok(array) => array,
                            Err(_) => return FfiValue::Void,
                        };
                        for (index, entry) in arg_entries_for_call.iter().enumerate() {
                            let Some(value) = args.get(index) else {
                                break;
                            };
                            if let Ok(js_value) =
                                value_to_js(&ctx, &table_for_call, entry, value.clone())
                            {
                                let _ = array.set(index, js_value);
                            }
                        }
                        let function = match persistent.clone().restore(&ctx) {
                            Ok(function) => function,
                            Err(_) => return FfiValue::Void,
                        };
                        match function.call::<_, js::Value>((array,)) {
                            Ok(value) => {
                                js_to_value(&ctx, &table_for_call, &ret_entry_for_call, &value)
                                    .unwrap_or(FfiValue::Void)
                            }
                            Err(error) => {
                                // Park the exception itself, not a copy: the outer call rethrows
                                // the value the callback threw, with its own stack.
                                if matches!(error, js::Error::Exception) {
                                    let value = ctx.catch();
                                    *pending_state.pending.borrow_mut() =
                                        Some(js::Persistent::save(&ctx, value));
                                }
                                zero_value(&ret_entry_for_call.ty)
                            }
                        }
                    });

                    let closure = Closure::new(table, &arg_ids, ret_id, callback)
                        .map_err(|error| ffi_error(&ctx, error))?;
                    let address = closure.address() as u64;
                    let mut inner = ffi_state.inner.borrow_mut();
                    inner.closures.push(Some(closure));
                    let id = (inner.closures.len() - 1) as u32;
                    let result = js::Object::new(ctx.clone())?;
                    result.set("id", id)?;
                    result.set("address", js::BigInt::from_u64(ctx.clone(), address)?)?;
                    Ok(result)
                },
            )?,
        )?;
    }

    {
        let ffi_state = ffi_state.clone();
        ffi.set(
            "callbackClose",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: u32| -> js::Result<bool> {
                    let mut inner = ffi_state.inner.borrow_mut();
                    if inner.calls_in_flight > 0 {
                        return Err(ffi_error(
                            &ctx,
                            FfiError::new(
                                "ERR_FFI_LIVE_REFERENCES",
                                "cannot close a callback from inside a call: its trampoline is on \
                                 the stack",
                            ),
                        ));
                    }
                    match inner.closures.get_mut(id as usize) {
                        Some(slot) => {
                            if slot.is_none() {
                                return Err(ffi_error(&ctx, FfiError::closed()));
                            }
                            *slot = None;
                            Ok(true)
                        }
                        None => Err(ffi_error(&ctx, FfiError::closed())),
                    }
                },
            )?,
        )?;
    }

    host.set("ffi", ffi)?;
    Ok(())
}

/// The C library's loader name for the target this binary was built for.
///
/// This is a host fact, not a script constant: glibc, musl and macOS do not share a soname. The
/// supported targets are checked by `ln-ffi`'s compile-time gate, so the fallback is unreachable
/// in a build that compiles.
fn target_libc() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "libc.dylib"
    }
    #[cfg(all(target_os = "linux", target_env = "musl"))]
    {
        "libc.so"
    }
    #[cfg(all(target_os = "linux", not(target_env = "musl")))]
    {
        "libc.so.6"
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        "libc.so.6"
    }
}

fn ffi_error<'js>(ctx: &js::Ctx<'js>, error: FfiError) -> js::Error {
    throw_node_error(ctx, error.code, &error.message)
}

// -------------------------------------------------------------------------------------------
// Crash tracing
// -------------------------------------------------------------------------------------------

/// Write one line to stderr without buffering.
///
/// The trace exists to survive a crash inside C, so the write has to reach the descriptor before
/// `ffi_call` runs. `libc::write` also keeps the trace out of Rust's stderr lock, which a signal
/// would leave unusable; the process is not crashing here, but the ordering guarantee is the same.
fn write_stderr(text: &str) {
    #[cfg(unix)]
    {
        let bytes = text.as_bytes();
        let mut offset = 0;
        while offset < bytes.len() {
            let written = unsafe {
                libc::write(
                    2,
                    bytes[offset..].as_ptr() as *const c_void,
                    bytes.len() - offset,
                )
            };
            if written < 0 {
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                break;
            }
            if written == 0 {
                break;
            }
            offset += written as usize;
        }
    }
    #[cfg(not(unix))]
    {
        use std::io::Write as _;
        let _ = std::io::stderr().write_all(text.as_bytes());
    }
}

fn trace_line(trace: FfiTrace, args: std::fmt::Arguments<'_>) {
    if !trace.enabled() {
        return;
    }
    use std::fmt::Write as _;
    let mut line = String::from("[ffi] ");
    let _ = line.write_fmt(args);
    line.push('\n');
    write_stderr(&line);
}

/// One `call` line: the library and symbol, the coerced arguments, and the JavaScript frame.
fn trace_call(
    trace: FfiTrace,
    library: &str,
    symbol: &str,
    entries: &[Arc<TypeEntry>],
    args: &[FfiValue],
    frame: Option<&str>,
) {
    if !trace.enabled() {
        return;
    }
    use std::fmt::Write as _;
    let mut values = String::new();
    for (entry, value) in entries.iter().zip(args) {
        if !values.is_empty() {
            values.push_str(", ");
        }
        let _ = write!(values, "{}=", entry.ty.name());
        format_value(trace, value, 0, &mut values);
    }
    trace_line(
        trace,
        format_args!(
            "call {library} {symbol}({values}) at {}",
            frame.unwrap_or("<unknown>")
        ),
    );
}

fn format_value(trace: FfiTrace, value: &FfiValue, depth: usize, out: &mut String) {
    use std::fmt::Write as _;
    match value {
        FfiValue::Void => out.push_str("void"),
        FfiValue::Int(value) => {
            let _ = write!(out, "{value}");
        }
        FfiValue::UInt(value) => {
            let _ = write!(out, "{value}");
        }
        FfiValue::Bool(value) => {
            let _ = write!(out, "{value}");
        }
        FfiValue::F32(value) => {
            let _ = write!(out, "{value}");
        }
        FfiValue::F64(value) => {
            let _ = write!(out, "{value}");
        }
        FfiValue::Ptr(0) => out.push_str("null"),
        FfiValue::Ptr(value) => {
            let _ = write!(out, "{value:#x}");
        }
        FfiValue::CString(text) => push_string(text, trace.full(), out),
        FfiValue::Struct(fields) if trace.full() && depth < 2 => {
            out.push('{');
            for (index, field) in fields.iter().enumerate() {
                if index > 0 {
                    out.push_str(", ");
                }
                format_value(trace, field, depth + 1, out);
            }
            out.push('}');
        }
        FfiValue::Struct(fields) => {
            let _ = write!(out, "{{{}}}", fields.len());
        }
        FfiValue::Array(items) if trace.full() && depth < 2 => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push_str(", ");
                }
                format_value(trace, item, depth + 1, out);
            }
            out.push(']');
        }
        FfiValue::Array(items) => {
            let _ = write!(out, "[{}]", items.len());
        }
    }
}

fn push_string(text: &str, full: bool, out: &mut String) {
    let limit = if full { 96 } else { 24 };
    out.push('"');
    let mut truncated = false;
    for (index, ch) in text.chars().enumerate() {
        if index == limit {
            truncated = true;
            break;
        }
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if ch.is_control() => out.push(' '),
            ch => out.push(ch),
        }
    }
    if truncated {
        out.push_str("...");
    }
    out.push('"');
}

/// Print the image's load address once, the first time this library resolves a symbol.
fn log_image_once(entry: &mut LibraryEntry, trace: FfiTrace, address: usize) {
    if !trace.enabled() || entry.image_logged {
        return;
    }
    let Some(base) = image_base(address) else {
        return;
    };
    entry.image_logged = true;
    trace_line(
        trace,
        format_args!("image {} base={base:#x}", entry.library.path()),
    );
}

/// The load address of the image containing `address`, for `atos -l` and `addr2line`.
#[cfg(unix)]
fn image_base(address: usize) -> Option<usize> {
    let mut info: libc::Dl_info = unsafe { std::mem::zeroed() };
    let resolved = unsafe { libc::dladdr(address as *const c_void, &mut info) };
    if resolved == 0 || info.dli_fbase.is_null() {
        None
    } else {
        Some(info.dli_fbase as usize)
    }
}

#[cfg(not(unix))]
fn image_base(_address: usize) -> Option<usize> {
    None
}

/// A borrowed or owned block of native memory exposed as an `ArrayBuffer`.
struct ExternalBuffer {
    address: usize,
    length: usize,
    /// `void dealloc(void *ptr, void *context)`, or 0 for a borrowed view.
    deallocator: usize,
    context: usize,
    live_owner: Option<Arc<AtomicUsize>>,
    live_global: Option<Arc<AtomicUsize>>,
}

// SAFETY: the memory behind `address` is owned by C for `length` bytes; the source only hands
// that pointer to the engine, and its `Drop` is the one place the deallocator runs.
unsafe impl js::ArrayBufferSource for ExternalBuffer {
    fn as_ptr(&self) -> *mut u8 {
        self.address as *mut u8
    }

    fn len(&self) -> usize {
        self.length
    }

    fn is_empty(&self) -> bool {
        self.length == 0
    }
}

impl Drop for ExternalBuffer {
    fn drop(&mut self) {
        // Runs when the buffer is collected, or immediately when it is detached. The deallocator
        // must not call into JavaScript (the plan's contract for `toArrayBuffer`).
        if self.deallocator != 0 {
            let deallocate: unsafe extern "C" fn(*mut c_void, *mut c_void) =
                unsafe { std::mem::transmute(self.deallocator) };
            unsafe { deallocate(self.address as *mut c_void, self.context as *mut c_void) };
        }
        if let Some(counter) = &self.live_owner {
            counter.fetch_sub(1, Ordering::SeqCst);
        }
        if let Some(counter) = &self.live_global {
            counter.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

/// The live-buffer counter of the library a deallocator belongs to.
///
/// `dladdr` is the portable way to ask "which image defined this address?". When it cannot tell,
/// the buffer is treated as foreign: it does not block any `close()`, because guessing a library
/// from an address we could not resolve would be worse than not blocking one.
fn owner_for_deallocator(state: &FfiState, address: usize) -> Option<Arc<AtomicUsize>> {
    #[cfg(unix)]
    {
        let mut info: libc::Dl_info = unsafe { std::mem::zeroed() };
        let resolved = unsafe { libc::dladdr(address as *const c_void, &mut info) };
        if resolved != 0 && !info.dli_fname.is_null() {
            let name = unsafe { CStr::from_ptr(info.dli_fname) }
                .to_string_lossy()
                .into_owned();
            // `dladdr` reports the real path (on macOS `/tmp` is `/private/tmp`), and the
            // `Library` stored both the path it was given and its canonical form at open time.
            // No filesystem access is needed here, and the permission inventory stays honest.
            let inner = state.inner.borrow();
            for entry in inner.libraries.iter().flatten() {
                let library = &entry.library;
                let matches =
                    library.canonical_path() == Some(name.as_str()) || library.path() == name;
                if matches {
                    return Some(entry.live_external.clone());
                }
            }
        }
    }
    // Foreign or unresolvable. The global counter still covers the handle whose image is
    // unknown; this return only marks "no specific owner".
    None
}

// -------------------------------------------------------------------------------------------
// Type descriptors
// -------------------------------------------------------------------------------------------

fn parse_type(descriptor: &js::Value<'_>) -> Result<Type, NodeError> {
    let object = descriptor.as_object().ok_or_else(|| {
        NodeError::invalid_arg_type("descriptor", "object", descriptor.type_name())
    })?;
    let kind: String = object
        .get("k")
        .map_err(|_| NodeError::invalid_arg_value("descriptor", "<object>", "has no type kind"))?;
    match kind.as_str() {
        "void" => Ok(Type::Void),
        "int" => {
            let bits: u16 = object.get("bits").unwrap_or(32);
            let signed: bool = object.get("signed").unwrap_or(true);
            Ok(Type::Int { bits, signed })
        }
        "f32" => Ok(Type::F32),
        "f64" => Ok(Type::F64),
        "cstring" => Ok(Type::CString),
        "ptr" => {
            let of: Option<u32> = object.get("of").ok().flatten();
            Ok(Type::Pointer(of))
        }
        "callback" => {
            let args: Vec<u32> = object.get("args").unwrap_or_default();
            let ret: u32 = object.get("ret").unwrap_or(0);
            Ok(Type::Callback { args, ret })
        }
        "array" => {
            let of: u32 = object.get("of").unwrap_or(0);
            let count: u32 = object.get("count").unwrap_or(0);
            Ok(Type::Array {
                of,
                count: count as usize,
            })
        }
        "struct" => {
            let id: u32 = object.get("id").unwrap_or(0);
            Ok(Type::Struct(id))
        }
        other => Err(NodeError::invalid_arg_value(
            "descriptor",
            other,
            "is not a known FFI type kind",
        )),
    }
}

fn parse_call_options(options: &js::Value<'_>) -> (String, Option<usize>) {
    let Some(object) = options.as_object() else {
        return (String::new(), None);
    };
    let shape: String = object.get("shape").unwrap_or_default();
    let varargs: Option<u32> = object.get("varargs").ok().flatten();
    (shape, varargs.map(|value| value as usize))
}

// -------------------------------------------------------------------------------------------
// Value conversion
// -------------------------------------------------------------------------------------------

fn convert_args<'js>(
    ctx: &js::Ctx<'js>,
    table: &TypeTable,
    arg_ids: &[u32],
    values: &js::Array<'js>,
) -> js::Result<Vec<FfiValue>> {
    let mut args = Vec::with_capacity(arg_ids.len());
    for (index, id) in arg_ids.iter().enumerate() {
        let entry = table.get(*id).map_err(|error| ffi_error(ctx, error))?;
        let value: js::Value = values.get(index).map_err(|_| {
            ffi_error(
                ctx,
                FfiError::new("ERR_FFI_MISSING_ARGUMENT", "missing argument"),
            )
        })?;
        args.push(js_to_value(ctx, table, &entry, &value)?);
    }
    Ok(args)
}

/// A boxed scalar from `js/lib/ffi.js` (`i32(1)`, `f64(2)`) arrives as an object carrying its
/// value. The host unwraps it here so the fast path does not need a per-argument JavaScript scan
/// for typed values.
fn unwrap_typed<'js>(
    _ctx: &js::Ctx<'js>,
    value: &js::Value<'js>,
) -> js::Result<Option<js::Value<'js>>> {
    if value.is_object() {
        if let Some(object) = value.as_object() {
            if object.get::<_, bool>("__ffiTyped").unwrap_or(false) {
                return object.get("value").map(Some);
            }
        }
    }
    Ok(None)
}

fn js_to_value<'js>(
    ctx: &js::Ctx<'js>,
    table: &TypeTable,
    entry: &TypeEntry,
    value: &js::Value<'js>,
) -> js::Result<FfiValue> {
    let unwrapped = unwrap_typed(ctx, value)?;
    let value = unwrapped.as_ref().unwrap_or(value);
    if value.is_undefined() {
        return Err(throw_node_error(
            ctx,
            "ERR_FFI_MISSING_ARGUMENT",
            "an argument was undefined",
        ));
    }
    if value.is_null() {
        return match &entry.ty {
            Type::Pointer(_) | Type::Callback { .. } | Type::CString => Ok(FfiValue::Ptr(0)),
            _ => Err(throw_node_error(
                ctx,
                "ERR_INVALID_ARG_TYPE",
                "null is only valid for a pointer or cstring argument",
            )),
        };
    }
    match &entry.ty {
        Type::Void => Ok(FfiValue::Void),
        Type::Int { bits, signed } => {
            let number = int_value(ctx, value, *bits, *signed)?;
            if *signed {
                Ok(FfiValue::Int(number as i64))
            } else {
                Ok(FfiValue::UInt(number as u64))
            }
        }
        Type::F32 => Ok(FfiValue::F32(number_value(ctx, value)? as f32)),
        Type::F64 => Ok(FfiValue::F64(number_value(ctx, value)?)),
        Type::CString => {
            if let Some(text) = value.as_string() {
                Ok(FfiValue::CString(
                    text.to_string().map_err(|_| invalid_string(ctx))?,
                ))
            } else {
                Ok(FfiValue::Ptr(as_pointer_argument(ctx, value)?))
            }
        }
        Type::Pointer(_) | Type::Callback { .. } => {
            Ok(FfiValue::Ptr(as_pointer_argument(ctx, value)?))
        }
        Type::Struct(_) => {
            let Some(array) = value.as_array() else {
                return Err(throw_node_error(
                    ctx,
                    "ERR_INVALID_ARG_TYPE",
                    "a struct argument must be reduced to an array of field values",
                ));
            };
            let Some(ids) = entry.field_ids() else {
                return Err(throw_node_error(
                    ctx,
                    "ERR_FFI_UNSUPPORTED_LAYOUT",
                    "struct has no field table",
                ));
            };
            let mut fields = Vec::with_capacity(ids.len());
            for (index, id) in ids.iter().enumerate() {
                let field = table.get(*id).map_err(|error| ffi_error(ctx, error))?;
                let field_value: js::Value = array.get(index).map_err(|_| {
                    throw_node_error(ctx, "ERR_FFI_MISSING_ARGUMENT", "missing struct field")
                })?;
                fields.push(js_to_value(ctx, table, &field, &field_value)?);
            }
            Ok(FfiValue::Struct(fields))
        }
        Type::Array { of, count } => {
            let element = table.get(*of).map_err(|error| ffi_error(ctx, error))?;
            let mut elements = Vec::with_capacity(*count);
            if let Some(view) = value
                .as_object()
                .and_then(|object| object.as_typed_array::<u8>())
            {
                if view.len() != *count {
                    return Err(throw_node_error(
                        ctx,
                        "ERR_INVALID_ARG_TYPE",
                        &format!(
                            "inline array of {count} bytes needs a {count}-byte view, got {}",
                            view.len()
                        ),
                    ));
                }
                let bytes = view
                    .as_raw()
                    .map(|raw| raw.cast::<u8>().as_ptr())
                    .unwrap_or(std::ptr::null_mut());
                for index in 0..*count {
                    // SAFETY: the length was just checked, and JS cannot run between the check
                    // and this read.
                    let byte = unsafe { *bytes.add(index) };
                    elements.push(FfiValue::UInt(byte as u64));
                }
                return Ok(FfiValue::Array(elements));
            }
            let Some(array) = value.as_array() else {
                return Err(throw_node_error(
                    ctx,
                    "ERR_INVALID_ARG_TYPE",
                    "an inline array needs an array or a Uint8Array",
                ));
            };
            for index in 0..*count {
                let item: js::Value = array.get(index).map_err(|_| {
                    throw_node_error(ctx, "ERR_FFI_MISSING_ARGUMENT", "missing array element")
                })?;
                elements.push(js_to_value(ctx, table, &element, &item)?);
            }
            Ok(FfiValue::Array(elements))
        }
    }
}

fn value_to_js<'js>(
    ctx: &js::Ctx<'js>,
    table: &TypeTable,
    entry: &TypeEntry,
    value: FfiValue,
) -> js::Result<js::Value<'js>> {
    Ok(match value {
        FfiValue::Void => js::Value::new_undefined(ctx.clone()),
        FfiValue::Int(number) => match &entry.ty {
            Type::Int { bits, .. } if *bits == 64 => {
                js::BigInt::from_i64(ctx.clone(), number)?.into_value()
            }
            _ => js::Value::new_number(ctx.clone(), number as f64),
        },
        FfiValue::UInt(number) => match &entry.ty {
            Type::Int { bits, .. } if *bits == 64 => {
                js::BigInt::from_u64(ctx.clone(), number)?.into_value()
            }
            _ => js::Value::new_number(ctx.clone(), number as f64),
        },
        FfiValue::Bool(boolean) => js::Value::new_bool(ctx.clone(), boolean),
        FfiValue::F32(number) => js::Value::new_number(ctx.clone(), number as f64),
        FfiValue::F64(number) => js::Value::new_number(ctx.clone(), number),
        FfiValue::Ptr(address) => js::BigInt::from_u64(ctx.clone(), address)?.into_value(),
        FfiValue::CString(text) => js::String::from_str(ctx.clone(), &text)?.into_value(),
        FfiValue::Struct(fields) => {
            let array = js::Array::new(ctx.clone())?;
            let ids = entry.field_ids().unwrap_or(&[]);
            for (index, (id, field)) in ids.iter().zip(fields).enumerate() {
                let field_entry = table.get(*id).map_err(|error| ffi_error(ctx, error))?;
                let js_value = value_to_js(ctx, table, &field_entry, field)?;
                array.set(index, js_value)?;
            }
            array.into_value()
        }
        FfiValue::Array(elements) => {
            let array = js::Array::new(ctx.clone())?;
            let element_entry = match &entry.ty {
                Type::Array { of, .. } => {
                    Some(table.get(*of).map_err(|error| ffi_error(ctx, error))?)
                }
                _ => None,
            };
            for (index, element) in elements.into_iter().enumerate() {
                let js_value = match &element_entry {
                    Some(entry) => value_to_js(ctx, table, entry, element)?,
                    None => js::Value::new_undefined(ctx.clone()),
                };
                array.set(index, js_value)?;
            }
            array.into_value()
        }
    })
}

fn int_value<'js>(
    ctx: &js::Ctx<'js>,
    value: &js::Value<'js>,
    bits: u16,
    signed: bool,
) -> js::Result<i128> {
    let (minimum, maximum) = int_range(bits, signed);
    if let Some(boolean) = value.as_bool() {
        return Ok(i128::from(boolean));
    }
    if let Some(big) = value.as_big_int() {
        let number: i128 = if signed {
            big.clone().to_i64().map_err(|_| out_of_range(ctx))? as i128
        } else {
            bigint_to_u64(ctx, value).ok_or_else(|| out_of_range(ctx))? as i128
        };
        if number < minimum || number > maximum {
            return Err(out_of_range(ctx));
        }
        return Ok(number);
    }
    let Some(number) = value.as_number() else {
        return Err(throw_node_error(
            ctx,
            "ERR_INVALID_ARG_TYPE",
            "expected an integer",
        ));
    };
    if !number.is_finite() || number.fract() != 0.0 {
        return Err(throw_node_error(
            ctx,
            "ERR_INVALID_ARG_TYPE",
            "expected an integer value",
        ));
    }
    // A number may only stand in for a 64-bit value while it is a safe integer; outside that the
    // caller must use a BigInt, exactly as the plan's coercion table says.
    if bits == 64 && number.abs() > 9_007_199_254_740_991.0 {
        return Err(throw_node_error(
            ctx,
            "ERR_INVALID_ARG_TYPE",
            "a 64-bit integer outside the safe range must be passed as a BigInt",
        ));
    }
    if number < minimum as f64 || number > maximum as f64 {
        return Err(out_of_range(ctx));
    }
    Ok(number as i128)
}

fn int_range(bits: u16, signed: bool) -> (i128, i128) {
    if signed {
        match bits {
            8 => (i8::MIN as i128, i8::MAX as i128),
            16 => (i16::MIN as i128, i16::MAX as i128),
            32 => (i32::MIN as i128, i32::MAX as i128),
            _ => (i64::MIN as i128, i64::MAX as i128),
        }
    } else {
        match bits {
            8 => (0, u8::MAX as i128),
            16 => (0, u16::MAX as i128),
            32 => (0, u32::MAX as i128),
            _ => (0, u64::MAX as i128),
        }
    }
}

fn number_value<'js>(ctx: &js::Ctx<'js>, value: &js::Value<'js>) -> js::Result<f64> {
    value
        .as_number()
        .ok_or_else(|| throw_node_error(ctx, "ERR_INVALID_ARG_TYPE", "expected a number"))
}

/// A pointer argument. Numbers are allowed by the generic address helper (for `read` and
/// `toArrayBuffer`), but not here: a bare number in a pointer slot is the shortest path to a
/// segmentation fault. A BigInt, a `Ptr`/`Callback`/`ref` object or null is explicit.
fn as_pointer_argument<'js>(ctx: &js::Ctx<'js>, value: &js::Value<'js>) -> js::Result<u64> {
    if value.is_null() || value.is_undefined() {
        return Ok(0);
    }
    if let Some(object) = value.as_object() {
        if let Ok(address) = object.get::<_, js::Value>("address") {
            if !address.is_undefined() && !address.is_null() {
                return as_pointer_argument(ctx, &address);
            }
        }
    }
    if value.is_big_int() {
        return bigint_to_u64(ctx, value).ok_or_else(|| {
            throw_node_error(
                ctx,
                "ERR_INVALID_ARG_TYPE",
                "expected a Ptr, Callback, ref, BigInt or null address",
            )
        });
    }
    Err(throw_node_error(
        ctx,
        "ERR_INVALID_ARG_TYPE",
        "expected a Ptr, Callback, ref, BigInt or null address",
    ))
}

fn as_address<'js>(ctx: &js::Ctx<'js>, value: &js::Value<'js>) -> js::Result<u64> {
    if value.is_null() || value.is_undefined() {
        return Ok(0);
    }
    // The direct declared path hands the host a `Ptr`, `Callback` or `ref` object rather than
    // unwrapping it in JavaScript. All three expose an `address` property.
    if let Some(object) = value.as_object() {
        if let Ok(address) = object.get::<_, js::Value>("address") {
            if !address.is_undefined() && !address.is_null() {
                return as_address(ctx, &address);
            }
        }
    }
    if value.is_big_int() {
        return bigint_to_u64(ctx, value).ok_or_else(|| {
            throw_node_error(
                ctx,
                "ERR_INVALID_ARG_TYPE",
                "expected an unsigned 64-bit address",
            )
        });
    }
    let Some(number) = value.as_number() else {
        return Err(throw_node_error(
            ctx,
            "ERR_INVALID_ARG_TYPE",
            "expected an address (BigInt or number)",
        ));
    };
    if !number.is_finite() || number < 0.0 || number > u64::MAX as f64 {
        return Err(throw_node_error(
            ctx,
            "ERR_INVALID_ARG_TYPE",
            "expected an unsigned 64-bit address",
        ));
    }
    Ok(number as u64)
}

/// Convert a BigInt to `u64` with QuickJS's own conversion.
///
/// rquickjs exposes `BigInt::to_i64` only, which cannot represent a value above `i64::MAX` (a
/// full-width pointer or `u64::MAX`). The engine's `JS_ToBigUint64` is exact and is the same call
/// QuickJS's own operators use.
fn bigint_to_u64(ctx: &js::Ctx<'_>, value: &js::Value<'_>) -> Option<u64> {
    let mut out: u64 = 0;
    let status =
        unsafe { js::qjs::JS_ToBigUint64(ctx.as_raw().as_ptr(), &mut out, value.as_raw()) };
    if status == 0 {
        Some(out)
    } else {
        None
    }
}

fn out_of_range<'js>(ctx: &js::Ctx<'js>) -> js::Error {
    throw_node_error(
        ctx,
        "ERR_INVALID_ARG_TYPE",
        "integer is outside the declared type's range",
    )
}

fn invalid_string<'js>(ctx: &js::Ctx<'js>) -> js::Error {
    throw_node_error(
        ctx,
        "ERR_INVALID_ARG_TYPE",
        "a cstring cannot contain an unpaired surrogate",
    )
}

fn zero_value(ty: &Type) -> FfiValue {
    match ty {
        Type::Void => FfiValue::Void,
        Type::Int { .. } => FfiValue::Int(0),
        Type::F32 => FfiValue::F32(0.0),
        Type::F64 => FfiValue::F64(0.0),
        Type::Pointer(_) | Type::Callback { .. } | Type::CString => FfiValue::Ptr(0),
        Type::Array { count, .. } => FfiValue::Array(vec![FfiValue::Int(0); *count]),
        Type::Struct(_) => FfiValue::Struct(Vec::new()),
    }
}
