//! The `__ln_host` object: every syscall the JavaScript surface can reach.
//!
//! This is the entire host capability list for M2. It is installed as one frozen object before
//! `js/bootstrap.js` runs; the stdlib captures it (`js/README.md` documents the contract), and
//! user code is not supposed to touch it. Keeping the surface in one object makes it reviewable:
//! if a capability is not here, JavaScript cannot perform it.
//!
//! Functions here never decide scheduling (that stays in `ln-runtime`'s loop and `ln-sched`);
//! they only enqueue ids or perform a bounded syscall.

use std::cell::{Cell, RefCell};
use std::io::{self, IsTerminal, Write};
use std::path::Path;
use std::rc::Rc;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

use ln_engine::{cjs_wrapper, js};
use ln_error::NodeError;
use ln_modules::url as file_url;
use ln_modules::{Kind, Resolution};

use crate::args;
use crate::host_crypto::{self, CryptoState};
use crate::host_error::{
    io_error_code, io_error_message, throw_node_error, throw_node_error_value,
};
use crate::modules::{builtin_source, ModuleRuntime};
use crate::ops::{build_op, op_value_to_js, OpBridge};
use crate::{Bridge, ExitState, RejectionEvent};

/// All state a host function may touch.
pub(crate) struct HostState {
    pub driver: Rc<RefCell<ln_sched::Driver>>,
    pub bridge: Rc<RefCell<Bridge>>,
    pub exit: Rc<ExitState>,
    pub stop: Rc<Cell<bool>>,
    pub start: Instant,
    pub modules: Rc<ModuleRuntime>,
    /// The async-op bridge: shared result slots, abort flags and the offload pool.
    pub ops: Rc<OpBridge>,
    /// Cached engine heap size, refreshed between JS calls (see `Isolate::refresh_memory`).
    pub memory: Rc<Cell<usize>>,
}

