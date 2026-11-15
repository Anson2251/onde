//! Cross-isolate serialization for `worker_threads` messages (ADR-0008 §2.3).
//!
//! The engine's own structured serializer is the only supported way to move a
//! `SharedArrayBuffer` between runtimes: the bytecode embeds the buffer's address, so the two
//! isolates must share an address space (threads in one process, never separate processes).
//! `JS_WriteObject2`/`JS_ReadObject2` with `JS_WRITE_OBJ_SAB | JS_WRITE_OBJ_REFERENCE` also give
//! cycles, typed arrays, `Date`, `Map`, `Set` and `RegExp` for free, which a hand-written clone
//! would have to re-implement badly.
//!
//! # Shared-memory ownership
//!
//! `JS_WriteObject2` returns a table of **borrowed** pointers to the shared blocks the value
//! references. A message in flight must keep those blocks alive even if the sender's isolate
//! garbage-collects the JS objects, so [`serialize`] takes one reference per pointer
//! ([`SabHandle`]) and then frees the table.
//!
//! On the receiving side `JS_ReadObject2` creates each JS buffer with the engine's own
//! `sab_dup` (see `js_array_buffer_constructor3`), so the reconstructed value owns its own
//! references. Releasing the message then drops the references it owned: [`deserialize`] consumes
//! the [`Serialized`] and lets its [`SabHandle`]s fall out of scope, on success and on failure
//! alike. There is no other place that calls `sab_dup`/`sab_free`.
//!
//! No `JSValue` crosses a thread: [`Serialized`] is owned bytes plus refcounted pointers, and a
//! value is only reconstructed on the destination thread (H1′).

use std::fmt;

use crate::js;
use crate::sab::SabHandle;

/// A value serialized on one isolate, ready to be reconstructed on another.
///
/// `Send` by construction: the bytes are plain `Vec<u8>` and each shared-memory pointer owns one
/// reference in a process-global refcount. The message must not be dropped and read concurrently;
/// like `postMessage` itself, ownership moves.
pub struct Serialized {
    /// Engine bytecode for the value.
    pub bytes: Vec<u8>,
    /// One owned reference per shared-memory block the value references.
    pub sabs: Vec<SabHandle>,
}

impl fmt::Debug for Serialized {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Serialized")
            .field("bytes", &self.bytes.len())
            .field("sabs", &self.sabs.len())
            .finish()
    }
}

/// Why a value could not be serialized or reconstructed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SerializeError {
    /// The engine's message, suitable for a `DataCloneError`-shaped JS error.
    pub message: String,
}

impl fmt::Display for SerializeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SerializeError {}

/// The flags both directions must agree on: shared buffers plus ordinary references (cycles and
/// repeated objects). Deliberately **no** `BYTECODE`: user data is serialized, functions are not.
fn write_flags() -> std::os::raw::c_int {
    (js::qjs::JS_WRITE_OBJ_SAB | js::qjs::JS_WRITE_OBJ_REFERENCE) as std::os::raw::c_int
}

fn read_flags() -> std::os::raw::c_int {
    (js::qjs::JS_READ_OBJ_SAB | js::qjs::JS_READ_OBJ_REFERENCE) as std::os::raw::c_int
}

/// Serialize `value` for another isolate in this process.
///
/// A function, symbol, weak reference or object with a function property is rejected by the
/// engine; the error is returned, not left pending.
pub fn serialize<'js>(
    ctx: &js::Ctx<'js>,
    value: &js::Value<'js>,
) -> Result<Serialized, SerializeError> {
    // SAFETY: `ctx` is live and `value` belongs to it; every raw pointer below is checked before
    // use, and the buffers are copied or freed exactly once.
    unsafe {
        let raw = ctx.as_raw().as_ptr();
        let mut len: js::qjs::size_t = 0;
        let mut table = js::qjs::JSSABTab {
            tab: std::ptr::null_mut(),
            len: 0,
        };
        let data =
            js::qjs::JS_WriteObject2(raw, &mut len, value.as_raw(), write_flags(), &mut table);
        if data.is_null() {
            let reason = ctx.catch();
            return Err(SerializeError {
                message: error_message(&reason, "could not be cloned"),
            });
        }

        let bytes = std::slice::from_raw_parts(data, len as usize).to_vec();
        // The engine allocated `data` with its own allocator; `js_free` is the matching free.
        js::qjs::js_free(raw, data.cast());

        let mut sabs = Vec::with_capacity(table.len as usize);
        if !table.tab.is_null() {
            for index in 0..table.len as usize {
                let pointer = *table.tab.add(index);
                if !pointer.is_null() {
                    // SAFETY: the engine just returned this pointer from a live buffer.
                    sabs.push(SabHandle::duplicate(pointer));
                }
            }
            // The table itself is the engine's allocation, not the pointers in it.
            js::qjs::js_free(raw, table.tab.cast());
        }

        Ok(Serialized { bytes, sabs })
    }
}

