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

use super::HostState;

/// The isolate's FFI state.
pub(crate) struct FfiState {
    types: Rc<TypeTable>,
    inner: RefCell<FfiInner>,
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
}

struct LibraryEntry {
    library: Library,
    /// Deallocator-backed external buffers whose deallocator resolves into this library. A
    /// `close()` while any is live is refused: the deallocator's code may live in the library.
    live_external: Arc<AtomicUsize>,
}

impl FfiState {
    pub(crate) fn new() -> Rc<Self> {
        Rc::new(FfiState {
            types: Rc::new(TypeTable::new()),
            inner: RefCell::new(FfiInner {
                libraries: vec![None],
                closures: Vec::new(),
                last_errno: 0,
                calls_in_flight: 0,
                external_live: Arc::new(AtomicUsize::new(0)),
            }),
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
                    }));
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
                    inner.libraries[handle as usize] = None;
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
                      varargs: bool|
                      -> js::Result<()> {
                    let mut inner = ffi_state.inner.borrow_mut();
                    let Some(entry) = inner
                        .libraries
                        .get_mut(handle as usize)
                        .and_then(Option::as_mut)
                    else {
                        return Err(ffi_error(&ctx, FfiError::closed()));
                    };
                    // Validate the declaration now: a bad type id must fail at dlopen, not at the
                    // first call (the plan's WP0 exit criterion).
                    for id in args.iter().chain(std::iter::once(&ret)) {
                        ffi_state
                            .types
                            .get(*id)
                            .map_err(|error| ffi_error(&ctx, error))?;
                    }
                    entry.library.declare(
                        &name,
                        Declaration {
                            arg_ids: args,
                            ret_id: ret,
                            varargs,
                        },
                    );
                    Ok(())
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
                move |ctx: js::Ctx<'js>, fields: Vec<u32>| -> js::Result<js::Object<'js>> {
                    let id = ffi_state
                        .types
                        .define_struct(&fields)
                        .map_err(|error| ffi_error(&ctx, error))?;
                    let entry = ffi_state
                        .types
                        .get(id)
                        .map_err(|error| ffi_error(&ctx, error))?;
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
                    let args = convert_args(&ctx, &ffi_state.types, &arg_ids, &values)?;
                    let (plan, address) = {
                        let mut inner = ffi_state.inner.borrow_mut();
                        let entry = match inner
                            .libraries
                            .get_mut(handle as usize)
                            .and_then(Option::as_mut)
                        {
                            Some(entry) => entry,
                            None => return Err(ffi_error(&ctx, FfiError::closed())),
                        };
                        let address = entry
                            .library
                            .address_of(&name)
                            .map_err(|error| ffi_error(&ctx, error))?;
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
                        (plan, address)
                    };

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

fn js_to_value<'js>(
    ctx: &js::Ctx<'js>,
    table: &TypeTable,
    entry: &TypeEntry,
    value: &js::Value<'js>,
) -> js::Result<FfiValue> {
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
                Ok(FfiValue::Ptr(as_address(ctx, value)?))
            }
        }
        Type::Pointer(_) | Type::Callback { .. } => Ok(FfiValue::Ptr(as_address(ctx, value)?)),
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

fn as_address<'js>(ctx: &js::Ctx<'js>, value: &js::Value<'js>) -> js::Result<u64> {
    if value.is_null() || value.is_undefined() {
        return Ok(0);
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
