"use strict";

// The host-surface inventory (ADR-0011 §7, D14).
//
// `__ln_host` is frozen but reachable from a script, so the surface may not grow silently: a new
// property fails this test until it is added here with a classification. The privileged reads are
// deliberately absent: they live on `__ln_loader`, which the bootstrap deletes after the loader
// captures it.
//
// Run under `onde`; no policy is needed.

const KNOWN_HOST = new Set([
    "argv",
    "asyncCurrent",
    "asyncDestroy",
    "asyncEnable",
    "asyncEnter",
    "asyncForced",
    "asyncInit",
    "asyncInits",
    "asyncLeave",
    "asyncStart",
    "buffer",
    "builtinUnavailable",
    "chdir",
    "clearImmediate",
    "clearTimer",
    "columns",
    "cpuUsage",
    "crypto",
    "cwd",
    "detachBuffer",
    "dnsAsync",
    "dnsHints",
    "echoes",
    "env",
    "exit",
    "ffi",
    "fsAsync",
    "fsCancel",
    "fsSync",
    "handle",
    "handles",
    "hrtimeNs",
    "immediateRef",
    "ipc",
    "ipcFd",
    "isTTY",
    "kill",
    "memoryUsage",
    "net",
    "nextRequestId",
    "nextTick",
    "nodeVersion",
    "osInfo",
    "permissionHas",
    "pid",
    "platform",
    "ppid",
    "proc",
    "procHandles",
    "reject",
    "setExitCode",
    "setImmediate",
    "setTimer",
    "setUncatchable",
    "signal",
    "signalName",
    "signalNumber",
    "sqlite",
    "text",
    "timerRef",
    "version",
    "worker",
    "workerInfo",
    "workers",
    "write",
    "writeFd",
    "zlib",
]);

// Every `__ln_*` global the bootstrap installs. `__ln_host` is here; `__ln_loader` must not be.
const KNOWN_GLOBALS = new Set([
    "__ln_host",
    "__ln_async_control",
    "__ln_track_rejection",
    "__ln_make_error",
    "__ln_forget_rejection",
    "__ln_emit_uncaught",
    "__ln_emit_unhandled",
    "__ln_emit_rejection_handled",
    "__ln_emit_before_exit",
    "__ln_emit_exit",
    "__ln_dispatch",
    "__ln_op",
    "__ln_op_done",
    "__ln_dns_op",
    "__ln_handle_event",
    "__ln_worker_event",
    "__ln_proc_event",
    "__ln_ipc_event",
    "__ln_parent_message",
    "__ln_parent_message_error",
    "__ln_detach_buffer",
    "__ln_signal",
    "__ln_cjs_namespace",
    "__ln_builtin_exports",
    "__ln_builtin_export_names",
    "__ln_meta_resolve",
    "__ln_run_cjs",
    "__ln_format_result",
    "__ln_expose_require",
]);

// Names that used to be on `__ln_host` and are now privileged or deleted. Re-appearing is a
// regression, not a new property.
// `builtinUnavailable` is deliberately public: `constants.js` asks it before requiring the
// optional `node:crypto` module. The loader has a privileged copy as well.
const REMOVED = [
    "readFile",
    "realpath",
    "statKind",
    "readSource",
    "readData",
    "builtinSource",
    "builtinNames",
    "nodeOnlyBuiltins",
    "evalCjs",
    "resolve",
    "metaResolve",
];

function fail(message) {
    console.error("inventory: " + message);
    process.exit(1);
}

const host = globalThis.__ln_host;
if (host === null || host === undefined) fail("__ln_host is missing");
if (!Object.isFrozen(host)) fail("__ln_host is not frozen");

const hostNames = Object.getOwnPropertyNames(host);
const unknownHost = hostNames.filter((name) => !KNOWN_HOST.has(name)).sort();
if (unknownHost.length !== 0) fail("unclassified __ln_host properties: " + unknownHost.join(", "));

for (const name of REMOVED) {
    if (name in host) fail("privileged name still on __ln_host: " + name);
}
if (typeof globalThis.__ln_loader !== "undefined") fail("__ln_loader was not deleted");

const globals = Object.getOwnPropertyNames(globalThis).filter((name) => name.startsWith("__ln"));
const unknownGlobals = globals.filter((name) => !KNOWN_GLOBALS.has(name)).sort();
if (unknownGlobals.length !== 0) fail("unclassified __ln_* globals: " + unknownGlobals.join(", "));

for (const required of ["fsSync", "fsAsync", "env", "permissionHas", "write", "nextRequestId"]) {
    if (!(required in host)) fail("missing host primitive: " + required);
}
if (!process.permission || !Object.isFrozen(process.permission))
    fail("process.permission is not a frozen object");
if (typeof process.permission.has !== "function") fail("process.permission.has is missing");

console.log(
    "inventory ok: " + hostNames.length + " host properties, " + globals.length + " __ln_* globals",
);