/// Reconstruct a value serialized by [`serialize`] on this isolate.
///
/// Consumes `message`, releasing the shared-memory references it owns once the value has taken its
/// own. On failure the same references are released and the pending exception is cleared.
pub fn deserialize<'js>(
    ctx: &js::Ctx<'js>,
    message: Serialized,
) -> Result<js::Value<'js>, SerializeError> {
    let Serialized { bytes, sabs } = message;
    // A pointer array is only needed to tell the engine about the shared blocks; the engine records
    // the same pointers itself when `psab_tab` is null, and frees its own table. Passing null
    // avoids a second allocation that we would have to release without touching the refs.
    let _ = &sabs;
    // SAFETY: `ctx` is live; `bytes` outlives the call; the SAB pointers are kept alive by `sabs`
    // until after the engine has taken its own references during the read.
    unsafe {
        let raw = ctx.as_raw().as_ptr();
        let raw_value = js::qjs::JS_ReadObject2(
            raw,
            bytes.as_ptr(),
            bytes.len() as js::qjs::size_t,
            read_flags(),
            std::ptr::null_mut(),
        );
        if js::qjs::JS_IsException(raw_value) {
            let reason = ctx.catch();
            return Err(SerializeError {
                message: error_message(&reason, "could not be deserialized"),
            });
        }
        // The reconstructed value owns its own shared-memory references; `sabs` dropping at the end
        // of this scope releases the message's references.
        Ok(js::Value::from_raw(ctx.clone(), raw_value))
    }
}

/// Detach an `ArrayBuffer` after its contents have been serialized (`transferList`).
///
/// The destination gets a copy; the detach is what makes the source observably unusable, which is
/// the part Node code depends on.
pub fn detach_buffer<'js>(ctx: &js::Ctx<'js>, value: &js::Value<'js>) {
    // SAFETY: both pointers belong to a live context; the engine checks the object type and is a
    // no-op for anything that is not a detachable ArrayBuffer.
    unsafe {
        js::qjs::JS_DetachArrayBuffer(ctx.as_raw().as_ptr(), value.as_raw());
    }
}

/// A short human-readable message from a caught value, for the JS layer to wrap.
fn error_message(value: &js::Value<'_>, fallback: &str) -> String {
    if value.is_exception() {
        return fallback.to_owned();
    }
    let message = value
        .as_object()
        .and_then(|object| object.get::<_, js::String>("message").ok())
        .and_then(|message| message.to_string().ok())
        .filter(|message| !message.is_empty());
    match message {
        Some(message) => message,
        None => value
            .as_string()
            .and_then(|text| text.to_string().ok())
            .or_else(|| value.as_int().map(|number| number.to_string()))
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| fallback.to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Engine;

    fn round_trip(source: &str, check: &str) -> String {
        let sender = Engine::new().expect("sender");
        let message = sender.with_ctx(|ctx| {
            let value: js::Value = ctx.eval(source).expect("source");
            serialize(&ctx, &value).expect("serialize")
        });
        let receiver = Engine::new().expect("receiver");
        receiver.with_ctx(|ctx| {
            let value = deserialize(&ctx, message).expect("deserialize");
            ctx.globals().set("__in", value).expect("global");
            ctx.eval::<String, _>(check).expect("check")
        })
    }

    #[test]
    fn structured_values_round_trip() {
        let _guard = crate::sab::TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert_eq!(
            round_trip(
                "({ map: new Map([[1, 'a']]), set: new Set([2, 3]), date: new Date(0), \
                   re: /x/gi, bytes: new Uint8Array([1, 2, 3]), nested: { a: [1, null] } })",
                "[__in.map.get(1), __in.set.has(3), __in.date.getTime(), __in.re.source, \
                  __in.re.flags, Array.from(__in.bytes).join(''), __in.nested.a[1]].join('|')"
            ),
            "a|true|0|x|gi|123|"
        );
    }

    #[test]
    fn cycles_round_trip() {
        assert_eq!(
            round_trip(
                "const a = { name: 'a' }; a.self = a; a",
                "__in.self === __in && __in.name"
            ),
            "a"
        );
    }

    #[test]
    fn functions_are_rejected_without_a_pending_exception() {
        let engine = Engine::new().expect("engine");
        let error = engine.with_ctx(|ctx| {
            let value: js::Value = ctx.eval("() => 1").expect("eval");
            let error = serialize(&ctx, &value).expect_err("a function is not cloneable");
            // The engine exception must have been consumed; the context is still usable.
            ctx.eval::<f64, _>("1 + 1").expect("context still usable");
            error
        });
        assert!(!error.message.is_empty());
    }

    #[test]
    fn garbage_is_rejected_without_a_pending_exception() {
        let engine = Engine::new().expect("engine");
        let error = engine.with_ctx(|ctx| {
            let message = Serialized {
                bytes: vec![0, 1, 2, 3, 4, 5, 6, 7],
                sabs: Vec::new(),
            };
            let error = deserialize(&ctx, message).expect_err("garbage");
            ctx.eval::<f64, _>("2 + 2").expect("context still usable");
            error
        });
        assert!(!error.message.is_empty());
    }

    #[test]
    fn detaching_an_array_buffer_makes_it_unusable() {
        let engine = Engine::new().expect("engine");
        engine.with_ctx(|ctx| {
            let value: js::Value = ctx
                .eval("globalThis.__ab = new ArrayBuffer(8); new Uint8Array(__ab)[0] = 7; __ab")
                .expect("eval");
            let message = serialize(&ctx, &value).expect("serialize");
            detach_buffer(&ctx, &value);
            let state = ctx
                .eval::<String, _>(
                    "try { String(new Uint8Array(__ab).length) } catch (e) { 'detached' }",
                )
                .expect("eval");
            assert!(state == "detached" || state == "0", "got {state}");
            drop(message);
        });
    }
}
