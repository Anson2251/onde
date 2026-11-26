//! `host.worker(id, name, args)`: worker spawn, messaging and termination (ADR-0008 §2.2).
//!
//! The host never stores a `JSValue` on the Rust side. A message is serialized on the calling
//! isolate, then parked as owned bytes plus shared-memory pointers; the receiving isolate
//! deserializes it on its own thread (H1′). `workerData` is the same shape, consumed when the
//! worker installs its host object.
//!
//! The registry object `host.workers` exists here for the same reason `host.handles` does: the
//! functions live in `bootstrap.js` because they hold JS callbacks, and Rust only owns the shell.

use std::path::PathBuf;

use ln_engine::{detach_buffer, js, serialize, Serialized};
use ln_error::NodeError;
use ln_perm::{Capability, Request};

use super::{collect_args, HostState};
use crate::args;
use crate::host_error::throw_node_error_value;
use crate::workers::WorkerEvent;
use crate::WorkerEntry;

pub(super) fn install<'js>(
    ctx: &js::Ctx<'js>,
    host: &js::Object<'js>,
    state: &HostState,
) -> js::Result<()> {
    install_role_info(ctx, host, state)?;

    // The internal worker registry; `bootstrap.js` adds `register`/`release`.
    host.set("workers", js::Object::new(ctx.clone())?)?;

    let bridge = state.workers.clone();
    let role = state.worker.clone();
    let permit = state.permit.clone();
    host.set(
        "worker",
        js::Function::new(
            ctx.clone(),
            move |ctx: js::Ctx<'js>,
                  worker_id: js::Value<'js>,
                  name: js::Value<'js>,
                  args_value: js::Value<'js>|
                  -> js::Result<js::Value<'js>> {
                let id = args::u64_value(Some(&worker_id), "id")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                let name = args::string(Some(&name), "name")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                let arguments = collect_args(&ctx, &args_value)?;

                match name.as_str() {
                    "spawn" => {
                        permit
                            .check(&Request::Toggle {
                                capability: Capability::WorkerSpawn,
                            })
                            .map_err(|error| throw_node_error_value(&ctx, &error))?;
                        let (entry, worker_data, argv, transfers, memory_limit) =
                            spawn_arguments(&ctx, &arguments)
                                .map_err(|error| throw_node_error_value(&ctx, &error))?;
                        let thread_id = bridge
                            .spawn(id, entry, worker_data, argv, memory_limit)
                            .map_err(|error| throw_node_error_value(&ctx, &error))?;
                        detach_all(&ctx, transfers)?;
                        Ok(js::Value::new_number(ctx.clone(), f64::from(thread_id)))
                    }
                    "postMessage" => {
                        let value = arguments.first().ok_or_else(|| {
                            throw_node_error_value(
                                &ctx,
                                &NodeError::invalid_arg_type("value", "a value", "undefined"),
                            )
                        })?;
                        let message = serialize(&ctx, value)
                            .map_err(|error| data_clone_error(&ctx, &error.message))?;
                        let transfers = arguments.get(1);
                        detach_transfers(&ctx, transfers)?;
                        // `parentPort.postMessage` targets the parent, which is this isolate's own
                        // handle id; a nested worker targets the bridge table.
                        if let Some(role) = &role {
                            if id == role.handle {
                                role.sink.emit(WorkerEvent::Message(message));
                                return Ok(js::Value::new_undefined(ctx.clone()));
                            }
                        }
                        bridge.post_message(id, message);
                        Ok(js::Value::new_undefined(ctx.clone()))
                    }
                    "terminate" => {
                        if let Some(role) = &role {
                            if id == role.handle {
                                // A worker cannot terminate itself; Node has no API for it.
                                return Ok(js::Value::new_undefined(ctx.clone()));
                            }
                        }
                        bridge.terminate(id);
                        Ok(js::Value::new_undefined(ctx.clone()))
                    }
                    "ref" => {
                        if let Some(role) = &role {
                            if id == role.handle {
                                bridge.self_ref(role);
                                return Ok(js::Value::new_undefined(ctx.clone()));
                            }
                        }
                        bridge.ref_worker(id);
                        Ok(js::Value::new_undefined(ctx.clone()))
                    }
                    "unref" => {
                        if let Some(role) = &role {
                            if id == role.handle {
                                bridge.self_unref(role);
                                return Ok(js::Value::new_undefined(ctx.clone()));
                            }
                        }
                        bridge.unref_worker(id);
                        Ok(js::Value::new_undefined(ctx.clone()))
                    }
                    other => Err(throw_node_error_value(
                        &ctx,
                        &NodeError::invalid_arg_value("name", other, "is not a worker command"),
                    )),
                }
            },
        )?,
    )?;
    Ok(())
}