pub(crate) fn install<'js>(
    ctx: &js::Ctx<'js>,
    state: &HostState,
    argv: &[String],
) -> js::Result<()> {
    let host = js::Object::new(ctx.clone())?;

    // --- M1 scheduler primitives -----------------------------------------------------------

    host.set(
        "write",
        js::Function::new(
            ctx.clone(),
            |text: String, is_err: bool| -> js::Result<()> {
                let mut stream: Box<dyn Write> = if is_err {
                    Box::new(io::stderr())
                } else {
                    Box::new(io::stdout())
                };
                let _ = write!(stream, "{text}");
                let _ = stream.flush();
                Ok(())
            },
        )?,
    )?;

    {
        let exit = state.exit.clone();
        let stop = state.stop.clone();
        host.set(
            "exit",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, code: i32| -> js::Result<js::Undefined> {
                    exit.requested.set(true);
                    exit.exit_code.set(code);
                    stop.set(true);
                    let sentinel = js::String::from_str(ctx.clone(), crate::EXIT_SENTINEL)?;
                    Err(ctx.throw(sentinel.into_value()))
                },
            )?,
        )?;
    }

    {
        let exit = state.exit.clone();
        host.set(
            "setExitCode",
            js::Function::new(ctx.clone(), move |code: i32| -> js::Result<()> {
                exit.exit_code.set(code);
                Ok(())
            })?,
        )?;
    }

    {
        let bridge = state.bridge.clone();
        host.set(
            "nextTick",
            js::Function::new(ctx.clone(), move |callback: u64| -> js::Result<()> {
                bridge.borrow_mut().ticks.push(callback);
                Ok(())
            })?,
        )?;
    }

    {
        let driver = state.driver.clone();
        host.set(
            "setTimer",
            js::Function::new(
                ctx.clone(),
                move |callback: u64, delay_ms: f64, repeat: bool| -> js::Result<u64> {
                    let delay = std::time::Duration::from_millis(delay_ms.max(0.0) as u64);
                    let id = driver.borrow_mut().schedule_timer(
                        Instant::now(),
                        delay,
                        repeat.then_some(delay),
                        true,
                        callback,
                    );
                    Ok(id.0)
                },
            )?,
        )?;
    }

    {
        let driver = state.driver.clone();
        host.set(
            "clearTimer",
            js::Function::new(ctx.clone(), move |id: u64| -> js::Result<bool> {
                Ok(driver.borrow_mut().clear_timer(ln_sched::TimerId(id)))
            })?,
        )?;
    }

    {
        let driver = state.driver.clone();
        host.set(
            "timerRef",
            js::Function::new(
                ctx.clone(),
                move |id: u64, refed: bool| -> js::Result<bool> {
                    Ok(driver
                        .borrow_mut()
                        .set_timer_ref(ln_sched::TimerId(id), refed)
                        .is_some())
                },
            )?,
        )?;
    }

    {
        let driver = state.driver.clone();
        host.set(
            "setImmediate",
            js::Function::new(ctx.clone(), move |callback: u64| -> js::Result<u64> {
                Ok(driver.borrow_mut().schedule_immediate(callback).0)
            })?,
        )?;
    }

    {
        let driver = state.driver.clone();
        host.set(
            "clearImmediate",
            js::Function::new(ctx.clone(), move |id: u64| -> js::Result<bool> {
                Ok(driver
                    .borrow_mut()
                    .clear_immediate(ln_sched::ImmediateId(id)))
            })?,
        )?;
    }

    {
        let driver = state.driver.clone();
        host.set(
            "immediateRef",
            js::Function::new(
                ctx.clone(),
                move |id: u64, refed: bool| -> js::Result<bool> {
                    Ok(driver
                        .borrow_mut()
                        .set_immediate_ref(ln_sched::ImmediateId(id), refed)
                        .is_some())
                },
            )?,
        )?;
    }

    {
        let bridge = state.bridge.clone();
        host.set(
            "reject",
            js::Function::new(
                ctx.clone(),
                move |id: u64, reason: String| -> js::Result<()> {
                    bridge
                        .borrow_mut()
                        .rejections
                        .push(RejectionEvent::Reject { id, reason });
                    Ok(())
                },
            )?,
        )?;
    }

    {
        let bridge = state.bridge.clone();
        host.set(
            "handle",
            js::Function::new(ctx.clone(), move |id: u64| -> js::Result<()> {
                bridge
                    .borrow_mut()
                    .rejections
                    .push(RejectionEvent::Handle { id });
                Ok(())
            })?,
        )?;
    }

    // --- identity and environment ----------------------------------------------------------

    let argv_array = js::Array::new(ctx.clone())?;
    for (index, argument) in argv.iter().enumerate() {
        argv_array.set(index, argument.as_str())?;
    }
    host.set("argv", argv_array)?;
    host.set("platform", crate::platform())?;
    host.set("pid", std::process::id())?;
    host.set("ppid", parent_pid())?;
    host.set("version", format!("v{}", env!("CARGO_PKG_VERSION")))?;

    host.set(
        "env",
        js::Function::new(
            ctx.clone(),
            |ctx: js::Ctx<'js>| -> js::Result<js::Object<'js>> {
                let env = js::Object::new(ctx.clone())?;
                let mut variables: Vec<(String, String)> = std::env::vars().collect();
                variables.sort_by(|a, b| a.0.cmp(&b.0));
                for (key, value) in variables {
                    env.set(key.as_str(), value.as_str())?;
                }
                Ok(env)
            },
        )?,
    )?;

    host.set(
        "cwd",
        js::Function::new(ctx.clone(), || -> js::Result<String> {
            Ok(std::env::current_dir()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|_| ".".to_owned()))
        })?,
    )?;

    host.set(
        "chdir",
        js::Function::new(
            ctx.clone(),
            |ctx: js::Ctx<'js>, path: String| -> js::Result<()> {
                std::env::set_current_dir(&path).map_err(|error| {
                    let code = io_error_code(&error);
                    throw_node_error(
                        &ctx,
                        code,
                        &io_error_message(code, "chdir", Path::new(&path), &error),
                    )
                })
            },
        )?,
    )?;

    let start = state.start;
    host.set(
        "hrtimeNs",
        js::Function::new(ctx.clone(), move || -> js::Result<String> {
            Ok(start.elapsed().as_nanos().to_string())
        })?,
    )?;

    {
        let memory = state.memory.clone();
        host.set(
            "memoryUsage",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>| -> js::Result<js::Object<'js>> {
                    let used = memory.get();
                    let usage = js::Object::new(ctx.clone())?;
                    // RSS is the engine heap until M7 adds an OS-level measurement; the field exists
                    // so code reading `memoryUsage()` keeps working.
                    usage.set("rss", used)?;
                    usage.set("heapTotal", used)?;
                    usage.set("heapUsed", used)?;
                    usage.set("external", 0)?;
                    usage.set("arrayBuffers", 0)?;
                    Ok(usage)
                },
            )?,
        )?;
    }

    host.set(
        "osInfo",
        js::Function::new(
            ctx.clone(),
            |ctx: js::Ctx<'js>| -> js::Result<js::Object<'js>> {
                let info = js::Object::new(ctx.clone())?;
                let platform = crate::platform();
                info.set("platform", platform)?;
                info.set("arch", node_arch())?;
                info.set("type", os_type(platform))?;
                info.set("release", os_release())?;
                info.set(
                    "endianness",
                    if cfg!(target_endian = "little") {
                        "LE"
                    } else {
                        "BE"
                    },
                )?;
                info.set("homedir", home_dir())?;
                info.set("tmpdir", temp_dir())?;
                info.set("hostname", hostname())?;
                info.set("shell", std::env::var("SHELL").ok())?;
                info.set("username", username())?;
                info.set("uid", current_uid())?;
                info.set("gid", current_gid())?;
                info.set(
                    "cpus",
                    std::thread::available_parallelism()
                        .map(|count| count.get())
                        .unwrap_or(1),
                )?;
                info.set("totalmem", total_memory())?;
                info.set("freemem", free_memory())?;
                info.set("uptime", 0.0f64)?;
                Ok(info)
            },
        )?,
    )?;

    host.set(
        "isTTY",
        js::Function::new(ctx.clone(), |fd: u8| -> js::Result<bool> {
            Ok(match fd {
                0 => io::stdin().is_terminal(),
                1 => io::stdout().is_terminal(),
                _ => io::stderr().is_terminal(),
            })
        })?,
    )?;

    host.set(
        "columns",
        js::Function::new(ctx.clone(), |fd: u8| -> js::Result<u32> {
            let tty = match fd {
                0 => io::stdin().is_terminal(),
                1 => io::stdout().is_terminal(),
                _ => io::stderr().is_terminal(),
            };
            if !tty {
                return Ok(0);
            }
            Ok(std::env::var("COLUMNS")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(0))
        })?,
    )?;

    // --- module system ---------------------------------------------------------------------

    {
        let modules = state.modules.clone();
        host.set(
            "resolve",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      specifier: String,
                      from: String,
                      kind: String|
                      -> js::Result<js::Value<'js>> {
                    let kind = if kind == "import" {
                        Kind::Import
                    } else {
                        Kind::Require
                    };
                    let resolution = modules
                        .resolver
                        .resolve(&specifier, Path::new(&from), kind)
                        .map_err(|failure| {
                            throw_node_error(&ctx, failure.code, &failure.message)
                        })?;
                    let object = js::Object::new(ctx.clone())?;
                    match resolution {
                        Resolution::Builtin(name) => {
                            object.set("type", "builtin")?;
                            object.set("name", name)?;
                        }
                        Resolution::File { path, format } => {
                            // Names the JS loader branches on: "file" is a CJS file, "esm" must
                            // be rejected by require(), "json"/"addon" have dedicated errors.
                            let kind = match format {
                                ln_modules::Format::CommonJs => "file",
                                ln_modules::Format::Module => "esm",
                                ln_modules::Format::Json => "json",
                                ln_modules::Format::Native => "addon",
                            };
                            object.set("type", kind)?;
                            object.set("path", path.display().to_string())?;
                        }
                    }
                    Ok(object.into_value())
                },
            )?,
        )?;
    }

    {
        let modules = state.modules.clone();
        host.set(
            "metaResolve",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, specifier: String, base: String| -> js::Result<String> {
                    let resolution = modules
                        .resolver
                        .resolve(&specifier, Path::new(&base), Kind::Import)
                        .map_err(|failure| {
                            throw_node_error(&ctx, failure.code, &failure.message)
                        })?;
                    Ok(match resolution {
                        Resolution::Builtin(name) => format!("node:{name}"),
                        Resolution::File { path, .. } => file_url::path_to_file_url(&path),
                    })
                },
            )?,
        )?;
    }

    host.set(
        "readFile",
        js::Function::new(
            ctx.clone(),
            |ctx: js::Ctx<'js>, path: String| -> js::Result<String> {
                std::fs::read_to_string(&path).map_err(|error| {
                    let code = io_error_code(&error);
                    throw_node_error(
                        &ctx,
                        code,
                        &io_error_message(code, "open", Path::new(&path), &error),
                    )
                })
            },
        )?,
    )?;

    host.set(
        "realpath",
        js::Function::new(
            ctx.clone(),
            |ctx: js::Ctx<'js>, path: String| -> js::Result<String> {
                std::fs::canonicalize(&path)
                    .map(|resolved| resolved.display().to_string())
                    .map_err(|error| {
                        let code = io_error_code(&error);
                        throw_node_error(
                            &ctx,
                            code,
                            &io_error_message(code, "realpath", Path::new(&path), &error),
                        )
                    })
            },
        )?,
    )?;

    host.set(
        "statKind",
        js::Function::new(ctx.clone(), |path: String| -> js::Result<Option<String>> {
            match std::fs::metadata(&path) {
                Ok(metadata) if metadata.is_file() => Ok(Some("file".to_owned())),
                Ok(metadata) if metadata.is_dir() => Ok(Some("dir".to_owned())),
                Ok(_) => Ok(Some("other".to_owned())),
                Err(_) => Ok(None),
            }
        })?,
    )?;

    host.set(
        "builtinSource",
        js::Function::new(ctx.clone(), |name: String| -> js::Result<Option<String>> {
            Ok(builtin_source(&name).map(ToOwned::to_owned))
        })?,
    )?;

    host.set(
        "builtinNames",
        js::Function::new(
            ctx.clone(),
            |ctx: js::Ctx<'js>| -> js::Result<js::Array<'js>> {
                let names = js::Array::new(ctx.clone())?;
                for (index, name) in ln_modules::BUILTINS.iter().enumerate() {
                    names.set(index, *name)?;
                }
                Ok(names)
            },
        )?,
    )?;

    host.set(
        "evalCjs",
        js::Function::new(
            ctx.clone(),
            |ctx: js::Ctx<'js>,
             filename: String,
             source: String,
             exports: js::Value<'js>,
             require: js::Value<'js>,
             module: js::Value<'js>,
             dirname: String|
             -> js::Result<()> {
                let result: js::Result<()> = (|| {
                    let mut options = js::context::EvalOptions::default();
                    options.global = true;
                    options.strict = false;
                    options.filename = Some(filename.clone());
                    let function: js::Function =
                        ctx.eval_with_options(cjs_wrapper(&source), options)?;
                    // Node calls the wrapper with `this === module.exports`; arguments are
                    // appended after the receiver, so use the explicit Args builder.
                    let mut args = js::function::Args::new(ctx.clone(), 5);
                    args.this(exports.clone())?;
                    args.push_arg(exports)?;
                    args.push_arg(require)?;
                    args.push_arg(module)?;
                    args.push_arg(filename)?;
                    args.push_arg(dirname)?;
                    function.call_arg::<()>(args)?;
                    Ok(())
                })();
                js::CatchResultExt::catch(result, &ctx).map_err(|error| error.throw(&ctx))
            },
        )?,
    )?;

    // --- filesystem ops --------------------------------------------------------------------

    // One primitive pair for every `fs` capability (`docs/m3-plan.md` §2.2). Argument
    // normalization lives in `js/lib/internal/fs.js`; `build_op` validates the array again so a
    // direct `__ln_host.fsSync` call cannot construct an invalid op.
    {
        host.set(
            "fsSync",
            js::Function::new(
                ctx.clone(),
                |ctx: js::Ctx<'js>,
                 name: js::Value<'js>,
                 args_value: js::Value<'js>|
                 -> js::Result<js::Value<'js>> {
                    let op_name = parse_op_name(&ctx, &name)?;
                    let arguments = collect_args(&ctx, &args_value)?;
                    let op = build_op(&op_name, &arguments)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let abort = AtomicBool::new(false);
                    let value = ln_io::execute(op, &abort)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    op_value_to_js(&ctx, &value)
                },
            )?,
        )?;
    }

    {
        let ops = state.ops.clone();
        host.set(
            "fsAsync",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      op_id: js::Value<'js>,
                      name: js::Value<'js>,
                      args_value: js::Value<'js>|
                      -> js::Result<()> {
                    let id = args::u64_value(Some(&op_id), "opId")
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let op_name = parse_op_name(&ctx, &name)?;
                    let arguments = collect_args(&ctx, &args_value)?;
                    let op = build_op(&op_name, &arguments)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    ops.submit(id, op);
                    Ok(())
                },
            )?,
        )?;
    }

    {
        let ops = state.ops.clone();
        host.set(
            "fsCancel",
            // Internal primitive: the JS layer owns the id it allocated, so a typed `u64` is
            // enough (a bad value is an onde bug, not a user argument).
            js::Function::new(ctx.clone(), move |op_id: u64| -> js::Result<()> {
                ops.cancel(op_id);
                Ok(())
            })?,
        )?;
    }

    // --- stdio -----------------------------------------------------------------------------

    host.set(
        "writeFd",
        js::Function::new(
            ctx.clone(),
            |ctx: js::Ctx<'js>, fd: js::Value<'js>, data: js::Value<'js>| -> js::Result<u64> {
                let fd = args::i32_value(Some(&fd), "fd")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                let bytes = args::bytes(Some(&data), "data")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                write_fd(fd, &bytes).map_err(|error| throw_node_error_value(&ctx, &error))
            },
        )?,
    )?;

    // --- crypto primitives -----------------------------------------------------------------

    // Synchronous, CPU-only and loop-free (`docs/m3-plan.md` §2.3). The id→state table lives in
    // `host_crypto`; JavaScript only ever holds the numeric handle.
    let crypto = js::Object::new(ctx.clone())?;
    let crypto_state = Rc::new(RefCell::new(CryptoState::new()));

    crypto.set(
        "randomBytes",
        js::Function::new(
            ctx.clone(),
            |ctx: js::Ctx<'js>, size: js::Value<'js>| -> js::Result<js::Value<'js>> {
                let size = args::number(Some(&size), "size")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                if !size.is_finite()
                    || !(0.0..=2_147_483_647.0).contains(&size)
                    || size.fract() != 0.0
                {
                    let error =
                        NodeError::out_of_range("size", ">= 0 && <= 2147483647", &size.to_string());
                    return Err(throw_node_error_value(&ctx, &error));
                }
                let bytes = ln_crypto::random_bytes(size as usize);
                Ok(js::TypedArray::<u8>::new(ctx.clone(), bytes)?.into_value())
            },
        )?,
    )?;

    crypto.set(
        "randomInt",
        js::Function::new(
            ctx.clone(),
            |ctx: js::Ctx<'js>, min: js::Value<'js>, max: js::Value<'js>| -> js::Result<f64> {
                let min = args::number(Some(&min), "min")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                let max = args::number(Some(&max), "max")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                let value = ln_crypto::random_int(min as i64, max as i64)
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                Ok(value as f64)
            },
        )?,
    )?;

    crypto.set(
        "randomUUID",
        js::Function::new(ctx.clone(), || -> js::Result<String> {
            Ok(ln_crypto::random_uuid())
        })?,
    )?;

    {
        let state = crypto_state.clone();
        crypto.set(
            "hashNew",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, name: js::Value<'js>| -> js::Result<u64> {
                    let name = args::string(Some(&name), "algorithm")
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let algorithm = host_crypto::algorithm(&name)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    Ok(state.borrow_mut().hash_new(algorithm))
                },
            )?,
        )?;
    }

    {
        let state = crypto_state.clone();
        crypto.set(
            "hashUpdate",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      id: js::Value<'js>,
                      data: js::Value<'js>|
                      -> js::Result<()> {
                    let id = args::u64_value(Some(&id), "id")
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let data = args::bytes(Some(&data), "data")
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    state
                        .borrow_mut()
                        .hash_update(id, &data)
                        .map_err(|error| throw_node_error_value(&ctx, &error))
                },
            )?,
        )?;
    }

    {
        let state = crypto_state.clone();
        crypto.set(
            "hashDigest",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: js::Value<'js>| -> js::Result<js::Value<'js>> {
                    let id = args::u64_value(Some(&id), "id")
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let bytes = state
                        .borrow_mut()
                        .hash_digest(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    Ok(js::TypedArray::<u8>::new(ctx.clone(), bytes)?.into_value())
                },
            )?,
        )?;
    }

    {
        let state = crypto_state.clone();
        crypto.set(
            "hashCopy",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: js::Value<'js>| -> js::Result<u64> {
                    let id = args::u64_value(Some(&id), "id")
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    state
                        .borrow_mut()
                        .hash_copy(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))
                },
            )?,
        )?;
    }

    {
        let state = crypto_state.clone();
        crypto.set(
            "hmacNew",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      name: js::Value<'js>,
                      key: js::Value<'js>|
                      -> js::Result<u64> {
                    let name = args::string(Some(&name), "algorithm")
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let algorithm = host_crypto::algorithm(&name)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let key = args::bytes(Some(&key), "key")
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    Ok(state.borrow_mut().hmac_new(algorithm, &key))
                },
            )?,
        )?;
    }

    {
        let state = crypto_state.clone();
        crypto.set(
            "hmacUpdate",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      id: js::Value<'js>,
                      data: js::Value<'js>|
                      -> js::Result<()> {
                    let id = args::u64_value(Some(&id), "id")
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let data = args::bytes(Some(&data), "data")
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    state
                        .borrow_mut()
                        .hmac_update(id, &data)
                        .map_err(|error| throw_node_error_value(&ctx, &error))
                },
            )?,
        )?;
    }

    {
        let state = crypto_state.clone();
        crypto.set(
            "hmacDigest",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: js::Value<'js>| -> js::Result<js::Value<'js>> {
                    let id = args::u64_value(Some(&id), "id")
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let bytes = state
                        .borrow_mut()
                        .hmac_digest(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    Ok(js::TypedArray::<u8>::new(ctx.clone(), bytes)?.into_value())
                },
            )?,
        )?;
    }

    crypto.set(
        "timingSafeEqual",
        js::Function::new(
            ctx.clone(),
            |ctx: js::Ctx<'js>, a: js::Value<'js>, b: js::Value<'js>| -> js::Result<bool> {
                let a = args::bytes(Some(&a), "buf1")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                let b = args::bytes(Some(&b), "buf2")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                ln_crypto::timing_safe_equal(&a, &b)
                    .map_err(|error| throw_node_error_value(&ctx, &error))
            },
        )?,
    )?;

    crypto.set(
        "hkdf",
        js::Function::new(
            ctx.clone(),
            |ctx: js::Ctx<'js>,
             name: js::Value<'js>,
             ikm: js::Value<'js>,
             salt: js::Value<'js>,
             info: js::Value<'js>,
             length: js::Value<'js>|
             -> js::Result<js::Value<'js>> {
                let name = args::string(Some(&name), "algorithm")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                let algorithm = host_crypto::algorithm(&name)
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                let ikm = args::bytes(Some(&ikm), "ikm")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                let salt = args::bytes_or_empty(Some(&salt))
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                let info = args::bytes_or_empty(Some(&info))
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                let length = args::u64_value(Some(&length), "length")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                let bytes = ln_crypto::hkdf(algorithm, &ikm, &salt, &info, length as usize)
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                Ok(js::TypedArray::<u8>::new(ctx.clone(), bytes)?.into_value())
            },
        )?,
    )?;

    host.set("crypto", crypto)?;

    ctx.globals().set("__ln_host", host)?;
    Ok(())
}

