//! The `__ln_host` object: every syscall the JavaScript surface can reach.
//!
//! This is the entire host capability list for M2. It is installed as one frozen object before
//! `js/bootstrap.js` runs; the stdlib captures it (`js/README.md` documents the contract), and
//! user code is not supposed to touch it. Keeping the surface in one object makes it reviewable:
//! if a capability is not here, JavaScript cannot perform it.
//!
//! Functions here never decide scheduling (that stays in `ln-runtime`'s loop and `ln-sched`);
//! they only enqueue ids or perform a bounded syscall.
//!
//! The object is assembled from one submodule per capability family:
//!
//! * [`stdio`] — stdout/stderr writes and TTY queries;
//! * [`fs`] — the `fs` op entry points;
//! * [`crypto`] — the CPU-only crypto primitives;
//! * [`text`] — UTF-8 encode/decode for `buffer` and `TextEncoder`/`TextDecoder`;
//! * [`buffer`] — `Buffer.indexOf`/`lastIndexOf` over a borrowed slice;
//! * [`zlib`] — gzip/zlib/raw-deflate and crc32;
//! * [`net`] — `host.net`: commands to live handles (ADR-0006) plus the handle registry;
//! * [`dns`] — `host.dnsAsync`: `dns.lookup` as an op (ADR-0005).
//!
//! The module-system primitives (resolution, embedded sources, CJS evaluation) stay in this file:
//! they are part of the bootstrap handshake, not a separate capability family.

use std::cell::{Cell, RefCell};
use std::path::Path;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Instant;

use ln_engine::{cjs_wrapper, js};
use ln_modules::url as file_url;
use ln_modules::{Kind, Resolution};

use crate::handles::HandleBridge;
use crate::host_error::{
    io_error_code, io_error_message, throw_node_error, throw_node_error_value,
};
use crate::modules::{builtin_source, ModuleRuntime};
use crate::ops::{OpBridge, RequestIdAllocator};
use crate::workers::WorkerBridge;
use crate::{Bridge, ExitState, RejectionEvent};
use ln_error::NodeError;

mod buffer;
mod codec;
mod crypto;
mod dns;
mod fs;
mod net;
mod proc;
mod signal;
mod stdio;
mod text;
mod worker;
mod zlib;

/// All state a host function may touch.
pub(crate) struct HostState {
    /// The isolate's engine: `process.exit` marks its sentinel uncatchable through this.
    pub engine: Rc<ln_engine::Engine>,
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
    /// Set when JS asks for `memoryUsage`; the loop takes one sample at the next turn.
    pub memory_requested: Rc<Cell<bool>>,
    /// The isolate's single op/handle id sequence (ADR-0006 §2.1).
    pub ids: Arc<RequestIdAllocator>,
    /// The handle table: `host.net` submits commands through it (ADR-0006).
    pub handles: Rc<HandleBridge>,
    /// The worker table: `host.worker` submits spawns and messages through it (ADR-0008).
    pub workers: Rc<WorkerBridge>,
    /// Signal delivery for the main isolate.
    pub signals: Rc<crate::signals::SignalBridge>,
    /// Child processes and their pipes.
    pub procs: Rc<crate::proc::ProcBridge>,
    /// The forked child's IPC channel (if any).
    pub ipc: Rc<crate::proc::IpcBridge>,
    /// The descriptor named by `ONDE_IPC_FD`, if this is a forked child.
    pub ipc_fd: Option<i32>,
    /// `Some` when this isolate is a worker.
    pub worker: Option<Rc<crate::WorkerRole>>,
    /// async_hooks ids and the execution context (M6).
    pub async_hooks: Rc<crate::async_hooks::AsyncTracker>,
    /// True when `--async-stack-traces` started tracking before the bootstrap ran, so the
    /// stdlib must mint ids from the first callback.
    pub async_forced: bool,
}

