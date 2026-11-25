//! Compiled mode: an isolate whose modules come from a payload instead of the disk.
//!
//! These tests close the loop the standalone build depends on: `ln-engine` compiles modules to
//! bytecode, `ln-payload` packs them, and `Isolate::run_payload` runs the result the way a linked
//! executable does. They run in-process, but the code path is the same one `onde_main_payload`
//! takes — including the engine-identity check that protects `JS_ReadObject`.

use ln_engine::compile;
use ln_payload::{Builder, Codec, Kind, Parsed, Payload};
use ln_runtime::{Config, Failure, Isolate, PayloadBytes};

fn compile_module(key: &str, source: &str, strip_source: bool) -> Vec<u8> {
    let options = compile::Options {
        name: format!("file:///{key}"),
        strip_source,
        endian: compile::Options::new(key).endian,
    };
    compile::module(source, &options).expect("module compiles")
}

/// Build a payload whose modules are bytecode (the default) or source (`--no-bytecode`).
fn payload(entry: &str, modules: &[(&str, &str)], kind: Kind) -> &'static [u8] {
    let mut builder = Builder::new(&ln_engine::engine_stamp_parsed()).expect("builder");
    for (key, source) in modules {
        let body = match kind {
            Kind::Bytecode => compile_module(key, source, false),
            Kind::Source => source.as_bytes().to_vec(),
        };
        builder.push(key, kind, &body).expect("push");
    }
    builder.set_entry(entry).expect("entry");
    let image = builder.build().expect("payload builds");
    Box::leak(image.into_boxed_slice())
}

fn run(payload: &'static [u8]) -> (i32, Result<(), Failure>) {
    let mut config = Config::new(vec!["app".to_owned(), "app".to_owned()]);
    config.payload = Some(PayloadBytes(payload));
    let mut isolate = match Isolate::new(config) {
        Ok(isolate) => isolate,
        Err(failure) => return (failure.exit_code(), Err(failure)),
    };
    match isolate.run_payload() {
        Ok(outcome) => (outcome.exit_code, Ok(())),
        Err(failure) => (failure.exit_code(), Err(failure)),
    }
}

#[test]
fn runs_an_entry_that_imports_another_payload_module() {
    let payload = payload(
        "entry.js",
        &[
            (
                "entry.js",
                "import { value } from './helper.js';\nprocess.exit(value + 1);\n",
            ),
            ("helper.js", "export const value = 41;\n"),
        ],
        Kind::Bytecode,
    );
    assert_eq!(run(payload).0, 42);
}

#[test]
fn import_meta_names_come_from_the_key_table() {
    let payload = payload(
        "entry.js",
        &[(
            "entry.js",
            "const ok = import.meta.url === 'file:///entry.js'\n\
             && import.meta.filename === 'entry.js'\n\
             && import.meta.dirname === '.'\n\
             && import.meta.main === true;\n\
             process.exit(ok ? 0 : 9);\n",
        )],
        Kind::Bytecode,
    );
    assert_eq!(run(payload).0, 0);
}

#[test]
fn a_nested_key_gets_a_directory_name() {
    let payload = payload(
        "src/entry.js",
        &[
            (
                "src/entry.js",
                "import { ok } from './deep/helper.js';\nprocess.exit(ok ? 0 : 9);\n",
            ),
            (
                "src/deep/helper.js",
                "export const ok = import.meta.filename === 'src/deep/helper.js'\n\
                 && import.meta.dirname === 'src/deep';\n",
            ),
        ],
        Kind::Bytecode,
    );
    assert_eq!(run(payload).0, 0);
}

#[test]
fn builtins_resolve_with_or_without_the_node_prefix() {
    let payload = payload(
        "entry.js",
        &[(
            "entry.js",
            "import { join } from 'node:path';\n\
             import { basename } from 'path';\n\
             process.exit(join('a', 'b') === 'a/b' && basename('x/y.js') === 'y.js' ? 0 : 9);\n",
        )],
        Kind::Bytecode,
    );
    assert_eq!(run(payload).0, 0);
}

#[test]
fn a_missing_module_fails_before_user_code_runs() {
    let payload = payload(
        "entry.js",
        &[(
            "entry.js",
            "import { x } from './missing.js';\nprocess.exit(0);\n",
        )],
        Kind::Bytecode,
    );
    assert_eq!(run(payload).0, 1);
}

