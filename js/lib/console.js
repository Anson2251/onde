"use strict";

// `console` — the global console and the `Console` class.
//
// `util` is required lazily so this module can load before the rest of the
// stdlib (and under a bare test process). Default streams are resolved lazily
// through getters so `bootstrap.js` may install `process.stdout`/`stderr`
// after this module is evaluated. A missing stream degrades to a no-op writer
// rather than crashing.
//
// Lite gaps (documented in docs/compat.md):
//   - `colorMode` is accepted but output is never colorized.
//   - `table()` handles arrays/objects of primitive or flat object values; it
//     is not Node's full cli_table (no Map/Set iteration, no multiline cells).
//   - `clear()` only emits a cursor-home/clear-screen sequence for TTYs.
//   - `time()` durations use the platform's millisecond clock and are formatted
//     as `ms`/`s`; Node's exact `formatTime` thresholds are not reproduced.

const noopStream = {
  write() {
    return true;
  },
  isTTY: false,
};

function processObject() {
  const proc = globalThis.process;
  return proc !== undefined && proc !== null && typeof proc === "object" ? proc : null;
}

function defaultStdout() {
  const proc = processObject();
  const stream = proc && proc.stdout;
  return stream && typeof stream.write === "function" ? stream : noopStream;
}

function defaultStderr() {
  const proc = processObject();
  const stream = proc && proc.stderr;
  return stream && typeof stream.write === "function" ? stream : noopStream;
}

let utilModule;
let utilLoaded = false;

function getUtil() {
  if (!utilLoaded) {
    utilLoaded = true;
    try {
      utilModule = require("util");
    } catch (_) {
      utilModule = null;
    }
  }
  return utilModule;
}

function fallbackInspect(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `'${value}'`;
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return `[Function: ${value.name || "anonymous"}]`;
  if (typeof value === "object") {
    try {
      if (Array.isArray(value)) return `[ ${value.map(fallbackInspect).join(", ")} ]`;
      const keys = Object.keys(value);
      if (keys.length === 0) return "{}";
      return `{ ${keys.map((key) => `${key}: ${fallbackInspect(value[key])}`).join(", ")} }`;
    } catch (_) {
      return String(value);
    }
  }
  return String(value);
}

function fallbackFormat(...args) {
  if (args.length === 0) return "";
  if (typeof args[0] !== "string") return args.map(fallbackInspect).join(" ");
  let index = 1;
  const format = args[0].replace(/%[sdifjoOc%]/g, (match) => {
    if (match === "%%") return "%";
    if (index >= args.length) return match;
    const value = args[index];
    index += 1;
    switch (match) {
      case "%s":
        return typeof value === "string" ? value : fallbackInspect(value);
      case "%d":
        return typeof value === "bigint" ? `${value}n` : String(Number(value));
      case "%i":
        return String(Number.parseInt(value, 10));
      case "%f":
        return String(Number.parseFloat(value));
      case "%j":
        try {
          return JSON.stringify(value);
        } catch (_) {
          return "[Circular]";
        }
      default:
        return fallbackInspect(value);
    }
  });
  const rest = args.slice(index).map(fallbackInspect);
  return rest.length > 0 ? `${format} ${rest.join(" ")}` : format;
}

function formatArgs(args, inspectOptions) {
  if (args.length === 0) return "";
  if (args.length === 1 && typeof args[0] === "string") return args[0];
  const util = getUtil();
  if (util) {
    try {
      if (
        inspectOptions !== undefined &&
        typeof util.formatWithOptions === "function"
      ) {
        return util.formatWithOptions(inspectOptions, ...args);
      }
      if (typeof util.format === "function") return util.format.apply(null, args);
    } catch (_) {
      // fall through to the local formatter
    }
  }
  return fallbackFormat.apply(null, args);
}

function inspectValue(value, options) {
  const util = getUtil();
  if (util && typeof util.inspect === "function") {
    try {
      return util.inspect(value, options);
    } catch (_) {
      // fall through to the local formatter
    }
  }
  return fallbackInspect(value);
}

