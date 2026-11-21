// `queueMicrotask` validates its argument like Node does: a TypeError with
// ERR_INVALID_ARG_TYPE, thrown synchronously. M6 replaced the engine's native
// global with a wrapper that mints the microtask's async_hooks resource, and
// the wrapper now performs the check the engine omitted (D2 retired).
try {
  queueMicrotask(1);
} catch (e) {
  console.log(e.name, e.code);
}
