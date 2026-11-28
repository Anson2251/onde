//! Types, `ffi_type` trees and struct layout.
//!
//! A [`Type`] is the logical descriptor JavaScript registers; a [`TypeEntry`] is that type plus
//! its own `ffi_type` tree and the host-computed `sizeof`/`_Alignof`. Layout is never computed by
//! hand: an `FFI_TYPE_STRUCT` is handed to `ffi_get_struct_offsets`, which returns the member
//! offsets and fills in `size`/`alignment` for the target ABI. That is the one implementation
//! that cannot disagree with the call ABI.
//!
//! Inline arrays are libffi's documented emulation: an `FFI_TYPE_STRUCT` whose `elements` repeat
//! the element type `count` times. That is why a struct field can be an array while a top-level
//! array argument is refused (see [`crate::call`]).

use std::cell::RefCell;
use std::sync::Arc;

use crate::error::{Error, Result};
use crate::raw;

/// A logical type, as registered by `js/lib/ffi.js`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Type {
    Void,
    /// `bits` is 8, 16, 32 or 64.
    Int {
        bits: u16,
        signed: bool,
    },
    F32,
    F64,
    /// A pointer. The pointee id is informational only; `None` is `void *` (or a pointee that
    /// did not exist yet, which is the by-pointer self-reference case).
    Pointer(Option<u32>),
    /// `char *`: ABI-identical to a pointer, but read as a NUL-terminated string and written from
    /// a JavaScript string.
    CString,
    /// A C function pointer with a declared signature. ABI-wise this is a pointer.
    Callback {
        args: Vec<u32>,
        ret: u32,
    },
    /// An inline array: a struct field or `CArray.of(T, n)`.
    Array {
        of: u32,
        count: usize,
    },
    /// A by-value struct already registered by [`TypeTable::define_struct`].
    Struct(u32),
}

impl Type {
    pub fn is_pointer_like(&self) -> bool {
        matches!(self, Type::Pointer(_) | Type::Callback { .. })
    }

    /// A short stable name used in `ERR_FFI_SIGNATURE_CONFLICT` messages and diagnostics.
    pub fn name(&self) -> String {
        match self {
            Type::Void => "void".to_owned(),
            Type::Int { bits, signed } => {
                format!("{}{bits}", if *signed { "i" } else { "u" })
            }
            Type::F32 => "f32".to_owned(),
            Type::F64 => "f64".to_owned(),
            Type::Pointer(None) => "ptr".to_owned(),
            Type::Pointer(Some(id)) => format!("ptr<{id}>"),
            Type::CString => "cstring".to_owned(),
            Type::Callback { .. } => "callback".to_owned(),
            Type::Array { of, count } => format!("array<{of};{count}>"),
            Type::Struct(id) => format!("struct<{id}>"),
        }
    }