function nowMilliseconds() {
  const performance = globalThis.performance;
  if (performance && typeof performance.now === "function") {
    try {
      return performance.now();
    } catch (_) {
      // fall through
    }
  }
  const proc = processObject();
  if (proc && typeof proc.hrtime === "function") {
    const time = proc.hrtime();
    return time[0] * 1000 + time[1] / 1e6;
  }
  return Date.now();
}

function formatDuration(milliseconds) {
  if (milliseconds >= 1000) return `${(milliseconds / 1000).toFixed(3)}s`;
  return `${milliseconds.toFixed(3)}ms`;
}

function writableStreamError(name) {
  const err = new TypeError(
    `The "${name}" option must be a stream with a write method. Received ${String(name)}`
  );
  err.code = "ERR_CONSOLE_WRITABLE_STREAM";
  return err;
}

function tableCell(value, options) {
  if (value === undefined) return "";
  let text = inspectValue(value, options);
  if (text.indexOf("\n") !== -1) text = text.replace(/\n/g, " ");
  return text;
}

function tableColumns(values, properties) {
  if (Array.isArray(properties) && properties.length > 0) {
    return properties.map((property) => String(property));
  }
  const columns = [];
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value === null || typeof value !== "object") continue;
    const keys = Object.keys(value);
    for (let j = 0; j < keys.length; j += 1) {
      if (columns.indexOf(keys[j]) === -1) columns.push(keys[j]);
    }
  }
  return columns;
}

function drawTable(headers, rows) {
  const widths = headers.map((header) => String(header).length);
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = 0; j < headers.length; j += 1) {
      if (rows[i][j].length > widths[j]) widths[j] = rows[i][j].length;
    }
  }

  const border = (left, middle, right) => {
    let text = left;
    for (let i = 0; i < widths.length; i += 1) {
      if (i > 0) text += middle;
      text += "─".repeat(widths[i] + 2);
    }
    return text + right;
  };

  const line = (cells) => {
    let text = "│";
    for (let i = 0; i < widths.length; i += 1) {
      text += ` ${String(cells[i]).padEnd(widths[i])} │`;
    }
    return text;
  };

  const lines = [
    border("┌", "┬", "┐"),
    line(headers),
    border("├", "┼", "┤"),
  ];
  for (let i = 0; i < rows.length; i += 1) lines.push(line(rows[i]));
  lines.push(border("└", "┴", "┘"));
  return lines.join("\n");
}

