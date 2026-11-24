"use strict";

// `readline` — a line-oriented Interface over any `Readable`/`Writable` pair.
//
// The public surface follows Node's, but the input model is deliberately line-oriented
// (D52): there is no raw-mode key-by-key editor, no arrow-key line editing and no terminal
// width detection. `tty.setRawMode` remains an informational flag (D38), so a real terminal
// stays in canonical mode and the OS hands us whole lines. Everything here therefore works
// over a plain pipe; nothing assumes that `input` or `output` is a TTY.
//
// What the module does own:
//
//   * splitting input chunks into lines (`\n`, `\r\n`, and a lone `\r` treated as a newline),
//     including `\r\n` split across chunks, held for up to `crlfDelay` ms;
//   * prompt output (`question()`/`prompt()` write through `output.write`), terminal echo *only
//     when the terminal does not already echo* (a canonical terminal echoes keystrokes and the
//     newline itself, so echoing again printed every interactive line twice), and the `SIGINT`
//     event when a terminal interface actually sees a `\x03` byte;
//   * the in-memory `history` array (`historySize`, `removeHistoryDuplicates`);
//   * `close`/`pause`/`resume`/`[Symbol.asyncIterator]`;
//   * the ANSI cursor helpers and a small keypress decoder for `emitKeypressEvents`.
//
// Deliberate divergences from Node (reported for docs/compat.md):
//
//   * No raw-mode editing. `completer` is accepted and stored but never invoked, `history`
//     arrows do nothing, and `write()` in terminal mode treats newline characters as line
//     terminators while Node's terminal `write()` is key-based.
//   * `line` and `cursor` track the partial line only when `terminal` is true, matching Node;
//     a non-terminal interface reports `line === ""` and `cursor === undefined`.
//   * `crlfDelay` has no 100 ms floor (Node clamps smaller values up to 100 ms); `Infinity`
//     holds a trailing `\r` until more input arrives or the stream ends.
//   * `readline.promises` is not exported from this module; `readline/promises` is a separate
//     builtin. The core module stays self-contained (`events`, `string_decoder` and the leaf
//     `internal/errors` only).
//   * On a real canonical terminal `^\C` never reaches the interface, so `SIGINT` is only
//     observable for programmatic input or a non-canonical reader. The process is never
//     signalled or killed by this module.

const EventEmitter = require("events");
const { StringDecoder } = require("string_decoder");
const { invalidArgType, invalidArgValue } = require("./internal/errors.js");

const kHistorySize = 30;
const kDefaultPrompt = "> ";
const kDefaultCrlfDelay = 100;
const kKeypressDecoder = Symbol("onde.readline.keypress");

// ---------------------------------------------------------------------------------------------
// Errors and scheduling
// ---------------------------------------------------------------------------------------------

function codedError(Ctor, code, message) {
  const error = new Ctor(message);
  error.code = code;
  return error;
}

function outOfRangeSize(value) {
  return codedError(
    RangeError,
    "ERR_OUT_OF_RANGE",
    `The value of "size" is out of range. It must be >= 0. Received ${String(value)}`,
  );
}

function useAfterClose() {
  return codedError(Error, "ERR_USE_AFTER_CLOSE", "readline was closed");
}

function invalidCursorPos() {
  return codedError(
    TypeError,
    "ERR_INVALID_CURSOR_POS",
    "Cannot set cursor row without setting its column",
  );
}

function scheduleTick(fn, a, b) {
  const proc = typeof globalThis === "object" ? globalThis.process : undefined;
  if (proc && typeof proc.nextTick === "function") {
    proc.nextTick(fn, a, b);
    return;
  }
  if (typeof queueMicrotask === "function") {
    queueMicrotask(function call() {
      fn(a, b);
    });
    return;
  }
  Promise.resolve().then(function call() {
    fn(a, b);
  });
}

function streamObject(stream, name) {
  if (stream === null || typeof stream !== "object" || typeof stream.write !== "function") {
    throw invalidArgType(name || "stream", "Writable", stream);
  }
  return stream;
}

// ---------------------------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------------------------

