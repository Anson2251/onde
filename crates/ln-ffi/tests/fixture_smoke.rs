//! Calls the C fixture through the same path the host uses.
//!
//! Skipped unless `ONDE_FFI_FIXTURE` names a built fixture library; `test/ffi/run.sh` builds it
//! and sets the variable, so `cargo test` alone stays dependency-free.

use std::path::Path;

use ln_ffi::{invoke, Library, Type, TypeTable, Value};

fn fixture() -> Option<String> {
    std::env::var("ONDE_FFI_FIXTURE").ok()
}

fn int(bits: u16, signed: bool) -> Type {
    Type::Int { bits, signed }
}

#[test]
fn scalar_returns_and_arguments() {
    let Some(path) = fixture() else {
        eprintln!("ONDE_FFI_FIXTURE is unset; skipping");
        return;
    };
    assert!(Path::new(&path).exists(), "fixture {path} does not exist");
    let table = TypeTable::new();
    let i32_id = table.register(int(32, true)).unwrap();
    let i64_id = table.register(int(64, true)).unwrap();
    let u64_id = table.register(int(64, false)).unwrap();
    let f32_id = table.register(Type::F32).unwrap();
    let f64_id = table.register(Type::F64).unwrap();
    let mut library = Library::open(&path).expect("open fixture");

    let address = library.address_of("fixture_add_i32").unwrap();
    let plan = library
        .plan(
            &table,
            "fixture_add_i32",
            &[i32_id, i32_id],
            i32_id,
            None,
            "i32,i32",
        )
        .unwrap();
    let (value, _) = invoke(&plan, &table, address, &[Value::Int(20), Value::Int(22)]).unwrap();
    assert_eq!(value, Value::Int(42));

    let address = library.address_of("fixture_ret_i64_min").unwrap();
    let _ = &library;
    let plan = library
        .plan(&table, "fixture_ret_i64_min", &[], i64_id, None, "")
        .unwrap();
    let (value, _) = invoke(&plan, &table, address, &[]).unwrap();
    assert_eq!(value, Value::Int(i64::MIN));

    let address = library.address_of("fixture_ret_u64_max").unwrap();
    let plan = library
        .plan(&table, "fixture_ret_u64_max", &[], u64_id, None, "")
        .unwrap();
    let (value, _) = invoke(&plan, &table, address, &[]).unwrap();
    assert_eq!(value, Value::UInt(u64::MAX));

    let address = library.address_of("fixture_mul_f64").unwrap();
    let plan = library
        .plan(
            &table,
            "fixture_mul_f64",
            &[f64_id, f64_id],
            f64_id,
            None,
            "f64,f64",
        )
        .unwrap();
    let (value, _) = invoke(&plan, &table, address, &[Value::F64(1.5), Value::F64(4.0)]).unwrap();
    assert_eq!(value, Value::F64(6.0));

    let address = library.address_of("fixture_mul_f32").unwrap();
    let plan = library
        .plan(
            &table,
            "fixture_mul_f32",
            &[f32_id, f32_id],
            f32_id,
            None,
            "f32,f32",
        )
        .unwrap();
    let (value, _) = invoke(&plan, &table, address, &[Value::F32(1.5), Value::F32(4.0)]).unwrap();
    assert_eq!(value, Value::F32(6.0));
}

#[test]
fn only_i64_min() {
    let Some(path) = fixture() else { return };
    let table = TypeTable::new();
    let i64_id = table.register(int(64, true)).unwrap();
    let mut library = Library::open(&path).expect("open fixture");
    let address = library.address_of("fixture_ret_i64_min").unwrap();
    let _ = &library;
    let plan = library
        .plan(&table, "fixture_ret_i64_min", &[], i64_id, None, "x")
        .unwrap();
    let (value, _) = invoke(&plan, &table, address, &[]).unwrap();
    eprintln!("value = {value:?} address={address:#x}");
    assert_eq!(value, Value::Int(i64::MIN));
}
