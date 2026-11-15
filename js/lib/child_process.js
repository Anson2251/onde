"use strict";

// `child_process` — spawn/exec/execFile/fork over the process-handle bridge (M5, ADR-0008 §2.6).
//
// One child is one handle id and one Rust task. This file owns Node's argument normalization and
// the surface: `ChildProcess` is an EventEmitter, its stdio members are streams from
// `internal/pipe.js`, and `exec`/`execFile` are the buffering wrappers Node implements in JS too.
//
// `fork` adds the IPC channel: the Rust side creates a socketpair, the child gets one end on fd 3
// (`ONDE_IPC_FD`) and `process.send`/`message` are wired in `process.js`. The frame payload is
// JSON, not Node's wire format (D50).

const EMBEDDED = typeof __filename === "string" && __filename.startsWith("<lite:");

function requireInternal(name, relative) {
  if (EMBEDDED) return require(name);
  return require(relative);
}

const { EventEmitter } = requireInternal("events", "./events.js");
const { Buffer } = requireInternal("buffer", "./buffer.js");
const path = requireInternal("path", "./path.js");
const pipes = requireInternal("internal/pipe", "./internal/pipe.js");

const host = globalThis.__ln_host;

function invalidArgType(name, expected, actual) {
  const received = typeof actual === "string" ? `'${actual}'` : String(actual);
  const error = new TypeError(
    `The "${name}" argument must be of type ${expected}. Received ${received}`,
  );
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

function invalidArgValue(name, value, reason) {
  const error = new TypeError(`The argument '${name}' ${reason}. Received ${String(value)}`);
  error.code = "ERR_INVALID_ARG_VALUE";
  return error;
}

// --- stdio normalization ---------------------------------------------------------------------

/// Node's stdio modes for the first three slots, and whether slot 3 is an IPC channel.
function normalizeStdio(stdio, allowIpc) {
  if (stdio === undefined || stdio === null) {
    return { modes: ["pipe", "pipe", "pipe"], ipc: false };
  }
  if (typeof stdio === "string") {
    if (stdio === "ipc") {
      if (!allowIpc) {
        throw invalidArgValue("stdio", stdio, "cannot be 'ipc' outside fork()");
      }
      return { modes: ["pipe", "pipe", "pipe"], ipc: true };
    }
    return { modes: [stdio, stdio, stdio], ipc: false };
  }
  if (!Array.isArray(stdio)) {
    throw invalidArgType("stdio", "string or Array", stdio);
  }
  const modes = [];
  let ipc = false;
  for (let index = 0; index < Math.min(3, stdio.length); index += 1) {
    const entry = stdio[index];
    if (entry === undefined || entry === null) {
      modes.push("pipe");
    } else if (typeof entry === "string") {
      if (entry === "ipc") {
        throw invalidArgValue("stdio", entry, "must be in slot 3");
      }
      if (entry !== "pipe" && entry !== "ignore" && entry !== "inherit") {
        throw invalidArgValue("stdio", entry, "is not a valid stdio mode");
      }
      modes.push(entry);
    } else if (typeof entry === "number") {
      modes.push(entry);
    } else if (entry === process.stdin || entry === process.stdout || entry === process.stderr) {
      // A parent stream object means "inherit that descriptor", which is what Node does.
      modes.push("inherit");
    } else {
      throw invalidArgType("stdio", "string, number or stream", entry);
    }
  }
  while (modes.length < 3) modes.push("pipe");
  if (stdio.length > 3) {
    if (stdio[3] === "ipc") {
      if (!allowIpc) {
        throw invalidArgValue("stdio", "ipc", "cannot be 'ipc' outside fork()");
      }
      ipc = true;
    } else if (stdio[3] !== undefined && stdio[3] !== null && stdio[3] !== "ignore") {
      throw invalidArgValue("stdio", stdio[3], "is not supported in slot 3 (only 'ipc')");
    }
  }
  return { modes, ipc };
}

/// A flat `[key, value, ...]` array; `undefined` values delete the variable (Node semantics).
function environmentPairs(env) {
  const source = env === undefined || env === null ? process.env : env;
  const pairs = [];
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (value === undefined) continue;
    pairs.push(key, String(value));
  }
  return pairs;
}

function normalizeSpawnArguments(file, args, options) {
  if (typeof file !== "string" || file.length === 0) {
    throw invalidArgType("file", "non-empty string", file);
  }
  let argv = args;
  let settings = options;
  if (!Array.isArray(argv)) {
    settings = argv === undefined || argv === null ? {} : argv;
    argv = [];
  }
  if (settings === undefined || settings === null) settings = {};
  if (typeof settings !== "object") throw invalidArgType("options", "object", settings);
  for (const item of argv) {
    if (typeof item !== "string") {
      // Node stringifies array entries for the shell path only; for execFile it requires strings.
      throw invalidArgType("args", "string", item);
    }
  }

  const { modes, ipc } = normalizeStdio(settings.stdio, settings._allowIpc === true);
  let program = file;
  let programArgs = argv.slice();

  const shell = settings.shell;
  if (shell === true || typeof shell === "string") {
    const shellProgram = typeof shell === "string" ? shell : "/bin/sh";
    const command = [file, ...argv].join(" ");
    program = shellProgram;
    programArgs = ["-c", command];
  }

  return {
    program,
    args: programArgs,
    cwd: settings.cwd === undefined ? process.cwd() : String(settings.cwd),
    env: environmentPairs(settings.env),
    stdio: modes,
    detached: settings.detached === true,
    argv0: typeof settings.argv0 === "string" ? settings.argv0 : null,
    ipc: ipc || settings._ipc === true,
    shell: shell === true || typeof shell === "string",
  };
}