/// `__ln_host.workerInfo`: `null` on the main isolate, role data on a worker.
fn install_role_info<'js>(
    ctx: &js::Ctx<'js>,
    host: &js::Object<'js>,
    state: &HostState,
) -> js::Result<()> {
    let Some(role) = &state.worker else {
        host.set("workerInfo", js::Value::new_null(ctx.clone()))?;
        return Ok(());
    };

    let info = js::Object::new(ctx.clone())?;
    info.set("id", role.handle)?;
    info.set("threadId", role.thread_id)?;

    // `workerData` is consumed exactly once, on this thread. A failure here means the two ends
    // disagree about the engine format; there is nothing useful to hand JS.
    let data: Option<Serialized> = role.worker_data.borrow_mut().take();
    let value = match data {
        Some(message) => match ln_engine::deserialize(ctx, message) {
            Ok(value) => value,
            Err(_) => js::Value::new_null(ctx.clone()),
        },
        None => js::Value::new_null(ctx.clone()),
    };
    info.set("workerData", value)?;
    host.set("workerInfo", info)?;
    Ok(())
}

/// One parsed `spawn`: entry, serialized workerData, argv override, transfer list, memory limit.
type SpawnArguments<'js> = (
    WorkerEntry,
    Option<Serialized>,
    Option<Vec<String>>,
    js::Value<'js>,
    Option<u64>,
);

/// Parse `spawn(filename, evalSource, workerData, argv, transferList)`.
///
/// `evalSource` non-null means the worker is `eval: true`; `filename` is then only a label.
fn spawn_arguments<'js>(
    ctx: &js::Ctx<'js>,
    args: &[js::Value<'js>],
) -> Result<SpawnArguments<'js>, NodeError> {
    let filename = args::string(args.first(), "filename")?;
    let eval_source = optional_string(args.get(1), "evalSource")?;
    let entry = match eval_source {
        Some(source) => WorkerEntry::Eval(source),
        None => WorkerEntry::File(PathBuf::from(filename)),
    };

    let worker_data = match args.get(2) {
        Some(value) if !value.is_undefined() => Some(
            serialize(ctx, value)
                .map_err(|error| NodeError::new("ERR_WORKER_INIT_FAILED", error.message))?,
        ),
        _ => None,
    };

    let argv = match args.get(3) {
        Some(value) if !value.is_undefined() && !value.is_null() => {
            let Some(array) = value.as_array() else {
                return Err(NodeError::invalid_arg_type(
                    "options.argv",
                    "an instance of Array",
                    crate::args::type_name(value),
                ));
            };
            let mut argv = Vec::with_capacity(array.len());
            for index in 0..array.len() {
                let item: js::Value = array
                    .get(index)
                    .map_err(|_| NodeError::new("ERR_INVALID_ARG_VALUE", "invalid argv entry"))?;
                argv.push(args::string(Some(&item), "argv")?);
            }
            Some(argv)
        }
        _ => None,
    };

    let transfers = args
        .get(4)
        .filter(|value| !value.is_undefined() && !value.is_null())
        .cloned()
        .unwrap_or_else(|| js::Value::new_undefined(ctx.clone()));

    // `resourceLimits.maxOldGenerationSizeMb`: a positive integer number of mebibytes. A worker's
    // heap is its own runtime's, so this is passed per spawn and applied before its bootstrap
    // (m7-plan §3.3). Values Node accepts and we cannot honour (`stackSizeMb`) never reach here.
    let memory_limit = match args.get(5) {
        Some(value) if !value.is_undefined() && !value.is_null() => {
            let mb = value.as_number().ok_or_else(|| {
                NodeError::invalid_arg_type(
                    "options.resourceLimits",
                    "a number",
                    crate::args::type_name(value),
                )
            })?;
            if !(mb.is_finite() && mb > 0.0) {
                return Err(NodeError::invalid_arg_value(
                    "options.resourceLimits.maxOldGenerationSizeMb",
                    &format!("{mb}"),
                    "a positive number of megabytes",
                ));
            }
            Some((mb * 1024.0 * 1024.0) as u64)
        }
        _ => None,
    };
    Ok((entry, worker_data, argv, transfers, memory_limit))
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

/// Detach every `ArrayBuffer` in a `transferList` after the message has been written.
///
/// A `SharedArrayBuffer` is already shared and is left alone; functions/ports are rejected by the
/// JS layer before they get here (D49).
fn detach_transfers<'js>(ctx: &js::Ctx<'js>, transfers: Option<&js::Value<'js>>) -> js::Result<()> {
    let Some(value) = transfers else {
        return Ok(());
    };
    if value.is_undefined() || value.is_null() {
        return Ok(());
    }
    let array = value.as_array().ok_or_else(|| {
        throw_node_error_value(
            ctx,
            &NodeError::invalid_arg_type(
                "transferList",
                "an instance of Array",
                crate::args::type_name(value),
            ),
        )
    })?;
    for index in 0..array.len() {
        let item: js::Value = array.get(index)?;
        if let Some(object) = item.as_object() {
            if object.as_array_buffer().is_some() {
                detach_buffer(ctx, &item);
            }
        }
    }
    Ok(())
}

fn detach_all<'js>(ctx: &js::Ctx<'js>, transfers: js::Value<'js>) -> js::Result<()> {
    detach_transfers(ctx, Some(&transfers))
}

fn data_clone_error<'js>(ctx: &js::Ctx<'js>, message: &str) -> js::Error {
    match js::Object::new(ctx.clone()) {
        Ok(error) => {
            let _ = error.set("name", "DataCloneError");
            let _ = error.set("message", message);
            ctx.throw(error.into_value())
        }
        Err(_) => ctx.throw(js::Value::new_undefined(ctx.clone())),
    }
}
