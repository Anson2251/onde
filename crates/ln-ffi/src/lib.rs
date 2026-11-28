//! FFI for onde's `onde:ffi`, engine-free.
//!
//! This crate owns everything that must be exactly right about the C ABI — `dlopen` handles,
//! `ffi_type` trees, struct layout, call frames, closures and `errno` — and nothing about
//! JavaScript. The host (`crates/ln-runtime/src/host/ffi.rs`) converts values; `js/lib/ffi.js`
//! owns the public API and the inference rules. Keeping the split there is what makes the unsafe
//! part testable without an engine (`cargo test -p ln-ffi`).
//!
//! # The three unsafe claims
//!
//! 1. **A symbol address is valid while its [`Library`] is alive.** The host never calls a closed
//!    handle; `js/lib/ffi.js` throws `ERR_FFI_CLOSED` first.
//! 2. **An argument buffer is at least `sizeof(type)` and correctly aligned.** [`call::invoke`]
//!    owns the arena and computes both from the registered [`TypeTable`] entry.
//! 3. **A callback's `user_data` outlives the trampoline.** [`closure::Closure`] boxes it and
//!    frees it only on `close()`, after which C must not call the pointer again.
//!
//! Layout is not an unsafe claim: it is libffi's `ffi_get_struct_offsets` answer for the target
//! ABI, checked against a compiled C oracle on both CI platforms.

// The supported platform set is a compile-time fact here, not a documentation claim. A build for
// an untested OS or ABI mapping stops with a clear message instead of guessing.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
compile_error!("ln-ffi currently supports macOS and Linux; see docs/ffi-plan.md §13");

mod call;
mod closure;
mod errno;
mod error;
mod library;
mod raw;
mod types;

pub use call::{contains_inline_array, encode_return, invoke, prepare, Plan};
pub use closure::Closure;
pub use errno::{last_errno, set_errno};
pub use error::{Error, Result};
pub use library::{Declaration, Library, MAX_PLANS_PER_SYMBOL};
pub use types::{read_in, write_in, AbiClass, Type, TypeEntry, TypeTable, Value};

/// `sizeof` and `_Alignof` for a registered type, for `typeInfo`.
pub fn type_info(entry: &TypeEntry) -> (usize, usize) {
    (entry.bytes, entry.align)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn int(bits: u16, signed: bool) -> Type {
        Type::Int { bits, signed }
    }

    #[test]
    fn scalar_sizes_are_the_lp64_ones() {
        let table = TypeTable::new();
        let i32_id = table.register(int(32, true)).unwrap();
        let i64_id = table.register(int(64, true)).unwrap();
        let f64_id = table.register(Type::F64).unwrap();
        let ptr_id = table.register(Type::Pointer(None)).unwrap();
        assert_eq!(table.get(i32_id).unwrap().bytes, 4);
        assert_eq!(table.get(i64_id).unwrap().bytes, 8);
        assert_eq!(table.get(f64_id).unwrap().bytes, 8);
        assert_eq!(
            table.get(ptr_id).unwrap().bytes,
            std::mem::size_of::<usize>()
        );
        assert_eq!(
            table.get(ptr_id).unwrap().align,
            std::mem::align_of::<usize>()
        );
    }

    #[test]
    fn struct_layout_asks_libffi() {
        let table = TypeTable::new();
        let u8_id = table.register(int(8, false)).unwrap();
        let i32_id = table.register(int(32, true)).unwrap();
        let f64_id = table.register(Type::F64).unwrap();
        let ptr_id = table.register(Type::Pointer(None)).unwrap();

        // char, int32, double, void*
        let struct_id = table
            .define_struct(&[u8_id, i32_id, f64_id, ptr_id])
            .unwrap();
        let entry = table.get(struct_id).unwrap();
        // The exact offsets are the C oracle's job; these are the LP64 invariants every target
        // in scope shares, and they catch a transposed offset array.
        assert_eq!(entry.offsets[0], 0);
        assert!(entry.offsets[1] >= 4);
        assert!(entry.offsets[2] >= 8);
        assert_eq!(entry.offsets[2] % 8, 0);
        assert!(entry.bytes >= 24);
        assert_eq!(entry.align, 8);
    }

    #[test]
    fn inline_array_is_a_repeated_struct() {
        let table = TypeTable::new();
        let u8_id = table.register(int(8, false)).unwrap();
        let array_id = table
            .register(Type::Array {
                of: u8_id,
                count: 8,
            })
            .unwrap();
        let entry = table.get(array_id).unwrap();
        assert_eq!(entry.bytes, 8);
        assert_eq!(entry.align, 1);
        assert_eq!(entry.offsets, vec![0, 1, 2, 3, 4, 5, 6, 7]);
    }

    #[test]
    fn identical_scalar_types_are_interned() {
        let table = TypeTable::new();
        let a = table.register(int(32, true)).unwrap();
        let b = table.register(int(32, true)).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn plans_refuse_arrays_by_value() {
        let table = TypeTable::new();
        let u8_id = table.register(int(8, false)).unwrap();
        let array_id = table
            .register(Type::Array {
                of: u8_id,
                count: 4,
            })
            .unwrap();
        let error = prepare(&table, &[array_id], 0, None).err().unwrap();
        assert_eq!(error.code, "ERR_FFI_UNSUPPORTED_LAYOUT");

        // The same array as a struct field is a legal layout, but passing the struct by value is
        // refused for the reason in the plan: libffi's array emulation is documented for struct
        // members, not for arguments.
        let struct_id = table.define_struct(&[array_id]).unwrap();
        let error = prepare(&table, &[struct_id], 0, None).err().unwrap();
        assert_eq!(error.code, "ERR_FFI_UNSUPPORTED_LAYOUT");
    }

    #[test]
    fn abi_class_refinement_matches_the_table() {
        assert!(AbiClass::Pointer.refines(AbiClass::Pointer));
        assert!(AbiClass::Int(8).refines(AbiClass::Int(8)));
        assert!(!AbiClass::Int(64).refines(AbiClass::Int(32)));
        assert!(!AbiClass::Int(32).refines(AbiClass::Pointer));
        assert!(!AbiClass::F32.refines(AbiClass::F64));
        assert!(AbiClass::Void.refines(AbiClass::Void));
    }
}
