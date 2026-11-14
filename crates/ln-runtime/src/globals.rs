//! The minimal host surface M0 needs: `console`, `process.argv`, `process.exit`,
//! `process.platform`, `process.version`.
//!
//! Everything here is installed by `ln-runtime`; `ln-engine` installs nothing (ADR-0001 §2).

use std::cell::Cell;
use std::io::Write;
use std::rc::Rc;

use ln_engine::js;
use ln_engine::js::prelude::{FromJs, IntoJs, Rest};
use ln_engine::js::{Array, Ctx, Function, Object, Undefined, Value};
use ln_engine::Engine;

/// Sentinel thrown by `process.exit` to unwind the current script.
///
/// It is a string rather than an `Error` so user code that inspects errors does not mistake it
/// for a real failure. JS can still `catch` it; the host records the exit code first and treats it
/// as authoritative at the next boundary (documented in the M0 notes).
const EXIT_SENTINEL: &str = "lite-node:process.exit";

/// Shared isolate state that JS-visible natives need to mutate.
#[derive(Default)]
pub(crate) struct State {
    /// `Some(code)` once `process.exit(code)` has been called.
    pub(crate) exit_code: Cell<Option<i32>>,
    /// Set when an uncaught error has already been reported and the drain must stop.
    pub(crate) fatal: Cell<bool>,
}

/// Install the M0 global surface.
pub(crate) fn install(
    engine: &Engine,
    argv: &[String],
    state: Rc<State>,
) -> Result<(), js::Error> {
    engine.with_ctx(|ctx| {
        install_console(&ctx)?;
        install_process(&ctx, argv, state)?;
        Ok(())
    })
}

#[derive(Clone, Copy)]
enum Stream {
    Stdout,
    Stderr,
}

fn install_console(ctx: &Ctx<'_>) -> js::Result<()> {
    let console = Object::new(ctx.clone())?;
    for (name, stream) in [
        ("log", Stream::Stdout),
        ("warn", Stream::Stderr),
        ("error", Stream::Stderr),
    ] {
        console.set(name, make_console_fn(ctx.clone(), stream)?)?;
    }
    ctx.globals().set("console", console)
}

fn make_console_fn<'js>(ctx: Ctx<'js>, stream: Stream) -> js::Result<Function<'js>> {
    Function::new(
        ctx,
        move |ctx: Ctx<'js>, args: Rest<Value<'js>>| -> js::Result<()> {
            let line = format_args(&ctx, &args.0);
            write_line(stream, &line);
            Ok(())
        },
    )
}

fn install_process(ctx: &Ctx<'_>, argv: &[String], state: Rc<State>) -> js::Result<()> {
    let process = Object::new(ctx.clone())?;

    let argv_array = Array::new(ctx.clone())?;
    for (index, arg) in argv.iter().enumerate() {
        argv_array.set(index, arg.as_str())?;
    }
    process.set("argv", argv_array)?;
    process.set("platform", platform())?;
    process.set("version", format!("v{}", env!("CARGO_PKG_VERSION")))?;
    process.set("exit", make_exit_fn(ctx.clone(), state)?)?;

    ctx.globals().set("process", process)
}

fn make_exit_fn<'js>(ctx: Ctx<'js>, state: Rc<State>) -> js::Result<Function<'js>> {
    Function::new(
        ctx,
        move |ctx: Ctx<'js>, args: Rest<Value<'js>>| -> js::Result<Undefined> {
            let code = args
                .0
                .first()
                .map(|value| coerce_exit_code(&ctx, value))
                .unwrap_or(0);
            state.exit_code.set(Some(code));
            let sentinel = js::String::from_str(ctx.clone(), EXIT_SENTINEL)?;
            Err(ctx.throw(sentinel.into_value()))
        },
    )
}

fn coerce_exit_code(ctx: &Ctx<'_>, value: &Value<'_>) -> i32 {
    if value.is_undefined() || value.is_null() {
        return 0;
    }
    match js::Coerced::<i32>::from_js(ctx, value.clone()) {
        Ok(code) => code.0,
        Err(_) => {
            // ToInt32 threw (a symbol or an object with a throwing valueOf). Clear it and use
            // Node's default of 0 rather than leaking an exception into the caller.
            let _ = ctx.catch();
            0
        }
    }
}

fn format_args(ctx: &Ctx<'_>, args: &[Value<'_>]) -> String {
    let mut line = String::new();
    for (index, value) in args.iter().enumerate() {
        if index > 0 {
            line.push(' ');
        }
        line.push_str(&format_value(ctx, value));
    }
    line
}

/// `console.log` formatting: strings raw, objects through `JSON.stringify` with a fallback to
/// `ToString`, everything else through `ToString`.
fn format_value(ctx: &Ctx<'_>, value: &Value<'_>) -> String {
    if value.is_string() {
        if let Some(string) = value.as_string() {
            if let Ok(text) = string.to_string() {
                return text;
            }
        }
    } else if value.is_object() && !value.is_function() {
        match ctx.json_stringify(value.clone()) {
            Ok(Some(json)) => {
                if let Ok(text) = json.to_string() {
                    return text;
                }
            }
            Ok(None) => {}
            Err(_) => {
                // Circular structures, BigInt, a throwing `toJSON`. Clear the pending exception
                // and fall through to ToString, which is the graceful degradation M0 promises.
                let _ = ctx.catch();
            }
        }
    }

    match js::Coerced::<js::String>::from_js(ctx, value.clone()) {
        Ok(string) => string
            .0
            .to_string()
            .unwrap_or_else(|_| "<unprintable>".to_owned()),
        Err(_) => {
            let _ = ctx.catch();
            "<unprintable>".to_owned()
        }
    }
}

fn write_line(stream: Stream, line: &str) {
    match stream {
        Stream::Stdout => {
            let mut out = std::io::stdout().lock();
            let _ = writeln!(out, "{line}");
            let _ = out.flush();
        }
        Stream::Stderr => {
            let mut err = std::io::stderr().lock();
            let _ = writeln!(err, "{line}");
            let _ = err.flush();
        }
    }
}

/// Node's `process.platform` names, not Rust's `std::env::consts::OS` names.
fn platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}
