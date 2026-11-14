//! The `fs` op entry points.
//!
//! One primitive pair for every `fs` capability (`docs/m3-plan.md` §2.2). Argument normalization
//! lives in `js/lib/internal/fs.js`; `build_op` validates the array again so a direct
//! `__ln_host.fsSync` call cannot construct an invalid op.

use std::sync::atomic::AtomicBool;

use ln_engine::js;

use crate::args;
use crate::host_error::throw_node_error_value;
use crate::ops::{build_op, op_value_to_js};

use super::{collect_args, HostState};

pub(super) fn install<'js>(
    ctx: &js::Ctx<'js>,
    host: &js::Object<'js>,
    state: &HostState,
) -> js::Result<()> {
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

    Ok(())
}

/// Throw for an `fs` op name that is not a string.
fn parse_op_name<'js>(ctx: &js::Ctx<'js>, value: &js::Value<'js>) -> js::Result<String> {
    args::string(Some(value), "name").map_err(|error| throw_node_error_value(ctx, &error))
}
