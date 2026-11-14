//! stdout/stderr primitives: the raw `write` used by `console`/`process`, the synchronous fd
//! write, and the TTY queries.

use std::io::{self, IsTerminal, Write};

use ln_engine::js;
use ln_error::NodeError;

use crate::args;
use crate::host_error::throw_node_error_value;

use super::HostState;

pub(super) fn install<'js>(
    ctx: &js::Ctx<'js>,
    host: &js::Object<'js>,
    _state: &HostState,
) -> js::Result<()> {
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

    Ok(())
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
        .map_err(|error| NodeError::system(&error, "write", std::path::Path::new("")))?;
    Ok(data.len() as u64)
}
