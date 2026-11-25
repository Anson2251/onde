//! `host.net(id, name, args)`: the one command entry point for network handles (ADR-0006 §2.2).
//!
//! The shape mirrors `host.fsAsync`: one id, one command name, one positional argument array.
//! Everything is validated **synchronously** here, so `server.listen({ port: "x" })` fails at the
//! call site like Node; a bind/connect failure that happens later is an `error` event.
//!
//! This module deliberately does not look at the task: `ref`/`unref` are loop-ref changes owned by
//! [`HandleBridge`](crate::handles::HandleBridge). TLS options are plain data crossing the
//! boundary (`docs/m4-plan.md` §2.5): PEM bytes, not paths, because the JS surface reads the files
//! with `fs.readFileSync`, so there is one file-reading path and one error shape.

use std::path::PathBuf;

use ln_engine::js;
use ln_error::NodeError;
use ln_http::{Limits, Role};
use ln_io::net::{
    Command, ConnectOptions, ConnectTarget, IpFamily, ListenOptions, ListenTarget, MAX_CHUNK,
};
#[cfg(feature = "node-tls")]
use ln_io::net::{TlsClientOptions, TlsServerOptions};

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
            #[cfg(not(feature = "node-tls"))]
            reject_tls_arg(args, 6, "listen")?;
            let options = ListenOptions {
                backlog,
                ipv6_only,
                exclusive,
                #[cfg(feature = "node-tls")]
                tls: tls_server_arg(args, 6)?,
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
            #[cfg(not(feature = "node-tls"))]
            reject_tls_arg(args, 8, "connect")?;
            let options = ConnectOptions {
                family,
                local_address: optional_string(args, 4, "localAddress")?,
                local_port: optional_port(args, 5, "localPort")?,
                no_delay: optional_bool(args, 6, "noDelay", true)?,
                keep_alive_ms: optional_opt_u32(args, 7, "keepAliveMs")?,
                #[cfg(feature = "node-tls")]
                tls: tls_client_arg(args, 8)?,
            };
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
        "reset" => Ok(Command::Reset),
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
                    ));
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

// --- TLS options -----------------------------------------------------------------------------

/// A `tls` argument in a build without `node-tls`.
///
/// The JS `tls`/`https` modules are compiled out with the feature, so nothing in the stdlib can
/// produce a non-null value here. If something still does, refusing loudly is better than
/// silently downgrading a connection that asked for TLS to plaintext.
#[cfg(not(feature = "node-tls"))]
fn reject_tls_arg<'js>(
    args: &[js::Value<'js>],
    index: usize,
    command: &str,
) -> Result<(), NodeError> {
    match present(args, index) {
        Some(value) if !value.is_null() => Err(NodeError::new(
            "ERR_UNKNOWN_BUILTIN_MODULE",
            format!(
                "net.{command} was given TLS options, but node:tls is not available: the \
                 `node-tls` feature is not enabled in this build."
            ),
        )),
        _ => Ok(()),
    }
}

/// `client`'s TLS argument: `{ servername, rejectUnauthorized, caPem, alpn }`.
///
/// `null`/`undefined` means "plaintext". The shape is validated here so a bad argument throws at
/// the call site; a bad *certificate* is a connection error (it needs PEM parsing, which happens
/// lazily in `ln-io` when the config is first built).
#[cfg(feature = "node-tls")]
fn tls_client_arg<'js>(
    args: &[js::Value<'js>],
    index: usize,
) -> Result<Option<TlsClientOptions>, NodeError> {
    let Some(object) = optional_object(args, index, "tls")? else {
        return Ok(None);
    };
    Ok(Some(TlsClientOptions {
        servername: optional_field_string(&object, "servername")?,
        reject_unauthorized: optional_field_bool(&object, "rejectUnauthorized", true)?,
        ca_pem: optional_field_bytes(&object, "caPem")?,
        alpn: field_string_array(&object, "alpn")?,
    }))
}

/// `listen`'s TLS argument: `{ certPem, keyPem, alpn }`.
#[cfg(feature = "node-tls")]
fn tls_server_arg<'js>(
    args: &[js::Value<'js>],
    index: usize,
) -> Result<Option<TlsServerOptions>, NodeError> {
    let Some(object) = optional_object(args, index, "tls")? else {
        return Ok(None);
    };
    let cert_pem = optional_field_bytes(&object, "certPem")?.ok_or_else(|| {
        NodeError::invalid_arg_value("tls.certPem", "undefined", "is required for a TLS server")
    })?;
    let key_pem = optional_field_bytes(&object, "keyPem")?.ok_or_else(|| {
        NodeError::invalid_arg_value("tls.keyPem", "undefined", "is required for a TLS server")
    })?;
    Ok(Some(TlsServerOptions {
        cert_pem,
        key_pem,
        alpn: field_string_array(&object, "alpn")?,
    }))
}

#[cfg(feature = "node-tls")]
fn optional_object<'js>(
    args: &[js::Value<'js>],
    index: usize,
    argument: &str,
) -> Result<Option<js::Object<'js>>, NodeError> {
    let Some(value) = present(args, index) else {
        return Ok(None);
    };
    match value.as_object() {
        Some(object) => Ok(Some(object.clone())),
        None => Err(NodeError::invalid_arg_type(
            argument,
            "object",
            args::type_name(value),
        )),
    }
}