class Console {
  constructor(stdout, stderr) {
    let options;
    if (stdout === undefined) {
      options = {};
    } else if (stdout !== null && typeof stdout === "object" && typeof stdout.write !== "function") {
      options = stdout;
    } else {
      options = { stdout, stderr };
    }

    let out = options.stdout;
    let err = options.stderr;
    if (out !== undefined && (out === null || typeof out.write !== "function")) {
      throw writableStreamError("stdout");
    }
    if (err !== undefined && (err === null || typeof err.write !== "function")) {
      throw writableStreamError("stderr");
    }
    if (out !== undefined && err === undefined) err = out;

    const groupIndentation = options.groupIndentation === undefined ? 2 : options.groupIndentation;
    if (
      typeof groupIndentation !== "number" ||
      !Number.isInteger(groupIndentation) ||
      groupIndentation < 0
    ) {
      const err2 = new RangeError(
        `The value of "options.groupIndentation" is out of range. Received ${String(groupIndentation)}`
      );
      err2.code = "ERR_OUT_OF_RANGE";
      throw err2;
    }

    this._ignoreErrors = options.ignoreErrors === undefined ? true : Boolean(options.ignoreErrors);
    this._inspectOptions =
      options.inspectOptions !== undefined && typeof options.inspectOptions === "object"
        ? options.inspectOptions
        : undefined;
    this._groupIndent = "";
    this._groupIndentation = groupIndentation;
    this._times = new Map();
    this._counts = new Map();
    // Node's Console has none of these in `Object.keys(console)`; keep reflection clean.
    for (const key of [
      "_ignoreErrors",
      "_inspectOptions",
      "_groupIndent",
      "_groupIndentation",
      "_times",
      "_counts",
    ]) {
      Object.defineProperty(this, key, {
        enumerable: false,
        configurable: true,
        writable: true,
        value: this[key],
      });
    }

    Object.defineProperty(this, "_stdout", {
      enumerable: false,
      configurable: true,
      get() {
        if (out === undefined) out = defaultStdout();
        return out;
      },
      set(value) {
        out = value;
      },
    });
    Object.defineProperty(this, "_stderr", {
      enumerable: false,
      configurable: true,
      get() {
        if (err === undefined) err = defaultStderr();
        return err;
      },
      set(value) {
        err = value;
      },
    });

    // Node binds the Console methods to the instance; keep destructuring and
    // callbacks working the same way.
    const names = Object.getOwnPropertyNames(Console.prototype);
    for (let i = 0; i < names.length; i += 1) {
      const name = names[i];
      // Private helpers stay on the prototype; Node's console only binds the public surface.
      if (name.startsWith("_") || name === "constructor") continue;
      if (name === "constructor") continue;
      const member = this[name];
      if (typeof member === "function") this[name] = member.bind(this);
    }
  }

  _stream(isError) {
    return isError ? this._stderr : this._stdout;
  }

  _write(isError, text) {
    const stream = this._stream(isError);
    if (stream === null || stream === undefined || typeof stream.write !== "function") return;
    const indent = this._groupIndent;
    if (indent) {
      if (text.indexOf("\n") !== -1) text = text.replace(/\n/g, `\n${indent}`);
      text = indent + text;
    }
    try {
      stream.write(`${text}\n`);
    } catch (error) {
      if (this._ignoreErrors === false) throw error;
    }
  }

  _warn(message) {
    const proc = processObject();
    if (proc && typeof proc.emitWarning === "function") {
      proc.emitWarning(message);
      return;
    }
    this._write(true, `Warning: ${message}`);
  }

  log(...args) {
    this._write(false, formatArgs(args, this._inspectOptions));
  }

  info(...args) {
    this._write(false, formatArgs(args, this._inspectOptions));
  }

  debug(...args) {
    this._write(false, formatArgs(args, this._inspectOptions));
  }

  warn(...args) {
    this._write(true, formatArgs(args, this._inspectOptions));
  }

  error(...args) {
    this._write(true, formatArgs(args, this._inspectOptions));
  }

  dir(object, options) {
    const inspectOptions = Object.assign(
      { customInspect: false },
      this._inspectOptions,
      options
    );
    this._write(false, inspectValue(object, inspectOptions));
  }

  trace(...args) {
    const error = new Error();
    let stack = typeof error.stack === "string" ? error.stack : "";
    const lines = stack.split("\n");
    if (lines.length > 0 && /^Error/.test(lines[0])) lines.shift();
    // Drop the frame for `trace` itself; Node uses ErrorCaptureStackTrace with
    // the trace function as the stack's boundary for the same reason.
    if (lines.length > 0 && /(?:^|\W)Console\.trace\b/.test(lines[0])) lines.shift();
    stack = lines.join("\n");
    const head = args.length > 0 ? `Trace: ${formatArgs(args, this._inspectOptions)}` : "Trace";
    this._write(true, stack ? `${head}\n${stack}` : head);
  }

  assert(expression, ...args) {
    if (expression) return;
    if (args.length > 0 && typeof args[0] === "string") {
      args[0] = `Assertion failed: ${args[0]}`;
    } else {
      args.unshift("Assertion failed");
    }
    this.warn(...args);
  }

  time(label = "default") {
    const name = `${label}`;
    if (this._times.has(name)) {
      this._warn(`Label '${name}' already exists for console.time()`);
      return;
    }
    this._times.set(name, nowMilliseconds());
  }