#[test]
fn source_modules_work_without_bytecode() {
    let payload = payload(
        "entry.js",
        &[
            (
                "entry.js",
                "import { value } from './helper.js';\nprocess.exit(value);\n",
            ),
            ("helper.js", "export const value = 5;\n"),
        ],
        Kind::Source,
    );
    assert_eq!(run(payload).0, 5);
}

#[test]
fn stripped_source_bytecode_still_runs() {
    let entry = compile_module("entry.js", "process.exit(3);", true);
    let mut builder = Builder::new(&ln_engine::engine_stamp_parsed()).expect("builder");
    builder
        .push("entry.js", Kind::Bytecode, &entry)
        .expect("push");
    builder.set_entry("entry.js").expect("entry");
    let image: &'static [u8] = Box::leak(builder.build().expect("build").into_boxed_slice());
    assert_eq!(run(image).0, 3);
}

#[test]
fn rejects_a_payload_built_for_another_engine() {
    // A header that claims bytecode version 29 cannot be run by this engine: `Isolate::new` must
    // refuse it before the bootstrap, and the process must exit 78.
    let mut builder = Builder::new(&ln_engine::engine_stamp_parsed()).expect("builder");
    builder
        .push(
            "entry.js",
            Kind::Bytecode,
            &compile_module("entry.js", "process.exit(0);", false),
        )
        .expect("push");
    builder.set_entry("entry.js").expect("entry");
    let mut image = builder.build().expect("build");
    image[12] = 29; // bc_version
    let image: &'static [u8] = Box::leak(image.into_boxed_slice());

    let (code, failure) = run(image);
    assert_eq!(code, 78);
    let message = failure.expect_err("must fail").to_string();
    assert!(message.contains("bytecode version 29"), "{message}");
}

#[test]
fn rejects_a_payload_with_an_unknown_atom_table() {
    let mut builder = Builder::new(&ln_engine::engine_stamp_parsed()).expect("builder");
    builder
        .push(
            "entry.js",
            Kind::Bytecode,
            &compile_module("entry.js", "process.exit(0);", false),
        )
        .expect("push");
    builder.set_entry("entry.js").expect("entry");
    let mut image = builder.build().expect("build");
    image[16] = 0xde;
    image[17] = 0xad;
    image[18] = 0xbe;
    image[19] = 0xef;
    let image: &'static [u8] = Box::leak(image.into_boxed_slice());
    assert_eq!(run(image).0, 78);
}

#[test]
fn rejects_a_truncated_payload_without_reading_bytecode() {
    let payload = payload(
        "entry.js",
        &[("entry.js", "process.exit(0);\n")],
        Kind::Bytecode,
    );
    let truncated: &'static [u8] =
        Box::leak(payload[..payload.len() - 3].to_vec().into_boxed_slice());
    let (code, failure) = run(truncated);
    assert_eq!(code, 1);
    assert!(failure
        .expect_err("must fail")
        .to_string()
        .contains("bad payload"));
}

#[cfg(feature = "zlib-payload")]
#[test]
fn a_compressed_payload_runs() {
    let image = payload(
        "entry.js",
        &[
            (
                "entry.js",
                "import { value } from './helper.js';\nprocess.exit(value);\n",
            ),
            ("helper.js", "export const value = 6;\n"),
        ],
        Kind::Bytecode,
    );
    let compressed = ln_payload::compress(image, Codec::Zlib, |raw| {
        ln_zlib::compress(ln_zlib::Format::Zlib, raw, 6)
            .map_err(|error| ln_payload::Error::from_message(error.to_string()))
    })
    .expect("compress");
    let bytes: &'static [u8] = Box::leak(compressed.into_boxed_slice());
    assert_eq!(run(bytes).0, 6);
}

#[test]
fn the_payload_round_trips_through_the_parser() {
    let payload = payload(
        "entry.js",
        &[
            ("entry.js", "export {};\n"),
            ("chunks/a.js", "export const a = 1;\n"),
        ],
        Kind::Bytecode,
    );
    let Parsed::Image(image) = Payload::parse(payload).expect("parses") else {
        panic!("expected an uncompressed payload");
    };
    assert_eq!(image.entry().key, "entry.js");
    assert_eq!(image.header().bc_version, 28);
}