/// Throw for an `fs` op name that is not a string.
fn parse_op_name<'js>(ctx: &js::Ctx<'js>, value: &js::Value<'js>) -> js::Result<String> {
    args::string(Some(value), "name").map_err(|error| throw_node_error_value(ctx, &error))
}

/// Copy the JS argument array out so `build_op` can index it like any other slice.
fn collect_args<'js>(
    ctx: &js::Ctx<'js>,
    value: &js::Value<'js>,
) -> js::Result<Vec<js::Value<'js>>> {
    let Some(array) = value.as_array() else {
        let error = NodeError::invalid_arg_type(
            "args",
            "an instance of Array",
            crate::args::type_name(value),
        );
        return Err(throw_node_error_value(ctx, &error));
    };
    let mut values = Vec::with_capacity(array.len());
    for index in 0..array.len() {
        values.push(array.get::<js::Value<'js>>(index)?);
    }
    Ok(values)
}

/// A synchronous, retry-on-`EINTR` write of the whole buffer (`host.writeFd`).
#[cfg(unix)]
fn write_fd(fd: i32, data: &[u8]) -> Result<u64, NodeError> {
    let mut written = 0_usize;
    while written < data.len() {
        let chunk = &data[written..];
        // SAFETY: `chunk` points at live memory for exactly `chunk.len()` bytes; `write` only
        // reads from it and reports the count through its return value.
        let count = unsafe { libc::write(fd, chunk.as_ptr().cast(), chunk.len()) };
        if count < 0 {
            let errno = io::Error::last_os_error()
                .raw_os_error()
                .unwrap_or(libc::EIO);
            if errno == libc::EINTR {
                continue;
            }
            return Err(NodeError::from_errno(errno, "write", None));
        }
        written += count as usize;
    }
    Ok(written as u64)
}