function cursorTo(stream, x, y, callback) {
  const target = streamObject(stream, "stream");
  if (typeof y === "function") {
    callback = y;
    y = undefined;
  }
  if (typeof x !== "number" && typeof y !== "number") {
    if (typeof callback === "function") scheduleTick(callback, null);
    return;
  }
  if (typeof x === "number" && Number.isNaN(x)) {
    throw invalidArgValue("x", x, "is not a valid coordinate");
  }
  if (typeof y === "number" && Number.isNaN(y)) {
    throw invalidArgValue("y", y, "is not a valid coordinate");
  }
  if (typeof x !== "number") throw invalidCursorPos();
  if (typeof y === "number") target.write(`\u001b[${y + 1};${x + 1}H`);
  else target.write(`\u001b[${x + 1}G`);
  if (typeof callback === "function") scheduleTick(callback, null);
}

function moveCursor(stream, dx, dy, callback) {
  const target = streamObject(stream, "stream");
  if (typeof dx !== "number" && typeof dy !== "number") {
    if (typeof callback === "function") scheduleTick(callback, null);
    return;
  }
  if (typeof dx === "number" && Number.isNaN(dx)) {
    throw invalidArgValue("dx", dx, "is not a valid coordinate");
  }
  if (typeof dy === "number" && Number.isNaN(dy)) {
    throw invalidArgValue("dy", dy, "is not a valid coordinate");
  }
  let sequence = "";
  if (dx < 0) sequence += `\u001b[${-dx}D`;
  else if (dx > 0) sequence += `\u001b[${dx}C`;
  if (dy < 0) sequence += `\u001b[${-dy}A`;
  else if (dy > 0) sequence += `\u001b[${dy}B`;
  if (sequence !== "") target.write(sequence);
  if (typeof callback === "function") scheduleTick(callback, null);
}

function clearLine(stream, dir, callback) {
  const target = streamObject(stream, "stream");
  if (typeof dir === "function") {
    callback = dir;
    dir = 0;
  }
  const direction = dir === undefined ? 0 : Number(dir);
  target.write(direction < 0 ? "\u001b[1K" : direction > 0 ? "\u001b[0K" : "\u001b[2K");
  if (typeof callback === "function") scheduleTick(callback, null);
}

function clearScreenDown(stream, callback) {
  const target = streamObject(stream, "stream");
  target.write("\u001b[0J");
  if (typeof callback === "function") scheduleTick(callback, null);
}

// ---------------------------------------------------------------------------------------------
// Keypress decoding (`emitKeypressEvents`)
// ---------------------------------------------------------------------------------------------

const CSI_NAMES = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  E: "clear",
  F: "end",
  H: "home",
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4",
  Z: "tab",
};

const TILDE_NAMES = {
  1: "home",
  2: "insert",
  3: "delete",
  4: "end",
  5: "pageup",
  6: "pagedown",
  7: "home",
  8: "end",
  11: "f1",
  12: "f2",
  13: "f3",
  14: "f4",
  15: "f5",
  17: "f6",
  18: "f7",
  19: "f8",
  20: "f9",
  21: "f10",
  23: "f11",
  24: "f12",
};

function keyObject(sequence, name, extras) {
  const key = {
    sequence,
    name,
    ctrl: false,
    meta: false,
    shift: false,
  };
  if (extras !== undefined) {
    const fields = Object.keys(extras);
    for (let index = 0; index < fields.length; index += 1) {
      key[fields[index]] = extras[fields[index]];
    }
  }
  return key;
}

function modifierFlags(modifier) {
  const bits = Number(modifier) - 1;
  return {
    shift: (bits & 1) !== 0,
    meta: (bits & 2) !== 0,
    ctrl: (bits & 4) !== 0,
  };
}

// Parse one escape sequence starting at `text[0] === "\x1b"`. Returns `null` when the sequence
// is incomplete and more data may follow.
function parseEscape(text, flush) {
  if (text.length === 1) {
    if (!flush) return null;
    return { length: 1, event: [undefined, keyObject("\u001b", "escape")] };
  }
  const second = text[1];
  if (second === "[") {
    let end = 2;
    while (end < text.length && !/[A-Za-z~]/.test(text[end])) end += 1;
    if (end >= text.length) {
      if (!flush) return null;
      return {
        length: text.length,
        event: [undefined, keyObject(text, "escape", { code: text.slice(1) })],
      };
    }
    const final = text[end];
    const body = text.slice(2, end);
    const sequence = text.slice(0, end + 1);
    const parameters = body.split(";");
    const flags = parameters.length > 1 ? modifierFlags(parameters[1]) : {};
    let name;
    let code;
    if (final === "~") {
      name = TILDE_NAMES[parameters[0]] || "undefined";
      code = `[${parameters[0]}~`;
    } else {
      name = CSI_NAMES[final] || "undefined";
      // Node's `code` drops the modifier parameters: CSI 1;5A has code "[A".
      code = `[${final}`;
    }
    if (final === "Z") flags.shift = true;
    return {
      length: end + 1,
      event: [undefined, keyObject(sequence, name, Object.assign({ code }, flags))],
    };
  }
  if (second === "O") {
    if (text.length < 3) {
      if (!flush) return null;
      return {
        length: text.length,
        event: [undefined, keyObject(text, "escape", { code: text.slice(1) })],
      };
    }
    const final = text[2];
    return {
      length: 3,
      event: [undefined, keyObject(text.slice(0, 3), CSI_NAMES[final] || "undefined", { code: `O${final}` })],
    };
  }
  // ESC followed by a character is meta+character.
  const character = text[1];
  const lower = character.toLowerCase();
  return {
    length: 2,
    // Node reports meta+character through the key object only; the string argument is undefined.
    event: [
      undefined,
      keyObject(text.slice(0, 2), lower, { meta: true, shift: character !== lower }),
    ],
  };
}