pub(crate) fn install<'js>(
    ctx: &js::Ctx<'js>,
    state: &HostState,
    argv: &[String],
) -> js::Result<()> {
    let host = js::Object::new(ctx.clone())?;

    // --- M1 scheduler primitives -----------------------------------------------------------

    stdio::install(ctx, &host, state)?;

    {
        // The only id source JavaScript has. Ops and handles draw from the same sequence, so
        // `host.nextRequestId()` is the single way JS can mint either (m4-plan §2.1).
        let ids = state.ids.clone();
        host.set(
            "nextRequestId",
            js::Function::new(ctx.clone(), move || -> js::Result<f64> {
                Ok(ids.allocate() as f64)
            })?,
        )?;
    }

    {
        // `JS_SetUncatchableError` for the `process.exit` sentinel. JS creates the Error so it
        // has a normal stack, then marks it here; no user `catch` can intercept the unwind.
        let engine = state.engine.clone();
        host.set(
            "setUncatchable",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, value: js::Value<'js>| {
                    engine.set_uncatchable(&ctx, &value);
                },
            )?,
        )?;
    }

    {
        let exit = state.exit.clone();
        let stop = state.stop.clone();
        host.set(
            "exit",
            js::Function::new(
                ctx.clone(),
                move |_ctx: js::Ctx<'js>, code: i32| -> js::Result<()> {
                    // `process.exit` in JS throws the sentinel after this call. The host only
                    // records the request and stops the loop; it no longer throws itself.
                    exit.requested.set(true);
                    exit.exit_code.set(code);
                    stop.set(true);
                    Ok(())
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

    // --- async_hooks identity (M6) -----------------------------------------------------------
    //
    // The stdlib mints an id for every asynchronous resource it creates (a timer, a tick, an fs
    // request) and brackets the callback with `asyncEnter`/`asyncLeave`. Ids are numbers, never
    // BigInt: Node's are safe integers and user code compares them with `===`.
    {
        // `--async-stack-traces` needs ids even in a program that never loads `async_hooks`.
        let forced = state.async_forced;
        host.set(
            "asyncForced",
            js::Function::new(ctx.clone(), move || -> js::Result<bool> { Ok(forced) })?,
        )?;
    }

    {
        // Called once, when `node:async_hooks` is first loaded: starts minting and tagging ids.
        // Before this, the runtime does no async bookkeeping at all.
        let hooks = state.async_hooks.clone();
        host.set(
            "asyncStart",
            js::Function::new(ctx.clone(), move || -> js::Result<()> {
                hooks.start();
                Ok(())
            })?,
        )?;
    }

    {
        let hooks = state.async_hooks.clone();
        host.set(
            "asyncInit",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, type_name: String, trigger: f64| -> js::Result<f64> {
                    let trigger = if trigger > 0.0 {
                        Some(trigger as i64)
                    } else {
                        None
                    };
                    Ok(hooks.init_resource(&ctx, &type_name, trigger) as f64)
                },
            )?,
        )?;
    }

    {
        let hooks = state.async_hooks.clone();
        host.set(
            "asyncCurrent",
            js::Function::new(ctx.clone(), move || -> f64 { hooks.current() as f64 })?,
        )?;
    }

    {
        let hooks = state.async_hooks.clone();
        host.set(
            "asyncEnable",
            js::Function::new(ctx.clone(), move |mask: u32| -> js::Result<()> {
                hooks.set_wants(mask);
                Ok(())
            })?,
        )?;
    }

    {
        let hooks = state.async_hooks.clone();
        host.set(
            "asyncDestroy",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: f64| -> js::Result<()> {
                    hooks.destroy(&ctx, id as i64);
                    Ok(())
                },
            )?,
        )?;
    }

    {
        let hooks = state.async_hooks.clone();
        host.set(
            "asyncEnter",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: f64| -> js::Result<f64> {
                    Ok(hooks.enter(&ctx, id as i64) as f64)
                },
            )?,
        )?;
    }

    {
        let hooks = state.async_hooks.clone();
        host.set(
            "asyncLeave",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: f64, previous: f64| -> js::Result<()> {
                    hooks.leave(&ctx, id as i64, previous as i64);
                    Ok(())
                },
            )?,
        )?;
    }

    {
        let hooks = state.async_hooks.clone();
        host.set(
            "asyncInits",
            js::Function::new(ctx.clone(), move || -> f64 { hooks.inits() as f64 })?,
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
    // The Node release onde claims compatibility with. Tools gate on `process.version` and refuse
    // to run against an unknown major (npm prints a warning and takes a fallback path), so that
    // field carries this instead of onde's own version. `process.versions.onde` keeps the real one,
    // and docs/compat.md tracks where the claim is imperfect.
    host.set("nodeVersion", "v22.14.0")?;

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
                        &io_error_message(code, "chdir", std::path::Path::new(&path), &error),
                    )
                })
            },
        )?,
    )?;

    // `MessagePort.postMessage` transfer lists are validated in JS; detaching is the one engine
    // operation they need (ADR-0008 §2.3, D49).
    host.set(
        "detachBuffer",
        js::Function::new(ctx.clone(), |ctx: js::Ctx<'js>, value: js::Value<'js>| {
            ln_engine::detach_buffer(&ctx, &value);
        })?,
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
        let memory_requested = state.memory_requested.clone();
        host.set(
            "memoryUsage",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>| -> js::Result<js::Object<'js>> {
                    // The sample is taken outside the callback (see `Isolate`); this call reports
                    // the last one and asks for the next.
                    memory_requested.set(true);
                    let used = memory.get();
                    let usage = js::Object::new(ctx.clone())?;
                    // `rss` is the OS's view (M7, D21); `heapTotal`/`heapUsed` stay on the sample
                    // taken at the top of a turn, because walking the QuickJS heap inside the
                    // callback is the cost m4-plan §8.4 removed from the loop.
                    usage.set("rss", rss_bytes())?;
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

    // --- module system ---------------------------------------------------------------------

    // --- filesystem ops --------------------------------------------------------------------

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

    fs::install(ctx, &host, state)?;

    // --- worker threads (M5, ADR-0008) ------------------------------------------------------

    worker::install(ctx, &host, state)?;

    // --- signals and process accounting (M5) ------------------------------------------------

    signal::install(ctx, &host, state)?;
    proc::install(ctx, &host, state)?;

    // --- crypto primitives -----------------------------------------------------------------

    crypto::install(ctx, &host, state)?;

    // --- compression primitives -------------------------------------------------------------

    zlib::install(ctx, &host, state)?;
    text::install(ctx, &host, state)?;
    buffer::install(ctx, &host, state)?;

    // --- network handles (M4, ADR-0006) -----------------------------------------------------

    net::install(ctx, &host, state)?;

    // --- DNS (M4, an op rather than a handle) -----------------------------------------------

    dns::install(ctx, &host, state)?;

    ctx.globals().set("__ln_host", host)?;
    Ok(())
}

/// Copy a JS argument array out so the command/op builders can index it like any other slice.
pub(super) fn collect_args<'js>(
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

/// Current resident set size in bytes, which is what `process.memoryUsage().rss` means.
///
/// Peak RSS is not a substitute: `getrusage`'s `ru_maxrss` never falls, so a soak test could not
/// show memory being released, and Node's field is current by contract (D21).
#[cfg(target_os = "macos")]
mod mach {
    // `libc` deprecates `mach_task_self` in favour of the `mach2` crate. One call is not worth a
    // dependency, and the symbol is part of libSystem; declaring it keeps the API used here to the
    // one function that has no replacement in `libc` itself.
    extern "C" {
        pub(crate) fn mach_task_self() -> u32;
    }
}

#[cfg(target_os = "macos")]
fn rss_bytes() -> u64 {
    // SAFETY: `mach_task_self` and `task_info` are pure queries. `task_info` writes the struct whole
    // when it returns 0, and the count is the struct's `natural_t` length (the mach convention), so
    // a partially written value cannot be read.
    unsafe {
        let mut info = std::mem::MaybeUninit::<libc::mach_task_basic_info>::uninit();
        let mut count = libc::MACH_TASK_BASIC_INFO_COUNT;
        let result = libc::task_info(
            mach::mach_task_self(),
            libc::MACH_TASK_BASIC_INFO,
            info.as_mut_ptr().cast(),
            &mut count,
        );
        if result == 0 {
            info.assume_init().resident_size
        } else {
            0
        }
    }
}

/// Linux: `/proc/self/statm` is `size resident shared text lib data dt`, in pages; resident is the
/// second field.
#[cfg(target_os = "linux")]
fn rss_bytes() -> u64 {
    let statm = std::fs::read_to_string("/proc/self/statm").unwrap_or_default();
    let resident = statm
        .split_whitespace()
        .nth(1)
        .and_then(|pages| pages.parse::<u64>().ok())
        .unwrap_or(0);
    // SAFETY: `sysconf` is a pure query with no pointer arguments.
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if page_size <= 0 {
        return 0;
    }
    resident.saturating_mul(page_size as u64)
}

/// Other unixes have no cheap current-RSS read here; 0 is honest and the field exists (D21).
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn rss_bytes() -> u64 {
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
