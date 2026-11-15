//! `dns.lookup` is an op, not a handle (ADR-0005, `docs/m4-plan.md` §2.6).
//!
//! `host.dnsAsync(opId, host, family, all)` mirrors `host.fsAsync`: the JS layer has already
//! minted an op id from the isolate's single sequence and registered a settler; this function
//! validates the remaining arguments and submits `Op::Lookup` to the shared pool, which runs
//! `getaddrinfo` on a blocking thread. The result travels back through the existing op completion
//! channel.

use ln_engine::js;
use ln_error::NodeError;
use ln_io::net::IpFamily;
use ln_io::Op;

use crate::args;
use crate::host_error::throw_node_error_value;

use super::HostState;

pub(super) fn install<'js>(
    ctx: &js::Ctx<'js>,
    host: &js::Object<'js>,
    state: &HostState,
) -> js::Result<()> {
    // The `hints` constants are `getaddrinfo` flags, so their values come from the platform's
    // headers: glibc uses 0x20/0x08/0x10 for ADDRCONFIG/V4MAPPED/ALL, the BSDs and Windows use
    // 0x400/0x800/0x100. Publishing them from `libc` keeps `dns.ADDRCONFIG` equal to what Node
    // reports on the same machine instead of pinning one platform's numbers in JavaScript.
    let hints = js::Object::new(ctx.clone())?;
    hints.set("addrconfig", i64::from(libc::AI_ADDRCONFIG))?;
    hints.set("v4mapped", i64::from(libc::AI_V4MAPPED))?;
    hints.set("all", i64::from(libc::AI_ALL))?;
    host.set("dnsHints", hints)?;

    let ops = state.ops.clone();
    host.set(
        "dnsAsync",
        js::Function::new(
            ctx.clone(),
            move |ctx: js::Ctx<'js>,
                  op_id: js::Value<'js>,
                  hostname: js::Value<'js>,
                  family: js::Value<'js>,
                  all: js::Value<'js>|
                  -> js::Result<()> {
                let id = args::u64_value(Some(&op_id), "opId")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                let hostname = args::string(Some(&hostname), "hostname")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                let family =
                    lookup_family(&family).map_err(|error| throw_node_error_value(&ctx, &error))?;
                let all = match (all.is_undefined(), all.is_null()) {
                    (true, _) | (_, true) => false,
                    _ => args::bool_value(Some(&all), "all")
                        .map_err(|error| throw_node_error_value(&ctx, &error))?,
                };
                ops.submit(
                    id,
                    Op::Lookup {
                        host: hostname,
                        family,
                        all,
                    },
                );
                Ok(())
            },
        )?,
    )?;
    Ok(())
}

/// The JS surface normalizes `family` to `0`/`4`/`6`; a direct host call is validated here too.
fn lookup_family(value: &js::Value<'_>) -> Result<IpFamily, NodeError> {
    if value.is_undefined() || value.is_null() {
        return Ok(IpFamily::Either);
    }
    let family = args::number(Some(value), "family")?;
    match family {
        0.0 => Ok(IpFamily::Either),
        4.0 => Ok(IpFamily::V4),
        6.0 => Ok(IpFamily::V6),
        other => Err(NodeError::invalid_arg_value(
            "family",
            &other.to_string(),
            "must be 0, 4 or 6",
        )),
    }
}