function parseTextKeys(text) {
  const events = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === "\r") {
      events.push([character, keyObject(character, "return")]);
      index += 1;
      continue;
    }
    if (character === "\n") {
      events.push([character, keyObject(character, "enter")]);
      index += 1;
      continue;
    }
    if (character === "\t") {
      events.push([character, keyObject(character, "tab")]);
      index += 1;
      continue;
    }
    if (character === "\u007f" || character === "\b") {
      events.push([character, keyObject(character, "backspace")]);
      index += 1;
      continue;
    }
    if (character < " ") {
      const code = character.charCodeAt(0);
      const name = String.fromCharCode(code + 96);
      events.push([character, keyObject(character, name, { ctrl: true })]);
      index += 1;
      continue;
    }
    const codePoint = text.codePointAt(index);
    const printable = String.fromCodePoint(codePoint);
    const lower = printable.toLowerCase();
    events.push([
      printable,
      keyObject(printable, lower === printable ? printable : lower, {
        shift: lower !== printable,
      }),
    ]);
    index += printable.length;
  }
  return events;
}

class KeypressDecoder {
  constructor() {
    this.decoder = new StringDecoder("utf8");
    this.pending = "";
  }

  write(chunk) {
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    return this._parse(this.pending + text, false);
  }

  end() {
    return this._parse(this.pending + this.decoder.end(), true);
  }

  _parse(text, flush) {
    const events = [];
    let index = 0;
    let plain = "";
    const flushPlain = () => {
      if (plain === "") return;
      const decoded = parseTextKeys(plain);
      for (let offset = 0; offset < decoded.length; offset += 1) events.push(decoded[offset]);
      plain = "";
    };
    while (index < text.length) {
      if (text[index] !== "\u001b") {
        plain += text[index];
        index += 1;
        continue;
      }
      flushPlain();
      const parsed = parseEscape(text.slice(index), flush);
      if (parsed === null) {
        this.pending = text.slice(index);
        return events;
      }
      events.push(parsed.event);
      index += parsed.length;
    }
    flushPlain();
    this.pending = "";
    return events;
  }
}

