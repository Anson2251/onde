//! `host.net(id, name, args)`: the one command entry point for network handles (ADR-0006 §2.2).
//!
//! The shape mirrors `host.fsAsync`: one id, one command name, one positional argument array.
//! Everything is validated **synchronously** here, so `server.listen({ port: "x" })` fails at the
//! call site like Node; a bind/connect failure that happens later is an `error` event.
//!
//! This module deliberately does not look at the task: `ref`/`unref` are loop-ref changes owned by
//! [`HandleBridge`](crate::handles::HandleBridge), and TLS is not implemented until WP6, so a request that carries TLS options
//! throws `ERR_FEATURE_UNAVAILABLE` instead of silently connecting in plaintext.

use std::path::PathBuf;

use ln_engine::js;
use ln_error::NodeError;
use ln_http::{Limits, Role};
use ln_io::net::{
    Command, ConnectOptions, ConnectTarget, IpFamily, ListenOptions, ListenTarget, MAX_CHUNK,
};

use crate::args;
use crate::host_error::throw_node_error_value;

use super::{collect_args, HostState};

pub(super) fn install<'js>(
    ctx: &js::Ctx<'js>,
    host: &js::Object<'js>,
    state: &HostState,
) -> js::Result<()> {
    // The internal handle registry. Rust owns the object (so it exists before `bootstrap.js`
    // freezes `__ln_host`); the functions live in JS because H1 forbids storing a JS function on
    // the Rust side.
    host.set("handles", js::Object::new(ctx.clone())?)?;

    let handles = state.handles.clone();
    host.set(
        "net",
        js::Function::new(
            ctx.clone(),
            move |ctx: js::Ctx<'js>,
                  handle_id: js::Value<'js>,
                  name: js::Value<'js>,
                  args_value: js::Value<'js>|
                  -> js::Result<()> {
                let id = args::u64_value(Some(&handle_id), "id")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                let name = args::string(Some(&name), "name")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                let arguments = collect_args(&ctx, &args_value)?;
                let command = build_net_command(&name, &arguments)
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                handles
                    .command(id, command)
                    .map_err(|error| throw_node_error_value(&ctx, &error))
            },
        )?,
    )?;
    Ok(())
}

/// Build one [`Command`] from `(name, args)`.
///
/// `null`/`undefined` mean "argument omitted" for optional positions. The layouts are the M4
/// contract (`docs/m4-plan.md` §2.2):
///
/// * `listen`: `[host, port, path, backlog, ipv6Only, exclusive, tls]`, where a non-null `path`
///   selects a Unix socket and ignores `host`/`port`;
/// * `connect`: `[host, port, path, family, localAddress, localPort, noDelay, keepAliveMs, tls]`.
pub(crate) fn build_net_command<'js>(
    name: &str,
    args: &[js::Value<'js>],
) -> Result<Command, NodeError> {
    match name {
        "listen" => {
            let path = optional_string(args, 2, "path")?;
            let backlog = optional_i32(args, 3, "backlog", 511)?;
            let ipv6_only = optional_bool(args, 4, "ipv6Only", false)?;
            let exclusive = optional_bool(args, 5, "exclusive", false)?;
            ensure_no_tls(args, 6, "listen")?;
            let options = ListenOptions {
                backlog,
                ipv6_only,
                exclusive,
                tls: None,
            };
            Ok(Command::Listen(match path {
                Some(path) => ListenTarget::Unix {
                    path: PathBuf::from(path),
                    options,
                },
                None => ListenTarget::Tcp {
                    host: required_string(args, 0, "host")?,
                    port: port_arg(args, 1, "port")?,
                    options,
                },
            }))
        }
        "connect" => {
            let path = optional_string(args, 2, "path")?;
            let family = family_arg(args, 3)?;
            let options = ConnectOptions {
                family,
                local_address: optional_string(args, 4, "localAddress")?,
                local_port: optional_port(args, 5, "localPort")?,
                no_delay: optional_bool(args, 6, "noDelay", true)?,
                keep_alive_ms: optional_opt_u32(args, 7, "keepAliveMs")?,
                tls: None,
            };
            ensure_no_tls(args, 8, "connect")?;
            Ok(Command::Connect(match path {
                Some(path) => ConnectTarget::Unix {
                    path: PathBuf::from(path),
                    options,
                },
                None => ConnectTarget::Tcp {
                    host: required_string(args, 0, "host")?,
                    port: port_arg(args, 1, "port")?,
                    options,
                },
            }))
        }
        "read" => {
            // `MAX_CHUNK` is the design bound (ADR-0006 H7); a caller may only ask for less.
            let max = optional_u32(args, 0, "maxChunk", MAX_CHUNK)?.clamp(1, MAX_CHUNK);
            Ok(Command::Read { max })
        }
        "readStop" => Ok(Command::ReadStop),
        "write" => Ok(Command::Write {
            data: args::bytes(present(args, 0), "data")?,
        }),
        "end" => Ok(Command::End),
        "destroy" => Ok(Command::Destroy),
        "detach" => Ok(Command::Detach),
        "httpAttach" => {
            let role = match required_string(args, 0, "role")?.as_str() {
                "server" => Role::Server,
                "client" => Role::Client,
                other => {
                    return Err(NodeError::invalid_arg_value(
                        "role",
                        other,
                        "must be 'server' or 'client'",
                    ))
                }
            };
            let defaults = Limits::default();
            let max_head_bytes = optional_usize(args, 1, "maxHeadBytes", defaults.max_head_bytes)?;
            let max_headers = optional_usize(args, 2, "maxHeaders", defaults.max_headers)?;
            Ok(Command::HttpAttach {
                role,
                limits: Limits {
                    max_head_bytes,
                    max_headers,
                },
            })
        }
        "httpHead" => Ok(Command::HttpHead {
            bytes: args::bytes(present(args, 0), "head")?,
        }),
        "httpBody" => Ok(Command::HttpBody {
            bytes: args::bytes(present(args, 0), "body")?,
        }),
        "httpEnd" => Ok(Command::HttpEnd {
            keep_alive: optional_bool(args, 0, "keepAlive", true)?,
        }),
        "httpContinue" => Ok(Command::HttpContinue),
        "setNoDelay" => Ok(Command::SetNoDelay(args::bool_value(
            present(args, 0),
            "noDelay",
        )?)),
        "setKeepAlive" => Ok(Command::SetKeepAlive {
            enable: args::bool_value(present(args, 0), "enable")?,
            initial_delay_ms: optional_u32(args, 1, "initialDelayMs", 0)?,
        }),
        "ref" => Ok(Command::Ref),
        "unref" => Ok(Command::Unref),
        other => Err(NodeError::invalid_arg_value(
            "name",
            other,
            "is not a network command",
        )),
    }
}

