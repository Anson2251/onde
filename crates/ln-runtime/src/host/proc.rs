//! `host.proc(id, name, args)`: child processes, their pipes and IPC (M5, ADR-0008 §2.6).
//!
//! The command surface mirrors `host.net`: one id, one name, one positional argument array,
//! synchronous validation. A missing executable is an asynchronous `error` event, not a throw
//! (Node's `spawn` contract); argument errors throw at the call site.
//!
//! `host.ipc(name, args)` is the forked child's single channel, not a handle family: fd 3 is
//! inherited at spawn time and `process.send`/`message` are process-level in Node.

use std::path::PathBuf;

use ln_engine::js;
use ln_error::NodeError;
use ln_io::proc::{Command, SpawnOptions, StdioMode, Stream};

use crate::args;
use crate::host_error::throw_node_error_value;
use crate::proc::ProcBridge;

use super::{collect_args, HostState};

pub(super) fn install<'js>(
    ctx: &js::Ctx<'js>,
    host: &js::Object<'js>,
    state: &HostState,
) -> js::Result<()> {
    host.set("procHandles", js::Object::new(ctx.clone())?)?;
    host.set("ipcFd", state.ipc_fd)?;

    let bridge = state.procs.clone();
    host.set(
        "proc",
        js::Function::new(
            ctx.clone(),
            move |ctx: js::Ctx<'js>,
                  child_id: js::Value<'js>,
                  name: js::Value<'js>,
                  args_value: js::Value<'js>|
                  -> js::Result<()> {
                let id = args::u64_value(Some(&child_id), "id")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                let name = args::string(Some(&name), "name")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                let arguments = collect_args(&ctx, &args_value)?;
                run_command(&ctx, &bridge, id, &name, &arguments)
            },
        )?,
    )?;

    let ipc = state.ipc.clone();
    let ipc_fd = state.ipc_fd;
    host.set(
        "ipc",
        js::Function::new(
            ctx.clone(),
            move |ctx: js::Ctx<'js>,
                  name: String,
                  args_value: js::Value<'js>|
                  -> js::Result<bool> {
                let arguments = collect_args(&ctx, &args_value)?;
                match name.as_str() {
                    "attach" => ipc
                        .attach(ipc_fd)
                        .map_err(|error| throw_node_error_value(&ctx, &error)),
                    "send" => {
                        let text = args::string(arguments.first(), "message")
                            .map_err(|error| throw_node_error_value(&ctx, &error))?;
                        ipc.send(text)
                            .map_err(|error| throw_node_error_value(&ctx, &error))?;
                        Ok(true)
                    }
                    "disconnect" => {
                        ipc.disconnect();
                        Ok(true)
                    }
                    "ref" => {
                        ipc.ref_channel();
                        Ok(true)
                    }
                    "unref" => {
                        ipc.unref_channel();
                        Ok(true)
                    }
                    other => Err(throw_node_error_value(
                        &ctx,
                        &NodeError::invalid_arg_value("name", other, "is not an IPC command"),
                    )),
                }
            },
        )?,
    )?;

    Ok(())
}