/** Resolve a signal name or number for the host, whose table is authoritative. */
function signalNumber(signal) {
  if (typeof signal === "number") return signal;
  const number = host.signalNumber(String(signal));
  if (typeof number !== "number") throw invalidArgValue("signal", signal, "is not a valid signal");
  return number;
}

// --- ChildProcess ----------------------------------------------------------------------------

class ChildProcess extends EventEmitter {
  constructor(id, spawnfile, spawnargs, options) {
    super();
    this._id = id;
    this.spawnfile = spawnfile;
    this.spawnargs = spawnargs;
    this.pid = undefined;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.connected = options.ipc === true;
    this.stdout = null;
    this.stderr = null;
    this.stdin = null;
    this.stdio = [null, null, null];

    const streams = pipes.createStreams(id, options.stdio);
    this.stdin = streams.stdin;
    this.stdout = streams.stdout;
    this.stderr = streams.stderr;
    this.stdio[0] = streams.stdin;
    this.stdio[1] = streams.stdout;
    this.stdio[2] = streams.stderr;
    if (options.ipc) {
      this.stdio[3] = null;
      this.channel = {
        ref: () => this.ref(),
        unref: () => this.unref(),
      };
    }
  }

  /// One handle event batch, already converted to JS payloads by the host.
  _event(name, payload) {
    switch (name) {
      case "spawn":
        this.pid = payload.pid;
        this.emit("spawn");
        return;
      case "data": {
        const stream = payload.stream === "stdout" ? this.stdout : this.stderr;
        if (stream !== null) stream.pushChunk(payload.bytes);
        return;
      }
      case "end": {
        const stream = payload.stream === "stdout" ? this.stdout : this.stderr;
        if (stream !== null) stream.endStream();
        return;
      }
      case "drain":
        if (this.stdin !== null) this.stdin.onDrain();
        return;
      case "exit":
        this.exitCode = payload.code;
        this.signalCode = payload.signal;
        this.emit("exit", payload.code, payload.signal);
        return;
      case "close":
        this.emit("close", payload.code, payload.signal);
        host.procHandles.release(this._id);
        return;
      case "error": {
        // A failed spawn emits `error` and then `close`, and never `exit`. Node's close code for a
        // spawn failure is the negated errno (`-2` for ENOENT), not null.
        this.emit("error", payload);
        const code = typeof payload.errno === "number" ? payload.errno : null;
        this.emit("close", code, null);
        host.procHandles.release(this._id);
        return;
      }
      case "message": {
        let value;
        try {
          value = JSON.parse(payload.text);
        } catch (error) {
          this.emit("messageerror", error);
          return;
        }
        this.emit("message", value);
        return;
      }
      case "disconnect":
        this.connected = false;
        this.emit("disconnect");
        return;
      default:
        return;
    }
  }

  kill(signal) {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    const number = signal === undefined ? 15 : signalNumber(signal);
    try {
      host.proc(this._id, "kill", [number]);
    } catch {
      return false;
    }
    this.killed = true;
    return true;
  }

  ref() {
    host.proc(this._id, "ref", []);
    return this;
  }

  unref() {
    host.proc(this._id, "unref", []);
    return this;
  }

  send(message, sendHandle, options, callback) {
    let done = callback;
    if (typeof sendHandle === "function") {
      done = sendHandle;
    } else if (typeof options === "function") {
      done = options;
    }
    if (!this.connected) {
      if (typeof done === "function") {
        const error = new Error("Channel closed");
        error.code = "ERR_IPC_CHANNEL_CLOSED";
        process.nextTick(done, error);
      }
      return false;
    }
    let text;
    try {
      text = JSON.stringify(message);
    } catch (error) {
      const failure = new TypeError(
        "The value of \"message\" cannot be serialized as JSON",
      );
      failure.code = "ERR_INVALID_ARG_TYPE";
      throw failure;
    }
    if (text === undefined) {
      const failure = new TypeError("The message cannot be serialized as JSON");
      failure.code = "ERR_INVALID_ARG_TYPE";
      throw failure;
    }
    try {
      host.proc(this._id, "send", [text]);
    } catch (error) {
      if (typeof done === "function") process.nextTick(done, error);
      return false;
    }
    if (typeof done === "function") process.nextTick(done, null);
    return true;
  }