  timeEnd(label = "default") {
    const name = `${label}`;
    if (!this._times.has(name)) {
      this._warn(`No such label '${name}' for console.timeEnd()`);
      return;
    }
    const duration = nowMilliseconds() - this._times.get(name);
    this._times.delete(name);
    this.log(`${name}: ${formatDuration(duration)}`);
  }

  timeLog(label = "default", ...data) {
    const name = `${label}`;
    if (!this._times.has(name)) {
      this._warn(`No such label '${name}' for console.timeLog()`);
      return;
    }
    const duration = formatDuration(nowMilliseconds() - this._times.get(name));
    if (data.length > 0) {
      this.log(`${name}: ${duration} ${formatArgs(data, this._inspectOptions)}`);
    } else {
      this.log(`${name}: ${duration}`);
    }
  }

  count(label = "default") {
    const name = `${label}`;
    const next = (this._counts.get(name) || 0) + 1;
    this._counts.set(name, next);
    this.log(`${name}: ${next}`);
  }

  countReset(label = "default") {
    const name = `${label}`;
    if (!this._counts.has(name)) {
      this._warn(`Count for '${name}' does not exist`);
      return;
    }
    this._counts.delete(name);
  }

  group(...data) {
    if (data.length > 0) this.log(...data);
    this._groupIndent += " ".repeat(this._groupIndentation);
  }

  groupCollapsed(...data) {
    if (data.length > 0) this.log(...data);
    this._groupIndent += " ".repeat(this._groupIndentation);
  }

  groupEnd() {
    if (this._groupIndent.length === 0) return;
    this._groupIndent = this._groupIndent.slice(
      0,
      Math.max(0, this._groupIndent.length - this._groupIndentation)
    );
  }

  table(tabularData, properties) {
    if (tabularData === null || typeof tabularData !== "object") {
      this.log(tabularData);
      return;
    }

    const values = [];
    const indexes = [];
    if (Array.isArray(tabularData)) {
      for (let i = 0; i < tabularData.length; i += 1) {
        indexes.push(String(i));
        values.push(tabularData[i]);
      }
    } else {
      const keys = Object.keys(tabularData);
      for (let i = 0; i < keys.length; i += 1) {
        indexes.push(keys[i]);
        values.push(tabularData[keys[i]]);
      }
    }

    let objectRows = values.length > 0;
    for (let i = 0; i < values.length; i += 1) {
      const value = values[i];
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        objectRows = false;
        break;
      }
    }

    const inspectOptions = Object.assign(
      { depth: 0, breakLength: Infinity, maxArrayLength: 3 },
      this._inspectOptions
    );

    let headers;
    const rows = [];
    if (objectRows) {
      const columns = tableColumns(values, properties);
      headers = ["(index)"].concat(columns);
      for (let i = 0; i < values.length; i += 1) {
        const value = values[i];
        const row = [indexes[i]];
        for (let j = 0; j < columns.length; j += 1) {
          const column = columns[j];
          row.push(
            Object.prototype.hasOwnProperty.call(value, column)
              ? tableCell(value[column], inspectOptions)
              : ""
          );
        }
        rows.push(row);
      }
    } else {
      headers = ["(index)", "Values"];
      for (let i = 0; i < values.length; i += 1) {
        rows.push([indexes[i], tableCell(values[i], inspectOptions)]);
      }
    }

    this._write(false, drawTable(headers, rows));
  }

  clear() {
    const stream = this._stdout;
    if (!stream || !stream.isTTY) return;
    const proc = processObject();
    if (proc && proc.env && proc.env.TERM === "dumb") return;
    try {
      stream.write("\x1b[1;1H\x1b[0J");
    } catch (error) {
      if (this._ignoreErrors === false) throw error;
    }
  }
}

const globalConsole = new Console();
globalConsole.Console = Console;

module.exports = globalConsole;
