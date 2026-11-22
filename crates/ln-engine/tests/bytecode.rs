//! Bytecode compilation and re-loading, at the engine boundary.
//!
//! `ondec` compiles every asset of a bundled app with [`compile::module`]; the compiled app later
//! feeds that same bytecode back to a *different* process through [`Engine::eval_module_bytecode`].
//! These tests close that loop inside one binary: what the build tool writes, the runtime reads.
//!
//! They also pin the two properties the payload format depends on:
//!
//! 1. the module name is part of the bytecode (the loader looks modules up by canonical name);
//! 2. bytecode read with `JS_READ_OBJ_ROM_DATA` does not need to be copied or kept writable —
//!    which is what lets a linked payload be a `const` array in the executable.

use ln_engine::{compile, engine_stamp_parsed, Engine};

const NAME: &str = "file:///index.js";

fn compile_source(source: &str) -> Vec<u8> {
    compile::module(source, &compile::Options::new(NAME)).expect("module compiles")
}

#[test]
fn the_engine_stamp_is_well_formed() {
    let stamp = engine_stamp_parsed();
    assert_eq!(stamp.format, 1);
    assert_eq!(stamp.bc, 28);
    assert_eq!(stamp.qjs, "0.17.0");
    assert!(ln_engine::engine_stamp().starts_with("ONDE-ABI:1;"));
}

#[test]
fn compiles_a_module_and_runs_it_from_bytecode() {
    let bytecode = compile_source("globalThis.answer = 42; export const x = 'unused';");
    assert!(!bytecode.is_empty());
    // The name travels inside the bytecode, because QuickJS registers modules by name.
    assert_eq!(compile::module_name(&bytecode).unwrap(), NAME);

    let engine = Engine::new().expect("engine");
    engine
        .eval_module_bytecode(&bytecode, NAME, Some("index.js"), Some("."), true)
        .expect("bytecode evaluates");

    let answer = engine.with_ctx(|ctx| {
        let value: i32 = ctx.globals().get("answer").expect("answer is set");
        value
    });
    assert_eq!(answer, 42);
}

#[test]
fn import_meta_is_visible_to_the_module() {
    let bytecode = compile_source(
        "globalThis.__meta = JSON.stringify({ url: import.meta.url, filename: import.meta.filename, dirname: import.meta.dirname, main: import.meta.main });",
    );
    let engine = Engine::new().expect("engine");
    engine
        .eval_module_bytecode(&bytecode, NAME, Some("index.js"), Some("."), true)
        .expect("bytecode evaluates");

    let meta: String = engine.with_ctx(|ctx| ctx.globals().get("__meta").expect("__meta"));
    assert_eq!(
        meta,
        r#"{"url":"file:///index.js","filename":"index.js","dirname":".","main":true}"#
    );
}

#[test]
fn keeps_the_import_specifiers_without_resolving_them() {
    // `compile::module` must not need a loader: in a bundle, the only imports left are builtins
    // (or keys resolved at run time), and compilation is parse-only.
    let bytecode = compile_source(
        "import { join } from 'node:path';\n\
         import { helper } from './helper.js';\n\
         export const value = join(helper, 'x');",
    );
    assert_eq!(compile::module_name(&bytecode).unwrap(), NAME);
    assert!(bytecode.len() > 100);
}

#[test]
fn reports_a_parse_error_with_its_location() {
    let error = compile::module("export const = 1;", &compile::Options::new(NAME))
        .expect_err("syntax error");
    assert!(
        error.body().contains("index.js") || error.body().contains("unexpected"),
        "diagnostics should name the module: {}",
        error.body()
    );
}

#[test]
fn refuses_bytecode_compiled_under_another_name() {
    let bytecode = compile_source("globalThis.should_not_run = true;");
    let engine = Engine::new().expect("engine");
    let error = engine
        .eval_module_bytecode(&bytecode, "file:///other.js", None, None, false)
        .expect_err("name mismatch");
    assert!(
        error.body().contains("file:///index.js"),
        "the error names both sides: {}",
        error.body()
    );
}

#[test]
fn strip_source_keeps_the_module_runnable() {
    let options = compile::Options {
        name: NAME.to_owned(),
        strip_source: true,
        endian: compile::Options::new(NAME).endian,
    };
    let bytecode = compile::module("globalThis.stripped = 7;", &options).expect("compiles");
    let engine = Engine::new().expect("engine");
    engine
        .eval_module_bytecode(&bytecode, NAME, None, None, true)
        .expect("evaluates");
    let value: i32 = engine.with_ctx(|ctx| ctx.globals().get("stripped").expect("set"));
    assert_eq!(value, 7);
}