function emitKeypressEvents(stream, iface) {
  if (stream === null || typeof stream !== "object" || typeof stream.on !== "function") {
    throw invalidArgType("stream", "Readable", stream);
  }
  if (stream[kKeypressDecoder] !== undefined) return;
  const decoder = new KeypressDecoder();
  Object.defineProperty(stream, kKeypressDecoder, {
    value: decoder,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  stream.on("data", function onKeypressData(chunk) {
    const events = decoder.write(chunk);
    for (let index = 0; index < events.length; index += 1) {
      stream.emit("keypress", events[index][0], events[index][1]);
    }
  });
  stream.on("end", function onKeypressEnd() {
    const events = decoder.end();
    for (let index = 0; index < events.length; index += 1) {
      stream.emit("keypress", events[index][0], events[index][1]);
    }
  });
  // `iface` is accepted for Node signature compatibility. There is no raw-mode or line-editor
  // state to attach to, so nothing else is needed.
  void iface;
}

// ---------------------------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------------------------

function stripVTControlCharacters(text) {
  return String(text)
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function visibleWidth(text) {
  return Array.from(stripVTControlCharacters(text)).length;
}

function processStdout() {
  const proc = typeof globalThis === "object" ? globalThis.process : undefined;
  return proc && proc.stdout ? proc.stdout : undefined;
}

function hostObject() {
  const host = globalThis.__ln_host;
  return host !== undefined && host !== null && typeof host === "object" ? host : null;
}

/**
 * Does the terminal echo what is typed, so the program must not?
 *
 * A real terminal in its normal (canonical) mode echoes keystrokes and the terminating newline
 * itself. Echoing the line again — which is what a raw-mode line editor does, because it turns
 * that echo off — prints every input twice and leaves an extra blank line. Node never sees this
 * because it always enters raw mode; onde's interface is line-oriented and leaves the terminal's
 * own line discipline (and its editing: backspace, ^U, ^W) in charge, so it must not echo.
 *
 * A terminal interface reading from a *pipe* has no line discipline, so there the program echoes.
 */
function echoesInput(terminal, kernelEchoes) {
  return Boolean(terminal) && !kernelEchoes;
}

function inputEchoes(input) {
  const fd = input && typeof input.fd === "number" ? input.fd : undefined;
  if (fd === undefined || fd < 0 || fd > 255) return false;
  const host = hostObject();
  if (host === null || typeof host.echoes !== "function") return false;
  try {
    return host.echoes(fd) === true;
  } catch (_) {
    return false;
  }
}

class Interface extends EventEmitter {
  constructor(input, output, completer, terminal) {
    super();

    let historySize;
    let removeHistoryDuplicates = false;
    let prompt = kDefaultPrompt;
    let crlfDelay = kDefaultCrlfDelay;

    if (input !== null && typeof input === "object" && input.input !== undefined && input.input !== null) {
      const options = input;
      input = options.input;
      output = options.output;
      completer = options.completer;
      terminal = options.terminal;
      historySize = options.historySize;
      removeHistoryDuplicates = options.removeHistoryDuplicates;
      prompt = options.prompt === undefined ? kDefaultPrompt : options.prompt;
      if (options.crlfDelay !== undefined) crlfDelay = options.crlfDelay;
    }

    if (input === null || typeof input !== "object" || typeof input.on !== "function") {
      throw invalidArgType("input", "Readable", input);
    }
    if (output === undefined || output === null) output = processStdout();
    if (output === null || typeof output !== "object" || typeof output.write !== "function") {
      throw invalidArgType("output", "Writable", output);
    }

    if (terminal === undefined) terminal = output.isTTY;
    this.terminal = Boolean(terminal);
    this._kernelEchoes = this.terminal && inputEchoes(input);
    this._echoInput = echoesInput(this.terminal, this._kernelEchoes);

    if (historySize === undefined) historySize = this.terminal ? kHistorySize : 0;
    if (typeof historySize !== "number") throw invalidArgType("size", "number", historySize);
    if (Number.isNaN(historySize) || historySize < 0) throw outOfRangeSize(historySize);
    // Node keeps a fractional historySize as given (the cap comparison floors it in effect).
    this.historySize = historySize;

    const delay = Number(crlfDelay);
    if (Number.isNaN(delay) || delay < 0) this.crlfDelay = kDefaultCrlfDelay;
    else this.crlfDelay = delay === Infinity ? Infinity : Math.floor(delay);

    this.input = input;
    this.output = output;
    this.completer = completer === undefined ? null : completer;
    this.history = [];
    this.removeHistoryDuplicates = Boolean(removeHistoryDuplicates);
    this._prompt = prompt;
    this.closed = false;
    this.paused = false;

    this._decoder = new StringDecoder("utf8");
    this._buffer = "";
    this._lineText = "";
    this._crlfTimer = null;
    this._oldPrompt = prompt;

    this._questionCallback = null;
    this._questionSignal = null;
    this._questionAbortHandler = null;

    this._iteratorQueue = [];
    this._iteratorWaiters = [];
    this._iteratorDone = false;

    this._onData = (chunk) => this._handleData(chunk);
    this._onEnd = () => this._handleEnd();
    this._onError = (error) => this.emit("error", error);

    input.on("data", this._onData);
    input.on("end", this._onEnd);
    input.on("error", this._onError);
  }

  get line() {
    return this.terminal ? this._lineText : "";
  }

  get cursor() {
    if (!this.terminal) return undefined;
    return this._lineText.length;
  }

  getPrompt() {
    return this._prompt;
  }

  setPrompt(prompt) {
    this._prompt = prompt;
  }

  prompt(preserveCursor) {
    if (this.closed) return;
    if (this.paused) this.resume();
    const text = this._prompt === undefined || this._prompt === null ? "" : String(this._prompt);
    // No line editor: `preserveCursor` only affects the (unsupported) redraw of the partial
    // line. Node keeps the line either way, so do not clear it.
    void preserveCursor;
    this._writeToOutput(text);
  }

  question(query, options, callback) {
    if (this.closed) throw useAfterClose();
    if (typeof options === "function") {
      callback = options;
      options = undefined;
    }
    const signal =
      options !== null && typeof options === "object" && options !== undefined ? options.signal : undefined;
    if (signal !== undefined && signal !== null && signal.aborted === true) return;
    if (this.paused) this.resume();

    const text = query === undefined || query === null ? "" : String(query);
    if (this._questionAbortHandler !== null) this._removeQuestionAbortHandler();
    this._oldPrompt = this.getPrompt();
    this.setPrompt(query === undefined || query === null ? "" : query);
    this._questionCallback = typeof callback === "function" ? callback : null;
    this._writeToOutput(text);

    if (signal !== undefined && signal !== null && typeof signal.addEventListener === "function") {
      const self = this;
      this._questionSignal = signal;
      this._questionAbortHandler = function onQuestionAbort() {
        if (self._questionCallback === null && self._questionAbortHandler === null) return;
        self._questionCallback = null;
        self._removeQuestionAbortHandler();
        self.setPrompt(self._oldPrompt);
        self._writeToOutput("\r\n");
      };
      signal.addEventListener("abort", this._questionAbortHandler, { once: true });
    }
  }

  write(data, key) {
    if (this.closed) return;
    if (data !== undefined && data !== null) {
      this._handleData(data);
    }
    if (
      this.terminal &&
      key !== undefined &&
      key !== null &&
      (key.name === "return" || key.name === "enter")
    ) {
      this._completeLine();
    }
  }

  pause() {
    if (this.paused || this.closed) return this;
    this.paused = true;
    if (typeof this.input.pause === "function") this.input.pause();
    this.emit("pause");
    return this;
  }

  resume() {
    if (!this.paused) return this;
    this.paused = false;
    if (typeof this.input.resume === "function") this.input.resume();
    this.emit("resume");
    return this;
  }

  close() {
    if (this.closed) return;
    this.pause();
    if (this._crlfTimer !== null) {
      clearTimeout(this._crlfTimer);
      this._crlfTimer = null;
    }
    if (typeof this.input.removeListener === "function") {
      this.input.removeListener("data", this._onData);
      this.input.removeListener("end", this._onEnd);
      this.input.removeListener("error", this._onError);
    }
    if (this._questionAbortHandler !== null) this._removeQuestionAbortHandler();
    this._questionCallback = null;
    this.closed = true;
    this._iteratorDone = true;
    this.emit("close");
    this._resolveIteratorWaiters();
  }

  getCursorPos() {
    const columns =
      this.output !== null &&
      typeof this.output === "object" &&
      typeof this.output.columns === "number" &&
      this.output.columns > 0
        ? this.output.columns
        : 80;
    const prompt = this.getPrompt();
    const promptText = prompt === undefined || prompt === null ? "" : String(prompt);
    const position = visibleWidth(promptText) + visibleWidth(this.line);
    return {
      rows: Math.floor(position / columns),
      cols: position % columns,
    };
  }

  [Symbol.asyncIterator]() {
    const self = this;
    return {
      next() {
        if (self._iteratorQueue.length > 0) {
          return Promise.resolve({ value: self._iteratorQueue.shift(), done: false });
        }
        if (self._iteratorDone) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          self._iteratorWaiters.push(resolve);
        });
      },
      return(value) {
        self._iteratorDone = true;
        self._resolveIteratorWaiters();
        return Promise.resolve({ value, done: true });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }

  // -- input ----------------------------------------------------------------------------------

  _handleData(chunk) {
    if (this.closed) return;
    let text;
    if (typeof chunk === "string") text = chunk;
    else if (chunk !== null && typeof chunk === "object" && typeof chunk.length === "number") {
      text = this._decoder.write(chunk);
    } else {
      text = String(chunk);
    }
    if (text === "") return;
    if (this.terminal && text.includes("\u0003")) {
      const parts = text.split("\u0003");
      for (let index = 1; index < parts.length; index += 1) this.emit("SIGINT");
      text = parts.join("");
    }
    if (this._crlfTimer !== null) {
      clearTimeout(this._crlfTimer);
      this._crlfTimer = null;
    }
    this._buffer += text;
    this._consume(false);
  }

  _handleEnd() {
    if (this.closed) return;
    const tail = this._decoder.end();
    if (tail !== "") this._buffer += tail;
    if (this._crlfTimer !== null) {
      clearTimeout(this._crlfTimer);
      this._crlfTimer = null;
    }
    this._consume(true);
    if (!this.closed && this._lineText !== "") this._completeLine();
    this._buffer = "";
    this.close();
  }

  _consume(flush) {
    while (!this.closed && this._buffer.length > 0) {
      const index = this._buffer.search(/[\r\n]/);
      if (index === -1) {
        this._appendText(this._buffer);
        this._buffer = "";
        return;
      }
      if (index > 0) {
        this._appendText(this._buffer.slice(0, index));
        this._buffer = this._buffer.slice(index);
      }
      const character = this._buffer[0];
      if (character === "\n") {
        this._buffer = this._buffer.slice(1);
        this._completeLine();
        continue;
      }
      if (this._buffer[1] === "\n") {
        this._buffer = this._buffer.slice(2);
        this._completeLine();
        continue;
      }
      if (this._buffer.length === 1 && !flush) {
        if (this.crlfDelay <= 0) {
          this._buffer = "";
          this._completeLine();
          return;
        }
        this._scheduleCrlfTimeout();
        return;
      }
      this._buffer = this._buffer.slice(1);
      this._completeLine();
    }
  }

  _scheduleCrlfTimeout() {
    if (!Number.isFinite(this.crlfDelay)) return;
    const timer = setTimeout(() => {
      this._crlfTimer = null;
      if (this.closed) return;
      if (this._buffer === "\r") {
        this._buffer = "";
        this._completeLine();
      } else {
        this._consume(false);
      }
    }, this.crlfDelay);
    if (timer !== null && typeof timer === "object" && typeof timer.unref === "function") {
      timer.unref();
    }
    this._crlfTimer = timer;
  }

  _appendText(text) {
    if (text === "") return;
    this._lineText += text;
    // The terminal already echoed these characters when it is a real one.
    if (this._echoInput) this._writeToOutput(text);
  }

  _completeLine() {
    const line = this._lineText;
    this._lineText = "";
    // Same rule as `_appendText`: the terminal's line discipline wrote the newline.
    if (this._echoInput) this._writeToOutput("\r\n");
    this._addHistory(line);
    if (this._questionCallback !== null) {
      const callback = this._takeQuestionCallback();
      callback(line);
      return;
    }
    this.emit("line", line);
    if (this._iteratorDone) return;
    if (this._iteratorWaiters.length > 0) {
      const resolve = this._iteratorWaiters.shift();
      resolve({ value: line, done: false });
      return;
    }
    this._iteratorQueue.push(line);
  }

  _addHistory(line) {
    // Node records history only for terminal interfaces, even when historySize is set
    // explicitly on a pipe; `history` is then caller-managed.
    if (!this.terminal || this.historySize <= 0 || line === "") return;
    if (this.removeHistoryDuplicates) {
      const index = this.history.indexOf(line);
      if (index !== -1) this.history.splice(index, 1);
    }
    this.history.unshift(line);
    while (this.history.length > this.historySize) this.history.pop();
  }

  _takeQuestionCallback() {
    const callback = this._questionCallback;
    this._questionCallback = null;
    this._removeQuestionAbortHandler();
    this.setPrompt(this._oldPrompt);
    return callback;
  }

  _removeQuestionAbortHandler() {
    if (
      this._questionAbortHandler !== null &&
      this._questionSignal !== null &&
      typeof this._questionSignal.removeEventListener === "function"
    ) {
      this._questionSignal.removeEventListener("abort", this._questionAbortHandler);
    }
    this._questionAbortHandler = null;
    this._questionSignal = null;
  }

  _resolveIteratorWaiters() {
    while (this._iteratorWaiters.length > 0) {
      const resolve = this._iteratorWaiters.shift();
      resolve({ value: undefined, done: true });
    }
  }

  _writeToOutput(text) {
    if (text === "") return;
    this.output.write(String(text));
  }
}

// `readline.createInterface` mirrors Node's two shapes:
//   createInterface(options)
//   createInterface(input, output, completer, terminal)
function createInterface(input, output, completer, terminal) {
  return new Interface(input, output, completer, terminal);
}

module.exports = {
  Interface,
  clearLine,
  clearScreenDown,
  createInterface,
  cursorTo,
  emitKeypressEvents,
  moveCursor,
};
