//! `host.signal`, `host.signalNumber`, `host.signalName`, `host.kill` and `host.cpuUsage`
//! (M5, ADR-0008 §2.7).
//!
//! Signal numbers and names are platform data from `ln-io::signal`; this module only validates
//! and converts. `kill` is a synchronous `libc` call: Node's `process.kill` is synchronous too.

use ln_engine::js;
use ln_error::NodeError;
use ln_io::signal::{signal_name, signal_number};

use crate::host_error::throw_node_error_value;

use super::HostState;

pub(super) fn install<'js>(
    ctx: &js::Ctx<'js>,
    host: &js::Object<'js>,
    state: &HostState,
) -> js::Result<()> {
    let bridge = state.signals.clone();
    // Signal handlers are process-wide; a worker cannot install one (Node:
    // ERR_WORKER_UNSUPPORTED_OPERATION).
    let is_worker = state.worker.is_some();
    host.set(
        "signal",
        js::Function::new(
            ctx.clone(),
            move |ctx: js::Ctx<'js>, number: i32, on: bool| -> js::Result<()> {
                if is_worker {
                    return Err(throw_node_error_value(
                        &ctx,
                        &NodeError::new(
                            "ERR_WORKER_UNSUPPORTED_OPERATION",
                            "Signal listeners cannot be installed in a worker thread",
                        ),
                    ));
                }
                bridge
                    .subscribe(number, on)
                    .map_err(|error| throw_node_error_value(&ctx, &error))
            },
        )?,
    )?;

    host.set(
        "signalNumber",
        js::Function::new(ctx.clone(), |number: String| -> js::Result<Option<i32>> {
            Ok(signal_number(&number))
        })?,
    )?;

    host.set(
        "signalName",
        js::Function::new(ctx.clone(), |number: i32| -> js::Result<Option<String>> {
            Ok(signal_name(number).map(ToOwned::to_owned))
        })?,
    )?;

    {
        let permit = state.permit.clone();
        host.set(
            "kill",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, pid: i32, signal: js::Value<'js>| -> js::Result<bool> {
                    let number = if signal.is_undefined() {
                        libc::SIGTERM
                    } else if let Some(text) = signal.as_string() {
                        let text = text.to_string().unwrap_or_default();
                        signal_number(&text)
                            .filter(|number| *number > 0)
                            .ok_or_else(|| {
                                throw_node_error_value(
                                    &ctx,
                                    &NodeError::invalid_arg_value(
                                        "signal",
                                        &text,
                                        "is not a valid signal",
                                    ),
                                )
                            })?
                    } else if let Some(number) = signal.as_int() {
                        number
                    } else {
                        return Err(throw_node_error_value(
                            &ctx,
                            &NodeError::invalid_arg_type(
                                "signal",
                                "string or number",
                                crate::args::type_name(&signal),
                            ),
                        ));
                    };

                    // `process.kill` never passes through `host.proc`, so it has its own check. It has
                    // no executable to match: any `child.spawn` grant covers signal authority
                    // (ADR-0011 §5.3).
                    permit
                        .check(&ln_perm::Request::AnyGrant {
                            capability: ln_perm::Capability::ChildSpawn,
                        })
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    // SAFETY: `kill` takes plain integers and has no memory preconditions.
                    let result = unsafe { libc::kill(pid, number) };
                    if result == 0 {
                        return Ok(true);
                    }
                    // Node throws ESRCH/EPERM from `process.kill`; it never returns a boolean failure
                    // (the boolean is `child.kill`, which is a separate JS wrapper).
                    let error = std::io::Error::last_os_error();
                    Err(throw_node_error_value(
                        &ctx,
                        &NodeError::system(&error, "kill", std::path::Path::new("")),
                    ))
                },
            )?,
        )?;
    }

    host.set(
        "cpuUsage",
        js::Function::new(
            ctx.clone(),
            |ctx: js::Ctx<'js>| -> js::Result<js::Object<'js>> {
                let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
                // SAFETY: `getrusage` fills the provided struct and returns an int; the struct is
                // valid for writes because it is a plain C struct owned by this frame.
                let result = unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
                if result != 0 {
                    return Err(throw_node_error_value(
                        &ctx,
                        &NodeError::system(
                            &std::io::Error::last_os_error(),
                            "getrusage",
                            std::path::Path::new(""),
                        ),
                    ));
                }
                let microseconds = |time: libc::timeval| -> f64 {
                    (time.tv_sec as f64) * 1_000_000.0 + (time.tv_usec as f64)
                };
                let object = js::Object::new(ctx.clone())?;
                object.set("user", microseconds(usage.ru_utime))?;
                object.set("system", microseconds(usage.ru_stime))?;
                Ok(object)
            },
        )?,
    )?;

    Ok(())
}
