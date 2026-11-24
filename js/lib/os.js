"use strict";

// `os` — operating-system facts, backed by `globalThis.__ln_host`.
//
// The host is read at call time so tests can install a shim after the module
// loads. A missing host (or a host that throws) degrades to process/env-based
// defaults rather than crashing: this module is loadable in a bare test
// process.
//
// Lite gaps (documented in docs/compat.md):
//   - `networkInterfaces()` returns `{}`; the host contract has no network op.
//   - `loadavg()` is always `[0, 0, 0]`.
//   - `cpus()` reports the host's CPU count with empty model/speed/times.
//   - `machine()` falls back to the arch (the host exposes no machine string).
//   - `constants` values are a small, portable subset and are not guaranteed
//     to match the local platform (e.g. darwin signal numbers).
//   - `availableParallelism()` approximates with the CPU count.

const { invalidArgValue } = require("./internal/errors.js");

function hostObject() {
  const host = globalThis.__ln_host;
  return host !== undefined && host !== null && typeof host === "object" ? host : null;
}

function processObject() {
  const proc = globalThis.process;
  return proc !== undefined && proc !== null && typeof proc === "object" ? proc : null;
}

function detectEndianness() {
  try {
    const words = new Uint16Array([1]);
    return new Uint8Array(words.buffer)[0] === 1 ? "LE" : "BE";
  } catch (_) {
    return "LE";
  }
}

function fallbackInfo() {
  const proc = processObject();
  const env = proc && proc.env && typeof proc.env === "object" ? proc.env : {};
  const platform = proc && typeof proc.platform === "string" ? proc.platform : "linux";
  const arch = proc && typeof proc.arch === "string" ? proc.arch : "x64";
  const isWindows = platform === "win32";

  let type = "Linux";
  if (isWindows) type = "Windows_NT";
  else if (platform === "darwin") type = "Darwin";
  else if (platform === "freebsd") type = "FreeBSD";

  let homedir = "/";
  if (isWindows) homedir = env.USERPROFILE || "C:\\";
  else homedir = env.HOME || "/";

  let tmpdir = "/tmp";
  if (isWindows) tmpdir = env.TEMP || env.TMP || "C:\\Windows\\Temp";

  return {
    platform,
    arch,
    type,
    release: "0.0.0",
    endianness: detectEndianness(),
    homedir,
    tmpdir,
    hostname: env.HOSTNAME || env.HOST || "localhost",
    shell: env.SHELL || null,
    username: env.USER || env.USERNAME || "",
    uid: -1,
    gid: -1,
    cpus: 1,
    totalmem: 0,
    freemem: 0,
    uptime: 0,
    machine: arch,
  };
}

function info() {
  const host = hostObject();
  if (host !== null && typeof host.osInfo === "function") {
    try {
      const value = host.osInfo();
      if (value !== null && typeof value === "object") return value;
    } catch (_) {
      // Fall through to the defaults: os is a reporting module, not a
      // correctness boundary.
    }
  }
  return fallbackInfo();
}

function stringField(value, fallback) {
  return typeof value === "string" ? value : fallback;
}