fn run_command<'js>(
    ctx: &js::Ctx<'js>,
    bridge: &ProcBridge,
    id: u64,
    name: &str,
    arguments: &[js::Value<'js>],
) -> js::Result<()> {
    match name {
        "spawn" => {
            let (options, ipc) = spawn_arguments(ctx, arguments)
                .map_err(|error| throw_node_error_value(ctx, &error))?;
            if ipc {
                let (parent, child) = ln_io::proc::ipc_pair().map_err(|error| {
                    throw_node_error_value(
                        ctx,
                        &NodeError::system(&error, "socketpair", std::path::Path::new("")),
                    )
                })?;
                let child_fd: std::os::fd::OwnedFd = child.into_std().into();
                bridge
                    .spawn(id, options, Some(parent), Some(child_fd))
                    .map_err(|error| throw_node_error_value(ctx, &error))?;
            } else {
                bridge
                    .spawn(id, options, None, None)
                    .map_err(|error| throw_node_error_value(ctx, &error))?;
            }
            Ok(())
        }
        "write" => {
            let stream = stream_argument(arguments.first(), "stream")
                .map_err(|error| throw_node_error_value(ctx, &error))?;
            let data = args::bytes(
                arguments.get(1).filter(|value| !value.is_undefined()),
                "data",
            )
            .map_err(|error| throw_node_error_value(ctx, &error))?;
            bridge.command(id, Command::Write { stream, data });
            Ok(())
        }
        "end" => {
            let stream = stream_argument(arguments.first(), "stream")
                .map_err(|error| throw_node_error_value(ctx, &error))?;
            bridge.command(id, Command::End { stream });
            Ok(())
        }
        "read" => {
            let stream = stream_argument(arguments.first(), "stream")
                .map_err(|error| throw_node_error_value(ctx, &error))?;
            let max = arguments
                .get(1)
                .and_then(|value| value.as_number())
                .unwrap_or(f64::from(ln_io::proc::MAX_CHUNK))
                .max(1.0) as u32;
            bridge.command(
                id,
                Command::Read {
                    stream,
                    max: max.min(ln_io::proc::MAX_CHUNK),
                },
            );
            Ok(())
        }
        "readStop" => {
            let stream = stream_argument(arguments.first(), "stream")
                .map_err(|error| throw_node_error_value(ctx, &error))?;
            bridge.command(id, Command::ReadStop { stream });
            Ok(())
        }
        "kill" => {
            let signal = arguments
                .first()
                .and_then(|value| value.as_int())
                .unwrap_or(libc::SIGTERM);
            bridge.command(id, Command::Kill { signal });
            Ok(())
        }
        "send" => {
            let text = args::string(arguments.first(), "message")
                .map_err(|error| throw_node_error_value(ctx, &error))?;
            bridge.command(
                id,
                Command::Send {
                    bytes: text.into_bytes(),
                },
            );
            Ok(())
        }
        "disconnect" => {
            bridge.command(id, Command::Disconnect);
            Ok(())
        }
        "ref" => {
            bridge.ref_child(id);
            Ok(())
        }
        "unref" => {
            bridge.unref_child(id);
            Ok(())
        }
        other => Err(throw_node_error_value(
            ctx,
            &NodeError::invalid_arg_value("name", other, "is not a process command"),
        )),
    }
}

fn stream_argument<'js>(
    value: Option<&js::Value<'js>>,
    argument: &str,
) -> Result<Stream, NodeError> {
    match args::string(value, argument)?.as_str() {
        "stdin" => Ok(Stream::Stdin),
        "stdout" => Ok(Stream::Stdout),
        "stderr" => Ok(Stream::Stderr),
        other => Err(NodeError::invalid_arg_value(
            argument,
            other,
            "is not a child stream",
        )),
    }
}

/// Parse `spawn(program, argv, cwd, env, stdio, detached, argv0, ipc)`.
fn spawn_arguments<'js>(
    ctx: &js::Ctx<'js>,
    arguments: &[js::Value<'js>],
) -> Result<(SpawnOptions, bool), NodeError> {
    let program = args::string(arguments.first(), "file")?;
    let argv = string_array(arguments.get(1), "args")?;
    let cwd = optional_string(arguments.get(2), "cwd")?.map(PathBuf::from);
    let env = environment(arguments.get(3))?;
    let stdio = stdio_modes(arguments.get(4))?;
    let detached = arguments
        .get(5)
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let argv0 = optional_string(arguments.get(6), "argv0")?;
    let ipc = arguments
        .get(7)
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let _ = ctx;
    Ok((
        SpawnOptions {
            program: PathBuf::from(program),
            args: argv,
            cwd,
            env,
            stdio,
            detached,
            argv0,
        },
        ipc,
    ))
}