#[cfg(not(unix))]
fn write_fd(fd: i32, data: &[u8]) -> Result<u64, NodeError> {
    let mut stream: Box<dyn Write> = if fd == 1 {
        Box::new(io::stdout())
    } else {
        Box::new(io::stderr())
    };
    stream
        .write_all(data)
        .map_err(|error| NodeError::system(&error, "write", Path::new("")))?;
    Ok(data.len() as u64)
}

// --- platform helpers ------------------------------------------------------------------------

fn parent_pid() -> u32 {
    #[cfg(unix)]
    {
        // SAFETY: `getppid` takes no arguments, cannot fail, and has no preconditions.
        unsafe { libc::getppid() as u32 }
    }
    #[cfg(not(unix))]
    {
        0
    }
}

fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        "arm" => "arm",
        other => other,
    }
}

fn os_type(platform: &str) -> &'static str {
    match platform {
        "darwin" => "Darwin",
        "win32" => "Windows_NT",
        _ => "Linux",
    }
}

fn home_dir() -> Option<String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
}

fn temp_dir() -> Option<String> {
    std::env::var("TMPDIR")
        .or_else(|_| std::env::var("TMP"))
        .or_else(|_| std::env::var("TEMP"))
        .ok()
        .or_else(|| {
            if cfg!(unix) {
                Some("/tmp".to_owned())
            } else {
                None
            }
        })
}