function numberField(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function platform() {
  return stringField(info().platform, "linux");
}

function arch() {
  return stringField(info().arch, "x64");
}

function type() {
  const value = info();
  if (typeof value.type === "string") return value.type;
  const current = platform();
  if (current === "win32") return "Windows_NT";
  if (current === "darwin") return "Darwin";
  if (current === "freebsd") return "FreeBSD";
  return "Linux";
}

function release() {
  return stringField(info().release, "0.0.0");
}

function endianness() {
  return stringField(info().endianness, detectEndianness());
}

function homedir() {
  return stringField(info().homedir, platform() === "win32" ? "C:\\" : "/");
}

function tmpdir() {
  const host = hostObject();
  if (host !== null && typeof host.tmpdir === "function") {
    try {
      const value = host.tmpdir();
      if (typeof value === "string") return value;
    } catch (_) {
      // fall through
    }
  }
  const value = info().tmpdir;
  if (typeof value === "string") return value;
  return platform() === "win32" ? "C:\\Windows\\Temp" : "/tmp";
}

function hostname() {
  return stringField(info().hostname, "localhost");
}

function cpus() {
  const raw = info().cpus;
  const count = Math.max(
    0,
    Math.trunc(Array.isArray(raw) ? raw.length : numberField(raw, 1))
  );
  const result = new Array(count);
  for (let i = 0; i < count; i += 1) {
    result[i] = {
      model: "",
      speed: 0,
      times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
    };
  }
  return result;
}

function totalmem() {
  return numberField(info().totalmem, 0);
}

function freemem() {
  return numberField(info().freemem, 0);
}

function uptime() {
  return numberField(info().uptime, 0);
}

function machine() {
  const value = info();
  return stringField(value.machine, stringField(value.arch, "unknown"));
}

function networkInterfaces() {
  return {};
}

function loadavg() {
  return [0, 0, 0];
}

function availableParallelism() {
  try {
    return Math.max(1, cpus().length);
  } catch (_) {
    return 1;
  }
}

function userInfo(options) {
  let encoding = "utf8";
  if (options !== undefined) {
    if (options === null || typeof options !== "object") {
      const err = new TypeError(
        `The "options" argument must be of type object. Received ${String(options)}`
      );
      err.code = "ERR_INVALID_ARG_TYPE";
      throw err;
    }
    if (options.encoding !== undefined) {
      if (options.encoding !== "utf8" && options.encoding !== "buffer") {
        throw invalidArgValue("options.encoding", options.encoding, "is invalid");
      }
      encoding = options.encoding;
    }
  }

  const value = info();
  const username = stringField(value.username, "");
  const shell = value.shell === null || value.shell === undefined ? null : String(value.shell);
  const home = stringField(value.homedir, homedir());

  const result = Object.create(null);
  result.uid = numberField(value.uid, -1);
  result.gid = numberField(value.gid, -1);
  result.username = username;
  result.homedir = home;
  result.shell = shell;

  if (encoding === "buffer") {
    const BufferCtor = globalThis.Buffer;
    if (typeof BufferCtor === "function" && typeof BufferCtor.from === "function") {
      result.username = BufferCtor.from(username);
      result.homedir = BufferCtor.from(home);
      result.shell = shell === null ? null : BufferCtor.from(shell);
    }
  }
  return result;
}

const signals = Object.create(null);
signals.SIGHUP = 1;
signals.SIGINT = 2;
signals.SIGQUIT = 3;
signals.SIGILL = 4;
signals.SIGTRAP = 5;
signals.SIGABRT = 6;
signals.SIGBUS = 7;
signals.SIGFPE = 8;
signals.SIGKILL = 9;
signals.SIGUSR1 = 10;
signals.SIGSEGV = 11;
signals.SIGUSR2 = 12;
signals.SIGPIPE = 13;
signals.SIGALRM = 14;
signals.SIGTERM = 15;
signals.SIGCHLD = 17;
signals.SIGCONT = 18;
signals.SIGSTOP = 19;
signals.SIGTSTP = 20;
signals.SIGTTIN = 21;
signals.SIGTTOU = 22;
signals.SIGURG = 23;
signals.SIGXCPU = 24;
signals.SIGXFSZ = 25;
signals.SIGVTALRM = 26;
signals.SIGPROF = 27;
signals.SIGWINCH = 28;
signals.SIGIO = 29;
signals.SIGPWR = 30;
signals.SIGSYS = 31;

const errno = Object.create(null);
errno.EPERM = 1;
errno.ENOENT = 2;
errno.EINTR = 4;
errno.EIO = 5;
errno.EBADF = 9;
errno.EAGAIN = 11;
errno.ENOMEM = 12;
errno.EACCES = 13;
errno.EFAULT = 14;
errno.EBUSY = 16;
errno.EEXIST = 17;
errno.EXDEV = 18;
errno.ENODEV = 19;
errno.ENOTDIR = 20;
errno.EISDIR = 21;
errno.EINVAL = 22;
errno.ENFILE = 23;
errno.EMFILE = 24;
errno.ENOTTY = 25;
errno.EFBIG = 27;
errno.ENOSPC = 28;
errno.ESPIPE = 29;
errno.EROFS = 30;
errno.EPIPE = 32;
errno.EDOM = 33;
errno.ERANGE = 34;
errno.EDEADLK = 35;
errno.ENAMETOOLONG = 36;
errno.ENOSYS = 38;
errno.ENOTEMPTY = 39;
errno.ELOOP = 40;
errno.EOVERFLOW = 75;
errno.ECONNABORTED = 103;
errno.ECONNRESET = 104;
errno.ENETUNREACH = 101;
errno.EADDRINUSE = 98;
errno.EADDRNOTAVAIL = 99;
errno.ECONNREFUSED = 111;
errno.EHOSTUNREACH = 113;
errno.ETIMEDOUT = 110;

const priority = Object.create(null);
priority.PRIORITY_LOW = 19;
priority.PRIORITY_BELOW_NORMAL = 10;
priority.PRIORITY_NORMAL = 0;
if (platform() === "darwin") {
  priority.PRIORITY_ABOVE_NORMAL = -7;
  priority.PRIORITY_HIGH = -14;
} else {
  priority.PRIORITY_ABOVE_NORMAL = -10;
  priority.PRIORITY_HIGH = -20;
}
priority.PRIORITY_HIGHEST = -20;

const constants = Object.create(null);
constants.signals = signals;
constants.errno = errno;
constants.priority = priority;

const os = {
  platform,
  arch,
  type,
  release,
  endianness,
  homedir,
  tmpdir,
  hostname,
  cpus,
  totalmem,
  freemem,
  uptime,
  userInfo,
  machine,
  networkInterfaces,
  loadavg,
  availableParallelism,
  constants,
};

Object.defineProperty(os, "EOL", {
  enumerable: true,
  configurable: true,
  get() {
    return platform() === "win32" ? "\r\n" : "\n";
  },
});

Object.defineProperty(os, "devNull", {
  enumerable: true,
  configurable: true,
  get() {
    return platform() === "win32" ? "\\\\.\\nul" : "/dev/null";
  },
});

module.exports = os;
