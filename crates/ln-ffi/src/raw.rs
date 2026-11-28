//! The libffi C surface, declared by hand.
//!
//! Two ABI facts make a binding without bindgen both small and reviewable:
//!
//! * `ffi_type` is a stable four-field struct on every platform libffi supports;
//! * `ffi_cif` is five fields plus `FFI_EXTRA_CIF_FIELDS`, which macOS arm64 defines as
//!   `unsigned aarch64_nfixedargs` and every other target in scope leaves empty.
//!
//! Everything else is an opaque pointer. The declarations below are checked against the vendored
//! header by `docs/ffi-plan.md` §5.7 and by the layout oracle; a mismatch is caught by the first
//! struct call on both targets in CI, not by a silent wrong answer.
//!
//! The crate does **not** use libffi's global `ffi_type_*` objects. Each registered type owns its
//! own `ffi_type` tree, because `ffi_prep_cif` writes `size`/`alignment` into the types it is
//! given and a per-isolate tree is the concurrency story the plan describes (§5.7).

#![allow(non_camel_case_types)]

use std::os::raw::{c_uint, c_void};

/// `ffi_type`, exactly as `ffi.h` declares it.
#[repr(C)]
#[derive(Debug)]
pub struct ffi_type {
    pub size: usize,
    pub alignment: u16,
    pub type_: u16,
    pub elements: *mut *mut ffi_type,
}

// The C library owns the pointers; the struct itself is plain data.
unsafe impl Send for ffi_type {}
unsafe impl Sync for ffi_type {}

pub const FFI_TYPE_VOID: u16 = 0;
#[allow(dead_code)] // named for the header it mirrors
pub const FFI_TYPE_INT: u16 = 1;
pub const FFI_TYPE_FLOAT: u16 = 2;
pub const FFI_TYPE_DOUBLE: u16 = 3;
#[allow(dead_code)] // named for the header it mirrors
pub const FFI_TYPE_LONGDOUBLE: u16 = 4;
pub const FFI_TYPE_UINT8: u16 = 5;
pub const FFI_TYPE_SINT8: u16 = 6;
pub const FFI_TYPE_UINT16: u16 = 7;
pub const FFI_TYPE_SINT16: u16 = 8;
pub const FFI_TYPE_UINT32: u16 = 9;
pub const FFI_TYPE_SINT32: u16 = 10;
pub const FFI_TYPE_UINT64: u16 = 11;
pub const FFI_TYPE_SINT64: u16 = 12;
pub const FFI_TYPE_STRUCT: u16 = 13;
pub const FFI_TYPE_POINTER: u16 = 14;
#[allow(dead_code)] // named for the header it mirrors
pub const FFI_TYPE_COMPLEX: u16 = 15;

pub const FFI_OK: i32 = 0;
pub const FFI_BAD_TYPEDEF: i32 = 1;
pub const FFI_BAD_ABI: i32 = 2;
pub const FFI_BAD_ARGTYPE: i32 = 3;

/// `FFI_DEFAULT_ABI`: 1 (`FFI_SYSV`) on aarch64, 2 (`FFI_UNIX64`) on x86_64.
///
/// The value is an ABI fact, not a default we can guess: a wrong constant does not fail loudly at
/// link time, it mis-frames every call. `compile_error!` on an unlisted architecture is the honest
/// alternative to a silent `else 2`.
#[cfg(target_arch = "aarch64")]
pub const FFI_DEFAULT_ABI: u32 = 1;
#[cfg(target_arch = "x86_64")]
pub const FFI_DEFAULT_ABI: u32 = 2;
#[cfg(not(any(target_arch = "aarch64", target_arch = "x86_64")))]
compile_error!("ln-ffi supports aarch64 and x86_64 only; add this target's FFI_DEFAULT_ABI");

#[cfg(target_endian = "big")]
compile_error!("ln-ffi assumes little-endian storage for return decoding");

/// `ffi_cif`.
///
/// A transparent wrapper is used so the extra macOS-arm64 field can be added with `cfg` without
/// changing the field names the rest of the crate reads.
#[repr(C)]
pub struct ffi_cif {
    pub abi: u32,
    pub nargs: c_uint,
    pub arg_types: *mut *mut ffi_type,
    pub rtype: *mut ffi_type,
    pub bytes: c_uint,
    pub flags: c_uint,
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    pub aarch64_nfixedargs: c_uint,
}

pub type ffi_closure_fn = unsafe extern "C" fn(
    cif: *mut ffi_cif,
    ret: *mut c_void,
    args: *mut *mut c_void,
    user: *mut c_void,
);

extern "C" {
    pub fn ffi_prep_cif(
        cif: *mut ffi_cif,
        abi: u32,
        nargs: c_uint,
        rtype: *mut ffi_type,
        atypes: *mut *mut ffi_type,
    ) -> i32;

    pub fn ffi_prep_cif_var(
        cif: *mut ffi_cif,
        abi: u32,
        nfixedargs: c_uint,
        ntotalargs: c_uint,
        rtype: *mut ffi_type,
        atypes: *mut *mut ffi_type,
    ) -> i32;

    pub fn ffi_call(
        cif: *mut ffi_cif,
        func: *mut c_void,
        rvalue: *mut c_void,
        avalue: *mut *mut c_void,
    );

    pub fn ffi_get_struct_offsets(abi: u32, struct_type: *mut ffi_type, offsets: *mut usize)
        -> i32;

    pub fn ffi_closure_alloc(size: usize, code: *mut *mut c_void) -> *mut c_void;
    pub fn ffi_closure_free(closure: *mut c_void);

    pub fn ffi_prep_closure_loc(
        closure: *mut c_void,
        cif: *mut ffi_cif,
        fun: ffi_closure_fn,
        user_data: *mut c_void,
        code: *mut c_void,
    ) -> i32;
}
