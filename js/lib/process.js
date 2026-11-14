"use strict";

// The `process` object, created by bootstrap.js after `events` is available.
//
// Kept out of bootstrap so the event-loop code there stays about scheduling. The factory takes
// the host primitives and an EventEmitter class: process is an EventEmitter in Node, and driver
// code (`uncaughtException` dispatch) relies on that.

function validateExitCode(value) {
  let code = value;
  if (typeof code === "string" && code.trim() !== "") code = Number(code);
  if (typeof code !== "number" || Number.isNaN(code)) {
    const error = new TypeError(
      `The "code" argument must be of type integer. Received ${String(value)}`,
    );
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
  if (!Number.isInteger(code) || code < -2147483648 || code > 2147483647) {
    const error = new RangeError(
      `The value of "code" is out of range. It must be an integer. Received ${String(value)}`,
    );
    error.code = "ERR_OUT_OF_RANGE";
    throw error;
  }
  return code;
}

// --- stdio -----------------------------------------------------------------------------------
//
// Node creates the standard streams lazily, and so does lite: `bootstrap.js` constructs
// `process` before the stdlib modules are loadable, and a program that never touches stdio
// should not pay for loading `stream` (and `tty` on a terminal). Each getter caches its stream
// and only calls `__ln_builtin_exports` on the first access. That hook is installed at the end
// of bootstrap, which is necessarily before user code can read `process.stdout`.
//
// `host.writeFd` is a synchronous whole-buffer write, so `_write` is synchronous and `end()`
// has nothing left to flush. Reads go through `__ln_op("read", [fd, length, -1])`; the op holds
// an external loop reference until it completes, which is what keeps the loop alive while
// stdin is open. An empty read means EOF (`push(null)`).

function requireBuiltin(name) {
  const load = globalThis.__ln_builtin_exports;
  if (typeof load !== "function") {
    // Only possible while bootstrap is still running. Let the caller fail with a useful
    // message rather than "load is not a function".
    throw new Error(`lite-node: the "${name}" builtin is not available during bootstrap`);
  }
  return load(name);
}

function isTerminal(host, fd) {
  if (fd !== 0 && fd !== 1 && fd !== 2) return false;
  try {
    return host.isTTY(fd) === true;
  } catch (_) {
    return false;
  }
}

function createOutput(host, fd) {
  if (isTerminal(host, fd)) {
    const tty = requireBuiltin("tty");
    const stream = new tty.WriteStream(fd);
    stream._isStdio = true;
    return stream;
  }
  const Writable = requireBuiltin("stream").Writable;
  const stream = new Writable({
    write(chunk, encoding, callback) {
      try {
        host.writeFd(fd, chunk);
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });
  stream.fd = fd;
  stream.isTTY = false;
  stream._isStdio = true;
  return stream;
}

function createInput(host, fd) {
  if (isTerminal(host, fd)) {
    const tty = requireBuiltin("tty");
    const stream = new tty.ReadStream(fd);
    stream._isStdio = true;
    return stream;
  }
  const Readable = requireBuiltin("stream").Readable;
  const stream = new Readable({
    highWaterMark: 64 * 1024,
    read(size) {
      const op = globalThis.__ln_op;
      if (typeof op !== "function") {
        stream.destroy(new Error("lite-node: async I/O (__ln_op) is unavailable"));
        return;
      }
      const length =
        typeof size === "number" && size > 0
          ? Math.min(Math.floor(size), 1024 * 1024)
          : 64 * 1024;
      let pending;
      try {
        pending = op("read", [fd, length, -1]);
      } catch (error) {
        stream.destroy(error);
        return;
      }
      pending.then(
        (chunk) => {
          if (stream.destroyed) return;
          if (chunk === undefined || chunk === null || chunk.length === 0) {
            stream.push(null);
            return;
          }
          stream.push(chunk);
          // The current `stream.js` fast path emits `data` from `push()` without re-arming the
          // next pull, so a flowing fd stream would stop after one chunk. `read(0)` requests the
          // next chunk only when nothing is buffered; it is a no-op once WP3 schedules that
          // itself (or when the stream is paused and the buffer has data).
          if (!stream.destroyed && stream.readableFlowing === true) stream.read(0);
        },
        (error) => {
          if (!stream.destroyed) stream.destroy(error);
        },
      );
    },
  });
  stream.fd = fd;
  stream.isTTY = false;
  stream._isStdio = true;
  return stream;
}

module.exports = function createProcess(host, EventEmitter, scheduler) {
  const info = host.osInfo();
  const startNanos = BigInt(host.hrtimeNs());
  // Node starts with `process.exitCode === undefined`; it only becomes a number when set.
  let exitCodeValue;
  let title = "lite";

  class Process extends EventEmitter {
    constructor() {
      super();
      this.argv = host.argv.slice();
      this.execArgv = [];
      this.execPath = host.argv[0];
      this.env = host.env();
      this.platform = host.platform;
      this.arch = info.arch;
      this.pid = host.pid;
      this.ppid = host.ppid;
      this.version = host.version;
      this.versions = { lite: host.version.replace(/^v/, "") };
      this.release = { name: "lite" };
      this.config = {};
      this.features = {};
      this.mainModule = undefined;
      this.allowedNodeEnvironmentFlags = new Set();
    }

    cwd() {
      return host.cwd();
    }

    chdir(directory) {
      if (typeof directory !== "string") {
        const error = new TypeError(
          `The "directory" argument must be of type string. Received ${String(directory)}`,
        );
        error.code = "ERR_INVALID_ARG_TYPE";
        throw error;
      }
      host.chdir(directory);
    }

    nextTick(callback, ...args) {
      if (typeof callback !== "function") {
        const error = new TypeError(
          `The "callback" argument must be of type function. Received ${String(callback)}`,
        );
        error.code = "ERR_INVALID_ARG_TYPE";
        throw error;
      }
      scheduler.nextTick(callback, args);
      return undefined;
    }

    exit(code) {
      const value =
        code === undefined
          ? exitCodeValue === undefined
            ? 0
            : exitCodeValue
          : validateExitCode(code);
      host.exit(value);
    }

    reallyExit(code) {
      this.exit(code);
    }

    abort() {
      host.exit(134);
    }

    hrtime(previous) {
      let nanos = BigInt(host.hrtimeNs());
      if (previous !== undefined) {
        if (!Array.isArray(previous) || previous.length !== 2) {
          const error = new TypeError(
            'The "time" argument must be an instance of Array. Received ' + String(previous),
          );
          error.code = "ERR_INVALID_ARG_TYPE";
          throw error;
        }
        nanos -= BigInt(previous[0]) * 1000000000n + BigInt(previous[1]);
      }
      return [Number(nanos / 1000000000n), Number(nanos % 1000000000n)];
    }

    uptime() {
      return Number(BigInt(host.hrtimeNs()) - startNanos) / 1e9;
    }

    memoryUsage() {
      return host.memoryUsage();
    }

    cpuUsage() {
      // No per-process CPU accounting before M5; zeroes keep the shape Node callers expect.
      return { user: 0, system: 0 };
    }

    getuid() {
      return info.uid;
    }

    getgid() {
      return info.gid;
    }

    geteuid() {
      return info.uid;
    }

    getegid() {
      return info.gid;
    }

    umask() {
      return 0;
    }

    emitWarning(warning, options) {
      let type = "Warning";
      let code;
      let detail;
      if (typeof options === "string") {
        type = options;
      } else if (options !== undefined && options !== null) {
        type = options.type || type;
        code = options.code;
        detail = options.detail;
      }
      const error = warning instanceof Error ? warning : new Error(String(warning));
      if (error.name === "Error") error.name = type;
      if (code !== undefined) error.code = code;
      if (detail !== undefined) error.detail = detail;
      if (this.listenerCount("warning") === 0) {
        host.write(`(lite:${this.pid}) ${error.name}: ${error.message}\n`, true);
      } else {
        this.emit("warning", error);
      }
    }
  }

  const process = new Process();

  // Lazy stdio. The slots are writable so tests and embedders can substitute a stream (Node's
  // properties are getter-only; being permissive here keeps the console test seam working).
  const stdio = { stdin: undefined, stdout: undefined, stderr: undefined };

  function lazyStream(slot, create) {
    return {
      enumerable: true,
      configurable: true,
      get() {
        if (stdio[slot] === undefined) stdio[slot] = create();
        return stdio[slot];
      },
      set(value) {
        stdio[slot] = value;
      },
    };
  }

  Object.defineProperty(process, "stdout", lazyStream("stdout", () => createOutput(host, 1)));
  Object.defineProperty(process, "stderr", lazyStream("stderr", () => createOutput(host, 2)));
  Object.defineProperty(process, "stdin", lazyStream("stdin", () => createInput(host, 0)));

  Object.defineProperty(process, "exitCode", {
    enumerable: true,
    configurable: true,
    get() {
      return exitCodeValue;
    },
    set(value) {
      exitCodeValue = validateExitCode(value);
      host.setExitCode(exitCodeValue);
    },
  });

  Object.defineProperty(process, "title", {
    enumerable: true,
    configurable: true,
    get() {
      return title;
    },
    set(value) {
      title = String(value);
    },
  });

  process.hrtime.bigint = function bigint() {
    return BigInt(host.hrtimeNs());
  };

  return process;
};