fn optional_string<'js>(
    value: Option<&js::Value<'js>>,
    argument: &str,
) -> Result<Option<String>, NodeError> {
    match value {
        Some(value) if !value.is_undefined() && !value.is_null() => {
            Ok(Some(args::string(Some(value), argument)?))
        }
        _ => Ok(None),
    }
}

fn string_array<'js>(
    value: Option<&js::Value<'js>>,
    argument: &str,
) -> Result<Vec<String>, NodeError> {
    let Some(value) = value.filter(|value| !value.is_undefined() && !value.is_null()) else {
        return Ok(Vec::new());
    };
    let Some(array) = value.as_array() else {
        return Err(NodeError::invalid_arg_type(
            argument,
            "an instance of Array",
            args::type_name(value),
        ));
    };
    let mut items = Vec::with_capacity(array.len());
    for index in 0..array.len() {
        let item: js::Value = array
            .get(index)
            .map_err(|_| NodeError::new("ERR_INVALID_ARG_VALUE", "invalid argv entry"))?;
        items.push(args::string(Some(&item), argument)?);
    }
    Ok(items)
}

/// One child environment: `None` value deletes the variable.
type Environment = Option<Vec<(String, Option<String>)>>;

/// `env` is a flat `[key, value, ...]` array; `null` means "inherit this isolate's snapshot".
fn environment<'js>(value: Option<&js::Value<'js>>) -> Result<Environment, NodeError> {
    let Some(value) = value.filter(|value| !value.is_undefined() && !value.is_null()) else {
        return Ok(None);
    };
    let Some(array) = value.as_array() else {
        return Err(NodeError::invalid_arg_type(
            "env",
            "an instance of Object",
            args::type_name(value),
        ));
    };
    let mut entries = Vec::with_capacity(array.len() / 2);
    let mut index = 0;
    while index + 1 < array.len() {
        let key: js::Value = array
            .get(index)
            .map_err(|_| NodeError::new("ERR_INVALID_ARG_VALUE", "invalid env entry"))?;
        let item: js::Value = array
            .get(index + 1)
            .map_err(|_| NodeError::new("ERR_INVALID_ARG_VALUE", "invalid env entry"))?;
        let key = args::string(Some(&key), "env")?;
        let value = if item.is_undefined() {
            None
        } else {
            Some(args::string(Some(&item), "env")?)
        };
        entries.push((key, value));
        index += 2;
    }
    Ok(Some(entries))
}

fn stdio_modes<'js>(value: Option<&js::Value<'js>>) -> Result<[StdioMode; 3], NodeError> {
    let mut modes = [StdioMode::Pipe, StdioMode::Pipe, StdioMode::Pipe];
    let Some(value) = value.filter(|value| !value.is_undefined() && !value.is_null()) else {
        return Ok(modes);
    };
    let Some(array) = value.as_array() else {
        return Err(NodeError::invalid_arg_type(
            "stdio",
            "an instance of Array",
            args::type_name(value),
        ));
    };
    for (index, mode) in modes.iter_mut().enumerate() {
        if index >= array.len() {
            break;
        }
        let item: js::Value = array
            .get(index)
            .map_err(|_| NodeError::new("ERR_INVALID_ARG_VALUE", "invalid stdio entry"))?;
        *mode = if item.is_null() || item.is_undefined() {
            StdioMode::Pipe
        } else if let Some(name) = item.as_string() {
            match name.to_string().unwrap_or_default().as_str() {
                "pipe" | "overlapped" => StdioMode::Pipe,
                "ignore" => StdioMode::Ignore,
                "inherit" => StdioMode::Inherit,
                other => {
                    return Err(NodeError::invalid_arg_value(
                        "stdio",
                        other,
                        "is not a valid stdio mode",
                    ))
                }
            }
        } else if let Some(fd) = item.as_int() {
            StdioMode::Fd(fd)
        } else {
            return Err(NodeError::invalid_arg_type(
                "stdio",
                "string or number",
                args::type_name(&item),
            ));
        };
    }
    Ok(modes)
}