    /// The ABI class used by the return-refinement rule (§4.1): pointers, integers by width,
    /// floats, structs and void are the only classes C distinguishes.
    pub fn abi_class(&self) -> AbiClass {
        match self {
            Type::Void => AbiClass::Void,
            Type::Int { bits, .. } => AbiClass::Int(*bits),
            Type::F32 => AbiClass::F32,
            Type::F64 => AbiClass::F64,
            Type::Pointer(_) | Type::Callback { .. } | Type::CString => AbiClass::Pointer,
            Type::Struct(_) => AbiClass::Struct,
            // C has no array-by-value class; the caller refuses these before this point.
            Type::Array { .. } => AbiClass::Struct,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AbiClass {
    Void,
    Int(u16),
    F32,
    F64,
    Pointer,
    Struct,
}

impl AbiClass {
    /// Whether a call-site return type may reinterpret a declared one without changing the ABI.
    pub fn refines(self, declared: AbiClass) -> bool {
        match (self, declared) {
            (AbiClass::Pointer, AbiClass::Pointer) => true,
            (AbiClass::Int(a), AbiClass::Int(b)) => a == b,
            (AbiClass::F32, AbiClass::F32) => true,
            (AbiClass::F64, AbiClass::F64) => true,
            (AbiClass::Void, AbiClass::Void) => true,
            (AbiClass::Struct, AbiClass::Struct) => true,
            _ => false,
        }
    }
}

/// Values that cross the host boundary. Plain data only: nothing here holds a JavaScript value.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Void,
    Int(i64),
    UInt(u64),
    Bool(bool),
    F32(f32),
    F64(f64),
    /// A raw address, 0 for null.
    Ptr(u64),
    /// A string, decoded on read and copied to a NUL-terminated buffer on write.
    CString(String),
    /// Struct fields in declaration order.
    Struct(Vec<Value>),
    /// Array elements in order.
    Array(Vec<Value>),
}

impl Value {
    pub fn as_ptr(&self) -> Option<u64> {
        match self {
            Value::Ptr(address) => Some(*address),
            Value::Int(value) => Some(*value as u64),
            Value::UInt(value) => Some(*value),
            _ => None,
        }
    }
}

/// One registered type: the logical descriptor and its ABI representation.
pub struct TypeEntry {
    pub ty: Type,
    /// `sizeof` and `_Alignof` as the target ABI computes them.
    pub bytes: usize,
    pub align: usize,
    /// Member offsets, index-aligned with [`Type::Struct`]'s fields or the array repetitions.
    pub offsets: Vec<usize>,
    /// The field type ids of a struct, in declaration order. `None` for every other type.
    field_ids: Option<Vec<u32>>,
    /// The private `ffi_type` tree. Boxed so its address never moves.
    raw: Box<RawType>,
}

impl TypeEntry {
    pub fn raw_ptr(&self) -> *mut raw::ffi_type {
        // The Arc keeps the entry alive while a plan holds this pointer.
        self.raw.header_ptr()
    }

    /// Field type ids in declaration order, for a struct.
    pub fn field_ids(&self) -> Option<&[u32]> {
        self.field_ids.as_deref()
    }
}

/// An `ffi_type` tree with owned children and a stable element pointer array.
struct RawType {
    header: raw::ffi_type,
    // Boxed on purpose: `elements` stores raw pointers at each child header, so a child must not
    // move when this Vec grows (or when the parent is moved into its own Box).
    #[allow(clippy::vec_box)]
    children: Vec<Box<RawType>>,
    // `header.elements` points into this Vec. It is kept only so the buffer stays alive and can
    // be read back by tests; the pointer is the field libffi uses.
    #[allow(dead_code)]
    element_ptrs: Vec<*mut raw::ffi_type>,
}

// The tree is plain data owned by the table; it never crosses a thread.
unsafe impl Send for RawType {}
unsafe impl Sync for RawType {}

impl RawType {
    fn scalar(size: usize, align: u16, kind: u16) -> Self {
        RawType {
            header: raw::ffi_type {
                size,
                alignment: align,
                type_: kind,
                elements: std::ptr::null_mut(),
            },
            children: Vec::new(),
            element_ptrs: Vec::new(),
        }
    }

    #[allow(clippy::vec_box)]
    fn aggregate(children: Vec<Box<RawType>>) -> Self {
        // libffi walks `elements` until a null pointer: the array must be terminated as well as
        // counted. A missing terminator reads past the Vec, which is exactly the crash the first
        // struct-layout test found.
        let mut element_ptrs: Vec<*mut raw::ffi_type> = Vec::with_capacity(children.len() + 1);
        for child in &children {
            element_ptrs.push(child.header_ptr());
        }
        element_ptrs.push(std::ptr::null_mut());
        RawType {
            header: raw::ffi_type {
                size: 0,
                alignment: 0,
                type_: raw::FFI_TYPE_STRUCT,
                elements: element_ptrs.as_mut_ptr(),
            },
            children,
            element_ptrs,
        }
    }

    fn header_ptr(&self) -> *mut raw::ffi_type {
        // The pointer must name the `ffi_type` header itself, not the Rust wrapper that contains
        // it. `addr_of!` keeps that honest even if the struct layout changes.
        std::ptr::addr_of!(self.header) as *mut raw::ffi_type
    }

    fn deep_clone(&self) -> RawType {
        let children: Vec<Box<RawType>> = self
            .children
            .iter()
            .map(|child| Box::new(child.deep_clone()))
            .collect();
        if children.is_empty() {
            RawType {
                header: raw::ffi_type {
                    size: self.header.size,
                    alignment: self.header.alignment,
                    type_: self.header.type_,
                    elements: std::ptr::null_mut(),
                },
                children: Vec::new(),
                element_ptrs: Vec::new(),
            }
        } else {
            let mut aggregate = RawType::aggregate(children);
            // libffi has already computed (or will recompute) the layout for the copy; carrying
            // the cached numbers over keeps a nested struct's size stable before the outer prep.
            aggregate.header.size = self.header.size;
            aggregate.header.alignment = self.header.alignment;
            aggregate
        }
    }
}

/// The isolate's type registry. Id 0 is `void` so JavaScript has a fixed sentinel.
pub struct TypeTable {
    /// Interior mutability: a call holds `&TypeTable` across `ffi_call`, and a callback may
    /// register a new type while it does. Every borrow is short (a lookup clones an `Arc`), so
    /// the registry can grow during a call without invalidating a plan or a type entry.
    entries: RefCell<Vec<Arc<TypeEntry>>>,
}

impl Default for TypeTable {
    fn default() -> Self {
        Self::new()
    }
}

impl TypeTable {
    pub fn new() -> Self {
        // Id 0 is `void`; this is the one type JS does not have to register.
        let entries = vec![Arc::new(TypeEntry {
            ty: Type::Void,
            bytes: 0,
            align: 1,
            offsets: Vec::new(),
            field_ids: None,
            // libffi's own `ffi_type_void` reports size 1 (not 0) and rejects a zero-sized
            // void return in `ffi_prep_cif`. The logical size stays 0; only the ABI object's size
            // is 1.
            raw: Box::new(RawType::scalar(1, 1, raw::FFI_TYPE_VOID)),
        })];
        TypeTable {
            entries: RefCell::new(entries),
        }
    }

    pub fn get(&self, id: u32) -> Result<Arc<TypeEntry>> {
        self.entries
            .borrow()
            .get(id as usize)
            .cloned()
            .ok_or_else(|| Error::fault("ERR_FFI_UNKNOWN_TYPE", format!("unknown type id {id}")))
    }

    pub fn count(&self) -> usize {
        self.entries.borrow().len()
    }

    /// Register a type, interning an identical one.
    ///
    /// Struct ids are never interned by shape: two classes with the same layout are still two
    /// types, because the return-refinement rule compares class identity (§4.1).
    pub fn register(&self, ty: Type) -> Result<u32> {
        if !matches!(ty, Type::Struct(_)) {
            let interned = self
                .entries
                .borrow()
                .iter()
                .position(|entry| entry.ty == ty);
            if let Some(index) = interned {
                return Ok(index as u32);
            }
        }
        let entry = self.build(&ty)?;
        let mut entries = self.entries.borrow_mut();
        entries.push(Arc::new(entry));
        Ok((entries.len() - 1) as u32)
    }

    fn build(&self, ty: &Type) -> Result<TypeEntry> {
        let (raw, bytes, align, offsets) = match ty {
            Type::Void => (
                // See `TypeTable::new`: the ABI object's size is 1 for `FFI_TYPE_VOID`.
                RawType::scalar(1, 1, raw::FFI_TYPE_VOID),
                0,
                1,
                Vec::new(),
            ),
            Type::Int { bits, signed } => {
                let (size, kind) = int_ffi(*bits, *signed)?;
                let raw = RawType::scalar(size, size as u16, kind);
                (raw, size, size, Vec::new())
            }
            Type::F32 => (RawType::scalar(4, 4, raw::FFI_TYPE_FLOAT), 4, 4, Vec::new()),
            Type::F64 => (
                RawType::scalar(8, 8, raw::FFI_TYPE_DOUBLE),
                8,
                8,
                Vec::new(),
            ),
            Type::Pointer(_) | Type::Callback { .. } | Type::CString => {
                // The pointer type follows the target, not a constant. The supported targets are
                // 64-bit, and a 32-bit target would answer 4 here without any other change.
                let size = std::mem::size_of::<usize>();
                let align = std::mem::align_of::<usize>() as u16;
                (
                    RawType::scalar(size, align, raw::FFI_TYPE_POINTER),
                    size,
                    size,
                    Vec::new(),
                )
            }
            Type::Array { of, count } => {
                if *count == 0 {
                    return Err(Error::fault(
                        "ERR_FFI_UNSUPPORTED_LAYOUT",
                        "an inline array must have at least one element".to_owned(),
                    ));
                }
                let element = self.get(*of)?;
                if matches!(element.ty, Type::Void) {
                    return Err(Error::fault(
                        "ERR_FFI_UNSUPPORTED_LAYOUT",
                        "an inline array cannot have element type void".to_owned(),
                    ));
                }
                let mut children = Vec::with_capacity(*count);
                for _ in 0..*count {
                    children.push(Box::new(self.build_raw(&element.ty)?));
                }
                let raw = RawType::aggregate(children);
                let mut offsets = vec![0usize; *count];
                let status = unsafe {
                    raw::ffi_get_struct_offsets(
                        raw::FFI_DEFAULT_ABI,
                        raw.header_ptr(),
                        offsets.as_mut_ptr(),
                    )
                };
                if status != raw::FFI_OK {
                    return Err(Error::fault(
                        "ERR_FFI_UNSUPPORTED_LAYOUT",
                        format!("libffi refused an inline array layout (status {status})"),
                    ));
                }
                let size = raw.header.size;
                let alignment = raw.header.alignment as usize;
                (raw, size, alignment, offsets)
            }
            Type::Struct(id) => {
                // Structs are defined through `define_struct`; this path re-surfaces one.
                let entry = self.get(*id)?;
                (
                    entry.raw.deep_clone(),
                    entry.bytes,
                    entry.align,
                    entry.offsets.clone(),
                )
            }
        };
        Ok(TypeEntry {
            ty: ty.clone(),
            bytes,
            align,
            offsets,
            field_ids: None,
            raw: Box::new(raw),
        })
    }

    /// Build the `ffi_type` tree for a logical type (used by nested fields and array elements).
    fn build_raw(&self, ty: &Type) -> Result<RawType> {
        if let Type::Struct(id) = ty {
            let entry = self.get(*id)?;
            return Ok(entry.raw.deep_clone());
        }
        Ok(*self.build(ty)?.raw)
    }

    /// Define a struct from already-registered field types.
    ///
    /// The host asks libffi for the layout; JavaScript never does alignment arithmetic.
    pub fn define_struct(&self, field_ids: &[u32]) -> Result<u32> {
        if field_ids.is_empty() {
            return Err(Error::fault(
                "ERR_INVALID_ARG_VALUE",
                "a struct must have at least one field".to_owned(),
            ));
        }
        let mut children = Vec::with_capacity(field_ids.len());
        for id in field_ids {
            let entry = self.get(*id)?;
            if matches!(entry.ty, Type::Void) {
                return Err(Error::fault(
                    "ERR_FFI_UNSUPPORTED_LAYOUT",
                    "a struct field cannot have type void".to_owned(),
                ));
            }
            children.push(Box::new(self.build_raw(&entry.ty)?));
        }
        let raw = RawType::aggregate(children);
        let mut offsets = vec![0usize; field_ids.len()];
        let status = unsafe {
            raw::ffi_get_struct_offsets(
                raw::FFI_DEFAULT_ABI,
                raw.header_ptr(),
                offsets.as_mut_ptr(),
            )
        };
        if status != raw::FFI_OK {
            return Err(Error::fault(
                "ERR_FFI_UNSUPPORTED_LAYOUT",
                format!("libffi refused the struct layout (status {status})"),
            ));
        }
        let bytes = raw.header.size;
        let align = raw.header.alignment as usize;
        let mut entries = self.entries.borrow_mut();
        let id = entries.len() as u32;
        entries.push(Arc::new(TypeEntry {
            ty: Type::Struct(id),
            bytes,
            align,
            offsets,
            field_ids: Some(field_ids.to_vec()),
            raw: Box::new(raw),
        }));
        Ok(id)
    }
}

fn int_ffi(bits: u16, signed: bool) -> Result<(usize, u16)> {
    let pair = match (bits, signed) {
        (8, true) => (1, raw::FFI_TYPE_SINT8),
        (8, false) => (1, raw::FFI_TYPE_UINT8),
        (16, true) => (2, raw::FFI_TYPE_SINT16),
        (16, false) => (2, raw::FFI_TYPE_UINT16),
        (32, true) => (4, raw::FFI_TYPE_SINT32),
        (32, false) => (4, raw::FFI_TYPE_UINT32),
        (64, true) => (8, raw::FFI_TYPE_SINT64),
        (64, false) => (8, raw::FFI_TYPE_UINT64),
        _ => {
            return Err(Error::fault(
                "ERR_FFI_UNSUPPORTED_LAYOUT",
                format!("unsupported integer width {bits}"),
            ))
        }
    };
    Ok(pair)
}

/// Read one value of `entry` from `address`.
///
/// # Safety
///
/// `address` must point to at least `entry.bytes` readable bytes.
pub unsafe fn read_value(entry: &TypeEntry, address: usize) -> Value {
    if address == 0 {
        return Value::Ptr(0);
    }
    match &entry.ty {
        Type::Void => Value::Void,
        Type::Int { bits, signed } => {
            let value = match *bits {
                8 if *signed => (*(address as *const i8)) as i64,
                8 => (*(address as *const u8)) as u64 as i64,
                16 if *signed => (*(address as *const i16)) as i64,
                16 => (*(address as *const u16)) as u64 as i64,
                32 if *signed => (*(address as *const i32)) as i64,
                32 => (*(address as *const u32)) as u64 as i64,
                64 if *signed => *(address as *const i64),
                _ => *(address as *const u64) as i64,
            };
            if *signed || *bits < 64 {
                Value::Int(value)
            } else {
                Value::UInt(value as u64)
            }
        }
        Type::F32 => Value::F32(*(address as *const f32)),
        Type::F64 => Value::F64(*(address as *const f64)),
        Type::Pointer(_) | Type::Callback { .. } => Value::Ptr(*(address as *const usize) as u64),
        Type::CString => {
            let pointer = *(address as *const usize);
            if pointer == 0 {
                Value::Ptr(0)
            } else {
                let bytes = std::ffi::CStr::from_ptr(pointer as *const std::ffi::c_char);
                Value::CString(bytes.to_string_lossy().into_owned())
            }
        }
        Type::Array { of, count } => {
            // Callers must use `read_in` for aggregates; a table is required to recurse.
            let _ = (of, count);
            Value::Array(Vec::new())
        }
        Type::Struct(_) => Value::Struct(Vec::new()),
    }
}

/// Read one value of `entry` from `address`, recursing through `table` for aggregates.
///
/// # Safety
///
/// `address` must point to at least `entry.bytes` readable bytes (and each pointer field, when
/// read as `cstring`, must be NUL-terminated or null).
pub unsafe fn read_in(table: &TypeTable, entry: &TypeEntry, address: usize) -> Result<Value> {
    match &entry.ty {
        Type::Array { of, count } => {
            let element = table.get(*of)?;
            let mut values = Vec::with_capacity(*count);
            for index in 0..*count {
                let offset = offset_at(entry, index);
                values.push(read_in(table, &element, address.wrapping_add(offset))?);
            }
            Ok(Value::Array(values))
        }
        Type::Struct(_) => {
            let fields = struct_field_types(table, entry)?;
            let mut values = Vec::with_capacity(fields.len());
            for (index, field) in fields.iter().enumerate() {
                let offset = offset_at(entry, index);
                values.push(read_in(table, field, address.wrapping_add(offset))?);
            }
            Ok(Value::Struct(values))
        }
        _ => Ok(read_value(entry, address)),
    }
}

/// Write one value of `entry` at `address`, recursing through `table` for aggregates.
///
/// # Safety
///
/// `address` must point to at least `entry.bytes` writable bytes.
pub unsafe fn write_in(
    table: &TypeTable,
    entry: &TypeEntry,
    address: usize,
    value: &Value,
) -> Result<()> {
    match &entry.ty {
        Type::Void => Ok(()),
        Type::Int { bits, signed } => {
            let number = match value {
                Value::Int(v) => *v,
                Value::UInt(v) => *v as i64,
                Value::Bool(v) => *v as i64,
                Value::Ptr(v) => *v as i64,
                _ => {
                    return Err(Error::fault(
                        "ERR_INVALID_ARG_TYPE",
                        "expected an integer".to_owned(),
                    ))
                }
            };
            write_int(address, *bits, *signed, number);
            Ok(())
        }
        Type::F32 => {
            let number = match value {
                Value::F32(v) => *v as f64,
                Value::F64(v) => *v,
                Value::Int(v) => *v as f64,
                Value::UInt(v) => *v as f64,
                _ => {
                    return Err(Error::fault(
                        "ERR_INVALID_ARG_TYPE",
                        "expected a number".to_owned(),
                    ))
                }
            };
            *(address as *mut f32) = number as f32;
            Ok(())
        }
        Type::F64 => {
            let number = match value {
                Value::F32(v) => *v as f64,
                Value::F64(v) => *v,
                Value::Int(v) => *v as f64,
                Value::UInt(v) => *v as f64,
                _ => {
                    return Err(Error::fault(
                        "ERR_INVALID_ARG_TYPE",
                        "expected a number".to_owned(),
                    ))
                }
            };
            *(address as *mut f64) = number;
            Ok(())
        }
        Type::Pointer(_) | Type::Callback { .. } => {
            let address_value = match value {
                Value::Ptr(v) => *v,
                Value::Int(v) => *v as u64,
                Value::UInt(v) => *v,
                _ => {
                    return Err(Error::fault(
                        "ERR_INVALID_ARG_TYPE",
                        "expected a pointer".to_owned(),
                    ))
                }
            };
            *(address as *mut usize) = address_value as usize;
            Ok(())
        }
        Type::CString => {
            // A bare `write_in` cannot own the bytes; the call path encodes strings through
            // `call::encode_value`, which keeps them alive for the call's duration.
            Err(Error::fault(
                "ERR_INVALID_ARG_TYPE",
                "a cstring can only be written through the call encoder".to_owned(),
            ))
        }
        Type::Array { of, count } => {
            let element = table.get(*of)?;
            let values = match value {
                Value::Array(values) => values,
                _ => {
                    return Err(Error::fault(
                        "ERR_INVALID_ARG_TYPE",
                        "expected an array".to_owned(),
                    ))
                }
            };
            for (index, value) in values.iter().take(*count).enumerate() {
                let offset = offset_at(entry, index);
                write_in(table, &element, address.wrapping_add(offset), value)?;
            }
            Ok(())
        }
        Type::Struct(_) => {
            let fields = struct_field_types(table, entry)?;
            let values = match value {
                Value::Struct(values) => values,
                _ => {
                    return Err(Error::fault(
                        "ERR_INVALID_ARG_TYPE",
                        "expected a struct".to_owned(),
                    ))
                }
            };
            for (index, field) in fields.iter().enumerate() {
                let Some(value) = values.get(index) else {
                    break;
                };
                let offset = offset_at(entry, index);
                write_in(table, field, address.wrapping_add(offset), value)?;
            }
            Ok(())
        }
    }
}

/// The field types of a struct entry, in declaration order.
fn struct_field_types(table: &TypeTable, entry: &TypeEntry) -> Result<Vec<Arc<TypeEntry>>> {
    // The struct's field types are not stored on the entry: they were consumed to build the
    // `ffi_type` tree. `Struct` values carry their own shape, so this lookup is only needed for
    // decoding a raw struct, which happens for struct returns and view reads. The entry keeps
    // offsets; recover the fields from the recorded `Type` is impossible, so struct decoding is
    // driven by a parallel field-id list kept on the entry.
    let ids = entry.field_ids.as_deref().ok_or_else(|| {
        Error::fault(
            "ERR_FFI_UNSUPPORTED_LAYOUT",
            "struct has no field table".to_owned(),
        )
    })?;
    ids.iter().map(|id| table.get(*id)).collect()
}

fn offset_at(entry: &TypeEntry, index: usize) -> usize {
    entry.offsets.get(index).copied().unwrap_or(0)
}

unsafe fn write_int(address: usize, bits: u16, signed: bool, value: i64) {
    match (bits, signed) {
        (8, true) => *(address as *mut i8) = value as i8,
        (8, false) => *(address as *mut u8) = value as u8,
        (16, true) => *(address as *mut i16) = value as i16,
        (16, false) => *(address as *mut u16) = value as u16,
        (32, true) => *(address as *mut i32) = value as i32,
        (32, false) => *(address as *mut u32) = value as u32,
        (64, true) => *(address as *mut i64) = value,
        _ => *(address as *mut u64) = value as u64,
    }
}