#[cfg(feature = "node-tls")]
fn field<'js>(object: &js::Object<'js>, name: &str) -> Result<js::Value<'js>, NodeError> {
    object.get::<_, js::Value<'js>>(name).map_err(|_| {
        NodeError::new(
            "ERR_INVALID_ARG_TYPE",
            format!("The \"{name}\" property could not be read from the TLS options"),
        )
    })
}

#[cfg(feature = "node-tls")]
fn optional_field_string<'js>(
    object: &js::Object<'js>,
    name: &str,
) -> Result<Option<String>, NodeError> {
    let value = field(object, name)?;
    if value.is_undefined() || value.is_null() {
        return Ok(None);
    }
    args::string(Some(&value), name).map(Some)
}

#[cfg(feature = "node-tls")]
fn optional_field_bool<'js>(
    object: &js::Object<'js>,
    name: &str,
    default: bool,
) -> Result<bool, NodeError> {
    let value = field(object, name)?;
    if value.is_undefined() || value.is_null() {
        return Ok(default);
    }
    args::bool_value(Some(&value), name)
}

#[cfg(feature = "node-tls")]
fn optional_field_bytes<'js>(
    object: &js::Object<'js>,
    name: &str,
) -> Result<Option<Vec<u8>>, NodeError> {
    let value = field(object, name)?;
    if value.is_undefined() || value.is_null() {
        return Ok(None);
    }
    args::bytes(Some(&value), name).map(Some)
}

/// An ALPN protocol list: an array of strings in preference order (empty when omitted).
#[cfg(feature = "node-tls")]
fn field_string_array<'js>(object: &js::Object<'js>, name: &str) -> Result<Vec<String>, NodeError> {
    let value = field(object, name)?;
    if value.is_undefined() || value.is_null() {
        return Ok(Vec::new());
    }
    let Some(array) = value.as_array() else {
        return Err(NodeError::invalid_arg_type(
            name,
            "Array",
            args::type_name(&value),
        ));
    };
    let mut protocols = Vec::with_capacity(array.len());
    for index in 0..array.len() {
        let item: js::Value = array.get(index).map_err(|_| {
            NodeError::new(
                "ERR_INVALID_ARG_TYPE",
                format!("The \"{name}\" property could not be read from the TLS options"),
            )
        })?;
        protocols.push(args::string(Some(&item), name)?);
    }
    Ok(protocols)
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
                    #[cfg(feature = "node-tls")]
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
                    #[cfg(feature = "node-tls")]
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

    /// TLS options are plain data (m4-plan §2.5): PEM bytes plus the knobs Node honours.
    #[cfg(feature = "node-tls")]
    #[test]
    fn tls_options_are_carried_as_plain_data() {
        with_ctx(|ctx| {
            match build(
                &ctx,
                "connect",
                r#"["example.com", 443, null, null, null, null, null, null,
                    {servername: "example.com", rejectUnauthorized: false,
                     caPem: new Uint8Array([45, 45, 45]), alpn: ["http/1.1"]}]"#,
            )
            .expect("connect with tls")
            {
                Command::Connect(ConnectTarget::Tcp { options, .. }) => {
                    let tls = options.tls.expect("tls options");
                    assert_eq!(tls.servername.as_deref(), Some("example.com"));
                    assert!(!tls.reject_unauthorized);
                    assert_eq!(tls.ca_pem, Some(vec![45, 45, 45]));
                    assert_eq!(tls.alpn, vec!["http/1.1".to_owned()]);
                }
                other => panic!("unexpected command: {other:?}"),
            }

            match build(
                &ctx,
                "listen",
                r#"["127.0.0.1", 0, null, null, null, null,
                    {certPem: new Uint8Array([1]), keyPem: new Uint8Array([2]), alpn: ["h2"]}]"#,
            )
            .expect("listen with tls")
            {
                Command::Listen(ListenTarget::Tcp { options, .. }) => {
                    let tls = options.tls.expect("tls options");
                    assert_eq!(tls.cert_pem, vec![1]);
                    assert_eq!(tls.key_pem, vec![2]);
                    assert_eq!(tls.alpn, vec!["h2".to_owned()]);
                }
                other => panic!("unexpected command: {other:?}"),
            }
        });
    }

    #[cfg(feature = "node-tls")]
    #[test]
    fn a_tls_server_requires_cert_and_key() {
        with_ctx(|ctx| {
            let missing_key = build(
                &ctx,
                "listen",
                r#"["127.0.0.1", 0, null, null, null, null, {certPem: new Uint8Array([1])}]"#,
            )
            .expect_err("missing key");
            assert_eq!(missing_key.code, "ERR_INVALID_ARG_VALUE");

            let malformed = build(
                &ctx,
                "connect",
                r#"["127.0.0.1", 443, null, null, null, null, null, null, {alpn: "http/1.1"}]"#,
            )
            .expect_err("alpn must be an array");
            assert_eq!(malformed.code, "ERR_INVALID_ARG_TYPE");
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