fn username() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "unknown".to_owned())
}

#[cfg(unix)]
fn current_uid() -> i64 {
    // SAFETY: `getuid` takes no arguments, cannot fail, and has no preconditions.
    unsafe { libc::getuid() as i64 }
}

#[cfg(not(unix))]
fn current_uid() -> i64 {
    -1
}

#[cfg(unix)]
fn current_gid() -> i64 {
    // SAFETY: `getgid` takes no arguments, cannot fail, and has no preconditions.
    unsafe { libc::getgid() as i64 }
}

#[cfg(not(unix))]
fn current_gid() -> i64 {
    -1
}

#[cfg(unix)]
fn hostname() -> Option<String> {
    let mut buffer = [0_u8; 256];
    // SAFETY: the pointer and length describe a live, writable array; `gethostname` only writes
    // into it and reports failure through its return value.
    let result = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) };
    if result != 0 {
        return None;
    }
    let end = buffer
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(buffer.len());
    String::from_utf8(buffer[..end].to_vec()).ok()
}

#[cfg(not(unix))]
fn hostname() -> Option<String> {
    std::env::var("COMPUTERNAME").ok()
}

#[cfg(unix)]
fn os_release() -> Option<String> {
    // SAFETY: `utsname` is a plain C struct where all-zero is a valid value, and `uname` only
    // fills the provided struct.
    let mut uname: libc::utsname = unsafe { std::mem::zeroed() };
    let result = unsafe { libc::uname(&mut uname) };
    if result != 0 {
        return None;
    }
    let string = |field: &[libc::c_char]| -> Option<String> {
        let bytes: Vec<u8> = field
            .iter()
            .take_while(|byte| **byte != 0)
            .map(|byte| *byte as u8)
            .collect();
        String::from_utf8(bytes).ok()
    };
    string(&uname.release)
}

#[cfg(not(unix))]
fn os_release() -> Option<String> {
    None
}

#[cfg(unix)]
fn total_memory() -> u64 {
    // SAFETY: `sysconf` is a pure query with no pointer arguments.
    let pages = unsafe { libc::sysconf(libc::_SC_PHYS_PAGES) };
    // SAFETY: as above.
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if pages <= 0 || page_size <= 0 {
        return 0;
    }
    (pages as u64).saturating_mul(page_size as u64)
}

#[cfg(not(unix))]
fn total_memory() -> u64 {
    0
}

#[cfg(target_os = "linux")]
fn free_memory() -> u64 {
    // SAFETY: `sysconf` is a pure query with no pointer arguments.
    let pages = unsafe { libc::sysconf(libc::_SC_AVPHYS_PAGES) };
    // SAFETY: as above.
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if pages <= 0 || page_size <= 0 {
        return 0;
    }
    (pages as u64).saturating_mul(page_size as u64)
}

#[cfg(not(target_os = "linux"))]
fn free_memory() -> u64 {
    // `_SC_AVPHYS_PAGES` is not portable (macOS has no equivalent sysconf); report 0 until M7.
    0
}
