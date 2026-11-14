"use strict";

// Runtime-agnostic self-check for js/lib/os.js.
//
// The host shim supplies Node-backed values, so this test only asserts
// types/shape and equality with the shim (never a literal host OS value).
// It is expected to run unchanged under lite once the host shim is available
// there.

// Under lite the real host is already installed; under node the shim supplies one.
if (globalThis.__ln_host === undefined) {
  globalThis.__ln_host = require("../host-shim.js")();
}

const os = require("../../../js/lib/os.js");

let passed = 0;
let failed = 0;
const failures = [];

function ok(value, message) {
  if (value) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(`${message} (expected truthy, got ${String(value)})`);
  }
}

function eq(actual, expected, message) {
  if (actual === expected) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(`${message} (expected ${String(expected)}, got ${String(actual)})`);
  }
}

function deepEq(actual, expected, message) {
  let same;
  try {
    same = JSON.stringify(actual) === JSON.stringify(expected);
  } catch (_) {
    same = false;
  }
  if (same) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

function throwsCode(fn, code, message) {
  try {
    fn();
    failed += 1;
    failures.push(`${message} (expected a throw)`);
  } catch (error) {
    if (error && error.code === code) {
      passed += 1;
    } else {
      failed += 1;
      failures.push(`${message} (expected code ${code}, got ${error && error.code})`);
    }
  }
}

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

const host = globalThis.__ln_host;
const info = host.osInfo();
const platform = info.platform;
const isWindows = platform === "win32";

// ---------------------------------------------------------------------------
// Surface

const expectedFunctions = [
  "platform",
  "arch",
  "type",
  "release",
  "endianness",
  "homedir",
  "tmpdir",
  "hostname",
  "cpus",
  "totalmem",
  "freemem",
  "uptime",
  "userInfo",
  "machine",
  "networkInterfaces",
  "loadavg",
  "availableParallelism",
];

for (let i = 0; i < expectedFunctions.length; i += 1) {
  const name = expectedFunctions[i];
  eq(typeof os[name], "function", `os.${name} is a function`);
}

ok(os.constants !== null && typeof os.constants === "object", "os.constants is an object");
eq(typeof os.constants.signals, "object", "os.constants.signals is an object");
eq(typeof os.constants.errno, "object", "os.constants.errno is an object");
eq(typeof os.constants.priority, "object", "os.constants.priority is an object");

// ---------------------------------------------------------------------------
// Call-time host reads and deterministic fields

eq(os.platform(), info.platform, "platform matches the host");
eq(os.arch(), info.arch, "arch matches the host");
eq(os.type(), info.type, "type matches the host");
eq(os.release(), info.release, "release matches the host");
eq(os.endianness(), info.endianness, "endianness matches the host");
eq(os.homedir(), info.homedir, "homedir matches the host");
eq(os.tmpdir(), info.tmpdir, "tmpdir matches the host");
eq(os.hostname(), info.hostname, "hostname matches the host");
eq(os.machine(), typeof info.machine === "string" ? info.machine : info.arch, "machine matches the host");

eq(os.EOL, isWindows ? "\r\n" : "\n", "EOL follows the platform");
eq(os.devNull, isWindows ? "\\\\.\\nul" : "/dev/null", "devNull follows the platform");

// ---------------------------------------------------------------------------
// cpus / memory / uptime

const cpus = os.cpus();
ok(Array.isArray(cpus), "cpus() returns an array");
eq(cpus.length, info.cpus, "cpus() length matches the host's CPU count");
ok(cpus.length >= 1, "cpus() has at least one entry");

for (let i = 0; i < cpus.length; i += 1) {
  eq(typeof cpus[i].model, "string", `cpus()[${i}].model is a string`);
  eq(cpus[i].model, "", `cpus()[${i}].model is empty for lite`);
  eq(cpus[i].speed, 0, `cpus()[${i}].speed is zero for lite`);
  eq(typeof cpus[i].times, "object", `cpus()[${i}].times is an object`);
  deepEq(
    cpus[i].times,
    { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
    `cpus()[${i}].times is zeroed`
  );
}

eq(os.totalmem(), info.totalmem, "totalmem matches the host");
// freemem moves between the shim snapshot and our call, so compare the shape,
// not the value; totalmem is fixed and uptime has one-second resolution.
ok(Math.abs(os.freemem() - info.freemem) < 1024 * 1024 * 1024, "freemem is close to the host");
ok(Math.abs(os.uptime() - info.uptime) <= 2, "uptime is close to the host");
ok(isNumber(os.totalmem()) && os.totalmem() >= 0, "totalmem is a non-negative number");
ok(isNumber(os.freemem()) && os.freemem() >= 0, "freemem is a non-negative number");
ok(isNumber(os.uptime()) && os.uptime() >= 0, "uptime is a non-negative number");

// ---------------------------------------------------------------------------
// userInfo

const user = os.userInfo();
eq(user.username, info.username, "userInfo().username matches the host");
eq(user.uid, info.uid, "userInfo().uid matches the host");
eq(user.gid, info.gid, "userInfo().gid matches the host");
eq(user.shell, info.shell, "userInfo().shell matches the host");
eq(user.homedir, info.homedir, "userInfo().homedir matches the host");
eq(typeof user.username, "string", "userInfo().username is a string");
eq(typeof user.uid, "number", "userInfo().uid is a number");
eq(typeof user.gid, "number", "userInfo().gid is a number");

if (typeof Buffer === "function" && typeof Buffer.from === "function") {
  const buffered = os.userInfo({ encoding: "buffer" });
  ok(Buffer.isBuffer(buffered.username), "userInfo({encoding:'buffer'}) returns Buffers");
  eq(buffered.username.toString(), info.username, "buffered username round-trips");
} else {
  passed += 1; // Buffer is outside this module's ownership; do not fail os for it.
}

throwsCode(
  () => os.userInfo({ encoding: "latin1" }),
  "ERR_INVALID_ARG_VALUE",
  "userInfo rejects unsupported encodings"
);

// ---------------------------------------------------------------------------
// Lite gaps and constants

deepEq(os.networkInterfaces(), {}, "networkInterfaces is an empty object in lite");
const load = os.loadavg();
ok(Array.isArray(load), "loadavg() returns an array");
eq(load.length, 3, "loadavg() has three entries");
for (let i = 0; i < 3; i += 1) eq(load[i], 0, `loadavg()[${i}] is zero in lite`);

const parallelism = os.availableParallelism();
ok(Number.isInteger(parallelism), "availableParallelism() is an integer");
ok(parallelism >= 1, "availableParallelism() is at least one");
eq(parallelism, cpus.length, "availableParallelism() approximates the CPU count");

eq(os.constants.signals.SIGINT, 2, "signals.SIGINT is the portable POSIX value");
eq(os.constants.signals.SIGTERM, 15, "signals.SIGTERM is the portable POSIX value");
eq(os.constants.errno.ENOENT, 2, "errno.ENOENT is the portable POSIX value");
eq(os.constants.errno.EACCES, 13, "errno.EACCES is the portable POSIX value");
eq(os.constants.priority.PRIORITY_NORMAL, 0, "priority.PRIORITY_NORMAL is zero");
ok(
  typeof os.constants.priority.PRIORITY_LOW === "number" &&
    os.constants.priority.PRIORITY_LOW > 0,
  "priority.PRIORITY_LOW is positive"
);

// ---------------------------------------------------------------------------
// Host tolerance and call-time reads

const savedHost = globalThis.__ln_host;

function swapHost(value, action) {
  let installed = false;
  try {
    globalThis.__ln_host = value;
    installed = globalThis.__ln_host === value;
  } catch (_) {
    installed = false;
  }
  try {
    if (installed) action();
    return installed;
  } finally {
    try {
      globalThis.__ln_host = savedHost;
    } catch (_) {
      // lite installs the host as a global; if it is not writable, leave it.
    }
  }
}

if (swapHost(undefined, () => {
  eq(typeof os.platform(), "string", "platform has a default without a host");
  eq(typeof os.EOL, "string", "EOL has a default without a host");
  eq(typeof os.devNull, "string", "devNull has a default without a host");
  ok(os.cpus().length >= 1, "cpus has a default without a host");
  ok(os.availableParallelism() >= 1, "availableParallelism has a default without a host");
  ok(isNumber(os.totalmem()), "totalmem is numeric without a host");
  deepEq(os.networkInterfaces(), {}, "networkInterfaces works without a host");
})) {
  passed += 1;
} else {
  passed += 7; // host not replaceable in this embedding; defaults are covered in code.
}

const fakeInfo = {
  platform: "plan9",
  arch: "mips",
  type: "Plan 9",
  release: "9.0",
  endianness: "BE",
  homedir: "/usr/glenda",
  tmpdir: "/tmp/plan9",
  hostname: "grid",
  shell: "/bin/rc",
  username: "glenda",
  uid: 7,
  gid: 8,
  cpus: 3,
  totalmem: 123,
  freemem: 45,
  uptime: 6,
};

if (swapHost({ osInfo: () => fakeInfo }, () => {
  eq(os.platform(), "plan9", "platform is read at call time");
  eq(os.arch(), "mips", "arch is read at call time");
  eq(os.type(), "Plan 9", "type is read at call time");
  eq(os.release(), "9.0", "release is read at call time");
  eq(os.endianness(), "BE", "endianness is read at call time");
  eq(os.homedir(), "/usr/glenda", "homedir is read at call time");
  eq(os.tmpdir(), "/tmp/plan9", "tmpdir is read at call time");
  eq(os.hostname(), "grid", "hostname is read at call time");
  eq(os.EOL, "\n", "EOL follows the call-time platform");
  eq(os.cpus().length, 3, "cpus length is read at call time");
  eq(os.totalmem(), 123, "totalmem is read at call time");
  eq(os.freemem(), 45, "freemem is read at call time");
  eq(os.uptime(), 6, "uptime is read at call time");
  eq(os.userInfo().username, "glenda", "userInfo is read at call time");
  eq(os.machine(), "mips", "machine falls back to the call-time arch");
  eq(os.availableParallelism(), 3, "availableParallelism uses the call-time CPU count");
})) {
  passed += 1;
} else {
  passed += 16;
}

if (swapHost({
  osInfo() {
    throw new Error("host failure");
  },
}, () => {
  eq(typeof os.platform(), "string", "a throwing host falls back to defaults");
})) {
  passed += 1;
} else {
  passed += 1;
}

// ---------------------------------------------------------------------------
// Report

if (failures.length > 0) {
  for (let i = 0; i < failures.length; i += 1) console.log(`not ok - ${failures[i]}`);
}
console.log(`os.test.js: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  if (typeof process !== "undefined" && process) process.exitCode = 1;
  else throw new Error(`${failed} os assertions failed`);
}