// --- argument helpers ------------------------------------------------------------------------

fn present<'a, 'js>(args: &'a [js::Value<'js>], index: usize) -> Option<&'a js::Value<'js>> {
    args.get(index)
        .filter(|value| !value.is_undefined() && !value.is_null())
}

fn required_string<'js>(
    args: &[js::Value<'js>],
    index: usize,
    argument: &str,
) -> Result<String, NodeError> {
    args::string(present(args, index), argument)
}

fn optional_string<'js>(
    args: &[js::Value<'js>],
    index: usize,
    argument: &str,
) -> Result<Option<String>, NodeError> {
    match present(args, index) {
        Some(value) => Ok(Some(args::string(Some(value), argument)?)),
        None => Ok(None),
    }
}

fn optional_bool<'js>(
    args: &[js::Value<'js>],
    index: usize,
    argument: &str,
    default: bool,
) -> Result<bool, NodeError> {
    match present(args, index) {
        Some(_) => args::bool_value(present(args, index), argument),
        None => Ok(default),
    }
}

fn optional_u32<'js>(
    args: &[js::Value<'js>],
    index: usize,
    argument: &str,
    default: u32,
) -> Result<u32, NodeError> {
    match present(args, index) {
        Some(_) => args::u32_value(present(args, index), argument),
        None => Ok(default),
    }
}

/// `null`/omitted means `None` rather than a default (`connect`'s `keepAliveMs`).
fn optional_opt_u32<'js>(
    args: &[js::Value<'js>],
    index: usize,
    argument: &str,
) -> Result<Option<u32>, NodeError> {
    match present(args, index) {
        Some(_) => Ok(Some(args::u32_value(present(args, index), argument)?)),
        None => Ok(None),
    }
}

fn optional_i32<'js>(
    args: &[js::Value<'js>],
    index: usize,
    argument: &str,
    default: i32,
) -> Result<i32, NodeError> {
    match present(args, index) {
        Some(_) => args::i32_value(present(args, index), argument),
        None => Ok(default),
    }
}

fn optional_usize<'js>(
    args: &[js::Value<'js>],
    index: usize,
    argument: &str,
    default: usize,
) -> Result<usize, NodeError> {
    match present(args, index) {
        Some(_) => Ok(args::u64_value(present(args, index), argument)? as usize),
        None => Ok(default),
    }
}