  disconnect() {
    if (!this.connected) return;
    host.proc(this._id, "disconnect", []);
    this.connected = false;
    this.emit("disconnect");
  }
}

// --- spawn / exec / execFile / fork ----------------------------------------------------------

function spawn(file, args, options) {
  const normalized = normalizeSpawnArguments(file, args, options);
  const id = host.nextRequestId();
  const child = new ChildProcess(id, normalized.program, normalized.args, normalized);
  host.procHandles.register(id, (name, payload) => child._event(name, payload));
  try {
    host.proc(id, "spawn", [
      normalized.program,
      normalized.args,
      normalized.cwd,
      normalized.env,
      normalized.stdio,
      normalized.detached,
      normalized.argv0,
      normalized.ipc,
    ]);
  } catch (error) {
    host.procHandles.release(id);
    throw error;
  }
  return child;
}

function execFile(file, args, options, callback) {
  let argv = args;
  let settings = options;
  let done = callback;
  if (typeof argv === "function") {
    done = argv;
    argv = [];
    settings = {};
  } else if (typeof settings === "function") {
    done = settings;
    settings = {};
  }
  if (typeof done !== "function") {
    throw invalidArgType("callback", "function", done);
  }
  if (settings === undefined || settings === null) settings = {};
  if (!Array.isArray(argv)) argv = [];

  const encoding = settings.encoding === undefined ? "utf8" : settings.encoding;
  const maxBuffer = settings.maxBuffer === undefined ? 1024 * 1024 : Number(settings.maxBuffer);
  const timeout = settings.timeout === undefined ? 0 : Number(settings.timeout);
  const killSignal = settings.killSignal === undefined ? 15 : signalNumber(settings.killSignal);
  const command = [file, ...argv].join(" ");

  const child = spawn(file, argv, {
    cwd: settings.cwd,
    env: settings.env,
    shell: settings.shell,
    detached: settings.detached,
    argv0: settings.argv0,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let overflow = false;
  let timedOut = false;
  let settled = false;
  let timer = null;

  if (timeout > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill(killSignal);
    }, timeout);
  }

  child.stdout.on("data", (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > maxBuffer) {
      overflow = true;
      child.kill(killSignal);
      return;
    }
    stdout.push(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > maxBuffer) {
      overflow = true;
      child.kill(killSignal);
      return;
    }
    stderr.push(chunk);
  });
  child.on("error", (error) => {
    if (settled) return;
    settled = true;
    if (timer !== null) clearTimeout(timer);
    done(error, null, null);
  });

  child.on("close", (code, signal) => {
    if (settled) return;
    settled = true;
    if (timer !== null) clearTimeout(timer);
    const out = Buffer.concat(stdout);
    const err = Buffer.concat(stderr);
    const stdoutValue = encoding === null || encoding === "buffer" ? out : out.toString(encoding);
    const stderrValue = encoding === null || encoding === "buffer" ? err : err.toString(encoding);

    let error = null;
    if (timedOut) {
      error = new Error(`Command failed: ${command}\n`);
      error.killed = true;
      error.signal = signal;
      error.code = "ETIMEDOUT";
    } else if (overflow) {
      error = new Error(`Command failed: ${command}\n`);
      error.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      error.killed = child.killed;
    } else if (code !== 0 || signal !== null) {
      error = new Error(`Command failed: ${command}\n${stderrValue}`);
      error.code = code;
      error.killed = child.killed;
      error.signal = signal;
    }
    if (error !== null) {
      error.cmd = command;
      error.stdout = stdoutValue;
      error.stderr = stderrValue;
    }
    done(error, stdoutValue, stderrValue);
  });

  return child;
}

function exec(command, options, callback) {
  let settings = options;
  let done = callback;
  if (typeof settings === "function") {
    done = settings;
    settings = {};
  }
  if (typeof command !== "string") {
    throw invalidArgType("command", "string", command);
  }
  if (settings === undefined || settings === null) settings = {};
  const shell = typeof settings.shell === "string" ? settings.shell : "/bin/sh";
  return execFile(shell, ["-c", command], { ...settings, shell: false }, done);
}

function fork(modulePath, args, options) {
  let argv = args;
  let settings = options;
  if (!Array.isArray(argv)) {
    settings = argv === undefined || argv === null ? {} : argv;
    argv = [];
  }
  if (settings === undefined || settings === null) settings = {};
  const module = path.resolve(String(modulePath));
  const execPath = typeof settings.execPath === "string" ? settings.execPath : process.execPath;
  const silent = settings.silent === true;
  const stdio = settings.stdio === undefined ? [
    "pipe",
    silent ? "pipe" : "inherit",
    silent ? "pipe" : "inherit",
    "ipc",
  ] : settings.stdio;

  return spawn(execPath, [module, ...argv], {
    ...settings,
    stdio,
    _allowIpc: true,
    _ipc: true,
  });
}

module.exports = {
  ChildProcess,
  spawn,
  exec,
  execFile,
  fork,
};