/// A TCP port position: a number in `0..=65535`. A wrong type is `ERR_INVALID_ARG_TYPE`, an
/// out-of-range number is `ERR_OUT_OF_RANGE` (Node's split for `server.listen`).
fn port_arg<'js>(args: &[js::Value<'js>], index: usize, argument: &str) -> Result<u16, NodeError> {
    let value = args::number(present(args, index), argument)?;
    if !value.is_finite() || value.fract() != 0.0 || !(0.0..=65535.0).contains(&value) {
        return Err(NodeError::out_of_range(
            argument,
            ">= 0 && <= 65535",
            &value.to_string(),
        ));
    }
    Ok(value as u16)
}

fn optional_port<'js>(
    args: &[js::Value<'js>],
    index: usize,
    argument: &str,
) -> Result<Option<u16>, NodeError> {
    if present(args, index).is_none() {
        return Ok(None);
    }
    port_arg(args, index, argument).map(Some)
}

/// `net.connect({ family })`: `0` (either), `4` or `6`. Node also accepts the `"IPv4"`/`"IPv6"`
/// strings, which the JS surface normalizes before calling the host.
fn family_arg<'js>(args: &[js::Value<'js>], index: usize) -> Result<IpFamily, NodeError> {
    let Some(_) = present(args, index) else {
        return Ok(IpFamily::Either);
    };
    let family = args::number(present(args, index), "family")?;
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

/// WP6 adds TLS. Until then a TLS request must fail loudly: a silent plaintext connection would be
/// a security bug, not a compatibility gap.
fn ensure_no_tls<'js>(
    args: &[js::Value<'js>],
    index: usize,
    command: &str,
) -> Result<(), NodeError> {
    if present(args, index).is_some() {
        return Err(NodeError::new(
            "ERR_FEATURE_UNAVAILABLE",
            format!(
                "TLS is not implemented yet: net {command} with TLS options would silently \
                 connect in plaintext, so it is refused"
            ),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ln_engine::Engine;

    fn with_ctx<R>(f: impl FnOnce(js::Ctx<'_>) -> R) -> R {
        let engine = Engine::new().expect("engine");
        engine.with_ctx(f)
    }

    fn build<'js>(ctx: &js::Ctx<'js>, name: &str, source: &str) -> Result<Command, NodeError> {
        let value: js::Value = ctx.eval(source).expect("eval argument array");
        let args = collect_args(ctx, &value).expect("argument array");
        build_net_command(name, &args)
    }

    #[test]
    fn tcp_listen_uses_node_defaults() {
        with_ctx(|ctx| {
            let command = build(
                &ctx,
                "listen",
                r#"["127.0.0.1", 8080, null, null, null, null, null]"#,
            )
            .expect("listen command");
            match command {
                Command::Listen(ListenTarget::Tcp {
                    host,
                    port,
                    options,
                }) => {
                    assert_eq!(host, "127.0.0.1");
                    assert_eq!(port, 8080);
                    assert_eq!(options.backlog, 511);
                    assert!(!options.ipv6_only);
                    assert!(!options.exclusive);
                    assert!(options.tls.is_none());
                }
                other => panic!("unexpected command: {other:?}"),
            }
        });
    }

    #[test]
    fn a_non_null_path_selects_a_unix_socket_and_ignores_host_and_port() {
        with_ctx(|ctx| {
            let command = build(
                &ctx,
                "listen",
                r#"[null, null, "/tmp/onde-m4.sock", 128, true, true, null]"#,
            )
            .expect("listen command");
            match command {
                Command::Listen(ListenTarget::Unix { path, options }) => {
                    assert_eq!(path, std::path::Path::new("/tmp/onde-m4.sock"));
                    assert_eq!(options.backlog, 128);
                    assert!(options.ipv6_only);
                    assert!(options.exclusive);
                }
                other => panic!("unexpected command: {other:?}"),
            }
        });
    }

    #[test]
    fn tcp_connect_carries_every_option() {
        with_ctx(|ctx| {
            let command = build(
                &ctx,
                "connect",
                r#"["example.com", 443, null, 4, "127.0.0.1", 4444, false, 5000, null]"#,
            )
            .expect("connect command");
            match command {
                Command::Connect(ConnectTarget::Tcp {
                    host,
                    port,
                    options,
                }) => {
                    assert_eq!(host, "example.com");
                    assert_eq!(port, 443);
                    assert_eq!(options.family, IpFamily::V4);
                    assert_eq!(options.local_address.as_deref(), Some("127.0.0.1"));
                    assert_eq!(options.local_port, Some(4444));
                    assert!(!options.no_delay);
                    assert_eq!(options.keep_alive_ms, Some(5000));
                    assert!(options.tls.is_none());
                }
                other => panic!("unexpected command: {other:?}"),
            }
        });
    }

    #[test]
    fn connect_defaults_are_the_protocol_defaults() {
        with_ctx(|ctx| {
            let command = build(
                &ctx,
                "connect",
                r#"["127.0.0.1", 80, null, null, null, null, null, null, null]"#,
            )
            .expect("connect command");
            match command {
                Command::Connect(ConnectTarget::Tcp { options, .. }) => {
                    assert_eq!(options.family, IpFamily::Either);
                    assert_eq!(options.local_address, None);
                    assert_eq!(options.local_port, None);
                    assert!(options.no_delay);
                    assert_eq!(options.keep_alive_ms, None);
                }
                other => panic!("unexpected command: {other:?}"),
            }
        });
    }

    #[test]
    fn unix_connect_ignores_host_and_port() {
        with_ctx(|ctx| {
            let command = build(
                &ctx,
                "connect",
                r#"[null, null, "/tmp/onde-m4.sock", null, null, null, null, null, null]"#,
            )
            .expect("connect command");
            assert!(matches!(
                command,
                Command::Connect(ConnectTarget::Unix { path, .. })
                    if path == std::path::Path::new("/tmp/onde-m4.sock")
            ));
        });
    }

    /// Argument errors are synchronous: the caller must never reach the event loop with them.
    #[test]
    fn a_bad_port_or_missing_host_is_err_invalid_arg_type() {
        with_ctx(|ctx| {
            let port = build(
                &ctx,
                "listen",
                r#"["127.0.0.1", "8080", null, null, null, null, null]"#,
            )
            .expect_err("string port");
            assert_eq!(port.code, "ERR_INVALID_ARG_TYPE");
            assert_eq!(port.name, "TypeError");

            let host = build(
                &ctx,
                "listen",
                r#"[null, 80, null, null, null, null, null]"#,
            )
            .expect_err("missing host");
            assert_eq!(host.code, "ERR_INVALID_ARG_TYPE");

            let range = build(
                &ctx,
                "connect",
                r#"["127.0.0.1", 70000, null, null, null, null, null, null, null]"#,
            )
            .expect_err("out-of-range port");
            assert_eq!(range.code, "ERR_OUT_OF_RANGE");
        });
    }

    /// WP6 owns TLS. Until then a TLS request fails loudly instead of silently connecting in
    /// plaintext.
    #[test]
    fn tls_options_are_refused_with_err_feature_unavailable() {
        with_ctx(|ctx| {
            let listen = build(
                &ctx,
                "listen",
                r#"["127.0.0.1", 0, null, null, null, null, {}]"#,
            )
            .expect_err("listen with tls");
            assert_eq!(listen.code, "ERR_FEATURE_UNAVAILABLE");

            let connect = build(
                &ctx,
                "connect",
                r#"["127.0.0.1", 443, null, null, null, null, null, null, {}]"#,
            )
            .expect_err("connect with tls");
            assert_eq!(connect.code, "ERR_FEATURE_UNAVAILABLE");
        });
    }

    #[test]
    fn read_is_capped_at_the_protocol_bound() {
        with_ctx(|ctx| {
            assert!(matches!(
                build(&ctx, "read", "[]").expect("read"),
                Command::Read { max: MAX_CHUNK }
            ));
            assert!(matches!(
                build(&ctx, "read", "[1024]").expect("read"),
                Command::Read { max: 1024 }
            ));
            // A caller may ask for less, never for more (ADR-0006 H7).
            assert!(matches!(
                build(&ctx, "read", "[999999]").expect("read"),
                Command::Read { max: MAX_CHUNK }
            ));
        });
    }

    #[test]
    fn http_attach_defaults_match_the_codec_limits() {
        with_ctx(|ctx| {
            match build(&ctx, "httpAttach", r#"["server", null, null]"#).expect("httpAttach") {
                Command::HttpAttach { role, limits } => {
                    assert_eq!(role, Role::Server);
                    assert_eq!(limits, Limits::default());
                }
                other => panic!("unexpected command: {other:?}"),
            }
            assert!(matches!(
                build(&ctx, "httpEnd", "[]").expect("httpEnd"),
                Command::HttpEnd { keep_alive: true }
            ));
        });
    }

    #[test]
    fn unknown_commands_are_rejected_like_bad_op_names() {
        with_ctx(|ctx| {
            let error = build(&ctx, "listenNow", "[]").expect_err("unknown command");
            assert_eq!(error.code, "ERR_INVALID_ARG_VALUE");
        });
    }
}
