"use strict";

// Runtime-agnostic self-check for js/lib/readline.js and js/lib/readline-promises.js.
// Runs under `node` and under lite: the module under test is required by relative path, the
// input/output streams are small in-memory fakes (no timers except the crlfDelay cases), and
// every assertion compares literals.
//
// The fake input delivers `data` synchronously from `feed()`, which keeps line order and
// pause/resume observable without depending on stream scheduling. A paused fake drops chunks,
// like a paused stream that has not been read yet.

const EventEmitter = require("../../../js/lib/events.js");

const readline = require("../../../js/lib/readline.js");
const readlinePromises = require("../../../js/lib/readline-promises.js");

const {
  Interface,
  clearLine,
  clearScreenDown,
  createInterface,
  cursorTo,
  emitKeypressEvents,
  moveCursor,
} = readline;

let passed = 0;
let failed = 0;
const failures = [];

function record(condition, detail) {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(detail);
  }
}

function ok(value, message) {
  record(Boolean(value), `${message} (expected truthy, got ${String(value)})`);
}

function eq(actual, expected, message) {
  record(actual === expected, `${message} (expected ${String(expected)}, got ${String(actual)})`);
}

function deepEq(actual, expected, message) {
  let same;
  try {
    same = JSON.stringify(actual) === JSON.stringify(expected);
  } catch (_) {
    same = false;
  }
  record(
    same,
    `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
  );
}

function throwsCode(fn, code, message) {
  try {
    fn();
    record(false, `${message} (expected a throw)`);
    return undefined;
  } catch (error) {
    record(error && error.code === code, `${message} (code was ${error && error.code})`);
    return error;
  }
}

function tick(milliseconds) {
  return new Promise((resolve) =>
    setTimeout(resolve, milliseconds === undefined ? 10 : milliseconds),
  );
}

class FakeInput extends EventEmitter {
  constructor() {
    super();
    this.paused = false;
    this.ended = false;
  }

  pause() {
    this.paused = true;
    return this;
  }

  resume() {
    this.paused = false;
    return this;
  }

  feed(chunk) {
    if (this.ended || this.paused) return false;
    this.emit("data", chunk);
    return true;
  }

  end(chunk) {
    if (chunk !== undefined) {
      if (!this.paused && !this.ended) this.emit("data", chunk);
    }
    this.ended = true;
    this.emit("end");
  }
}

class FakeOutput {
  constructor(options) {
    const settings = options || {};
    this.data = "";
    this.chunks = [];
    this.isTTY = settings.isTTY === true;
    if (settings.columns !== undefined) this.columns = settings.columns;
  }

  write(chunk) {
    const text = String(chunk);
    this.data += text;
    this.chunks.push(text);
    return true;
  }
}

function pair(options) {
  const input = new FakeInput();
  const output = new FakeOutput(options);
  const settings = Object.assign({ input, output }, options);
  return { input, output, rl: createInterface(settings) };
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Shape

test("module shape", () => {
  eq(typeof createInterface, "function", "createInterface is exported");
  eq(typeof Interface, "function", "Interface is exported");
  eq(typeof cursorTo, "function", "cursorTo is exported");
  eq(typeof moveCursor, "function", "moveCursor is exported");
  eq(typeof clearLine, "function", "clearLine is exported");
  eq(typeof clearScreenDown, "function", "clearScreenDown is exported");
  eq(typeof emitKeypressEvents, "function", "emitKeypressEvents is exported");

  const { rl } = pair({ terminal: false });
  ok(rl instanceof Interface, "createInterface returns an Interface");
  eq(typeof rl.on, "function", "the interface is an EventEmitter");
  eq(typeof rl.question, "function", "question exists");
  eq(typeof rl.prompt, "function", "prompt exists");
  eq(typeof rl.setPrompt, "function", "setPrompt exists");
  eq(typeof rl.getPrompt, "function", "getPrompt exists");
  eq(typeof rl.write, "function", "write exists");
  eq(typeof rl.pause, "function", "pause exists");
  eq(typeof rl.resume, "function", "resume exists");
  eq(typeof rl.close, "function", "close exists");
  eq(typeof rl.getCursorPos, "function", "getCursorPos exists");
  eq(typeof rl[Symbol.asyncIterator], "function", "Symbol.asyncIterator exists");
  eq(rl.terminal, false, "terminal defaults to the output isTTY");
  eq(rl.historySize, 0, "a non-terminal interface keeps no history by default");
  deepEq(rl.history, [], "history starts empty");
  eq(rl.line, "", "line starts empty");
  eq(rl.cursor, undefined, "cursor is undefined off a terminal");
  eq(rl.getPrompt(), "> ", "the default prompt is '> '");
  rl.close();
});

test("positional createInterface and option defaults", () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const positional = createInterface(input, output, null, true);
  eq(positional.terminal, true, "the positional terminal argument wins");
  eq(positional.input, input, "input stream is kept");
  eq(positional.output, output, "output stream is kept");
  eq(positional.historySize, 30, "a terminal keeps 30 history entries by default");
  positional.close();

  const ttyPair = pair({ isTTY: true });
  eq(ttyPair.rl.terminal, true, "output.isTTY is the default terminal value");
  eq(ttyPair.rl.historySize, 30, "terminal default history size is 30");
  ttyPair.rl.close();

  const custom = pair({ prompt: "P> ", historySize: 4, removeHistoryDuplicates: true });
  eq(custom.rl.getPrompt(), "P> ", "prompt option is honoured");
  eq(custom.rl.historySize, 4, "historySize option is honoured");
  eq(custom.rl.removeHistoryDuplicates, true, "removeHistoryDuplicates option is honoured");
  custom.rl.close();
});

// ---------------------------------------------------------------------------
// Lines

test("chunks split into lines, CRLF across chunks, final line on end", () => {
  const { input, rl } = pair({ terminal: false, crlfDelay: 100 });
  const lines = [];
  let closed = false;
  rl.on("line", (line) => lines.push(line));
  rl.on("close", () => {
    closed = true;
  });
  input.feed("a\n");
  input.feed("b\r");
  input.feed("\nc");
  deepEq(lines, ["a", "b"], "a split CRLF is one line");
  input.end();
  deepEq(lines, ["a", "b", "c"], "the unterminated tail is flushed on end");
  eq(closed, true, "close follows the input end");
});

test("crlfDelay holds a trailing CR, then treats it as a newline", async () => {
  const { input, rl } = pair({ terminal: false, crlfDelay: 10 });
  const lines = [];
  rl.on("line", (line) => lines.push(line));
  input.feed("x\r");
  deepEq(lines, [], "a trailing CR is held for crlfDelay");
  await tick(40);
  deepEq(lines, ["x"], "after crlfDelay the CR is a line ending");
  input.feed("\ny\n");
  deepEq(lines, ["x", "", "y"], "a later LF is a second, empty line");
  rl.close();

  const zero = pair({ terminal: false, crlfDelay: 0 });
  const zeroLines = [];
  zero.rl.on("line", (line) => zeroLines.push(line));
  zero.input.feed("z\r");
  deepEq(zeroLines, ["z"], "crlfDelay 0 ends the line immediately");
  zero.rl.close();
});

test("empty lines and a lone CR produce lines", () => {
  const { input, rl } = pair({ terminal: false, crlfDelay: 0 });
  const lines = [];
  rl.on("line", (line) => lines.push(line));
  input.feed("\n\r\n");
  deepEq(lines, ["", ""], "empty lines are real lines");
  input.end("\r");
  deepEq(lines, ["", "", ""], "a trailing CR with no text is an empty line");
});

test("write takes the same line path as input", () => {
  const { output, rl } = pair({ terminal: false });
  const lines = [];
  rl.on("line", (line) => lines.push(line));
  rl.write("x\ny");
  deepEq(lines, ["x"], "a newline in write data ends a line");
  rl.write(" tail\n");
  deepEq(lines, ["x", "y tail"], "a partial write is continued by the next write");
  eq(output.data, "", "a non-terminal interface does not echo");
  rl.close();
});

// ---------------------------------------------------------------------------
// question

test("question writes the prompt once and restores it before the callback", () => {
  const { input, output, rl } = pair({ terminal: false, prompt: "P> " });
  const order = [];
  let answer;
  rl.on("line", () => order.push("line"));
  const returned = rl.question("Q? ", (value) => {
    answer = value;
    order.push("answer");
    eq(rl.getPrompt(), "P> ", "the previous prompt is restored before the callback");
  });
  eq(returned, undefined, "the callback form returns undefined");
  eq(output.data, "Q? ", "the query is written exactly once");
  input.feed("hello\n");
  eq(answer, "hello", "the callback receives the line");
  deepEq(order, ["answer"], "a question answer is not also a line event");
  eq(output.data, "Q? ", "no echo without a terminal");
  rl.close();
});

test("question resumes a paused interface", () => {
  const { input, rl } = pair({ terminal: false });
  rl.pause();
  eq(input.paused, true, "pause pauses the input");
  let resolved = false;
  rl.question("Q? ", () => {
    resolved = true;
  });
  eq(rl.paused, false, "question resumes the interface");
  eq(input.paused, false, "question resumes the input stream");
  input.feed("a\n");
  eq(resolved, true, "the answer still arrives");
  rl.close();
});

// ---------------------------------------------------------------------------
// Async iteration

test("async iterator yields lines and ends on close", async () => {
  const { input, rl } = pair({ terminal: false });
  const iterator = rl[Symbol.asyncIterator]();
  const first = iterator.next();
  input.feed("one\n");
  deepEq(await first, { value: "one", done: false }, "the first line is yielded");
  input.feed("two\n");
  deepEq(await iterator.next(), { value: "two", done: false }, "the second line is yielded");
  const pending = iterator.next();
  rl.close();
  deepEq(await pending, { value: undefined, done: true }, "close completes a pending next()");
  deepEq(await iterator.next(), { value: undefined, done: true }, "later next() stays done");
});

test("async iterator drains lines queued before close", async () => {
  const { input, rl } = pair({ terminal: false });
  input.feed("a\nb\n");
  input.end();
  const values = [];
  for await (const line of rl) values.push(line);
  deepEq(values, ["a", "b"], "queued lines are yielded before done");
});

// ---------------------------------------------------------------------------
// pause / resume

test("pause and resume stop and restart line delivery", () => {
  const { input, rl } = pair({ terminal: false });
  const lines = [];
  const events = [];
  rl.on("line", (line) => lines.push(line));
  rl.on("pause", () => events.push("pause"));
  rl.on("resume", () => events.push("resume"));
  input.feed("1\n");
  rl.pause();
  eq(rl.paused, true, "rl.paused is set");
  eq(input.paused, true, "the input stream is paused");
  input.feed("2\n");
  deepEq(lines, ["1"], "a paused interface delivers no line");
  eq(rl.pause(), rl, "pause is chainable");
  eq(events.length, 1, "a second pause emits nothing");
  eq(rl.resume(), rl, "resume is chainable");
  eq(rl.paused, false, "rl.paused is cleared");
  eq(input.paused, false, "the input stream is resumed");
  input.feed("3\n");
  deepEq(lines, ["1", "3"], "lines flow again after resume");
  deepEq(events, ["pause", "resume"], "pause and resume are emitted once each");
  rl.close();
});

// ---------------------------------------------------------------------------
// history

test("history dedupes and is capped at historySize", () => {
  const { input, rl } = pair({
    terminal: true,
    historySize: 2,
    removeHistoryDuplicates: true,
  });
  const snapshots = [];
  rl.on("line", () => snapshots.push(rl.history.slice()));
  input.feed("a\na\nb\na\n");
  deepEq(
    snapshots,
    [["a"], ["a"], ["b", "a"], ["a", "b"]],
    "newest-first history with duplicates moved to the front",
  );
  deepEq(rl.history, ["a", "b"], "history stays within historySize");
  rl.close();

  const keepDuplicates = pair({ terminal: true, historySize: 2 });
  keepDuplicates.rl.on("line", () => {});
  keepDuplicates.input.feed("a\na\nb\n");
  deepEq(keepDuplicates.rl.history, ["b", "a"], "duplicates are kept without the option");
  keepDuplicates.rl.close();
});

test("history is not recorded when historySize is 0", () => {
  const { input, rl } = pair({ terminal: false });
  rl.on("line", () => {});
  input.feed("a\n");
  deepEq(rl.history, [], "the default non-terminal interface keeps no history");
  rl.close();

  const explicit = pair({ terminal: false, historySize: 3 });
  explicit.rl.on("line", () => {});
  explicit.input.feed("a\nb\n");
  deepEq(explicit.rl.history, [], "history is terminal-only, as in Node");
  explicit.rl.close();
});

// ---------------------------------------------------------------------------
// close

test("close is idempotent and stops line delivery", () => {
  const { input, rl } = pair({ terminal: false });
  let closes = 0;
  const lines = [];
  rl.on("close", () => {
    closes += 1;
  });
  rl.on("line", (line) => lines.push(line));
  rl.close();
  eq(rl.closed, true, "closed is set");
  rl.close();
  eq(closes, 1, "the close event is emitted once");
  input.feed("late\n");
  deepEq(lines, [], "no line is delivered after close");
  throwsCode(() => rl.question("Q? ", () => {}), "ERR_USE_AFTER_CLOSE", "question after close throws");
});

// ---------------------------------------------------------------------------
// SIGINT

test("SIGINT is emitted for ^C only on a terminal interface and eats the byte", () => {
  const tty = pair({ terminal: true });
  const ttyEvents = [];
  const ttyLines = [];
  tty.rl.on("SIGINT", () => ttyEvents.push("SIGINT"));
  tty.rl.on("line", (line) => ttyLines.push(line));
  tty.input.feed("a\u0003b\n");
  deepEq(ttyEvents, ["SIGINT"], "a terminal interface emits SIGINT");
  deepEq(ttyLines, ["ab"], "the ^C byte is not part of the line");
  tty.rl.close();

  const pipe = pair({ terminal: false });
  const pipeEvents = [];
  const pipeLines = [];
  pipe.rl.on("SIGINT", () => pipeEvents.push("SIGINT"));
  pipe.rl.on("line", (line) => pipeLines.push(line));
  pipe.input.feed("a\u0003b\n");
  deepEq(pipeEvents, [], "a non-terminal interface does not synthesize SIGINT");
  deepEq(pipeLines, ["a\u0003b"], "a non-terminal interface keeps the byte");
  pipe.rl.close();
});

// ---------------------------------------------------------------------------
// Terminal echo and cursor position

test("terminal interfaces echo text and line endings", () => {
  const { input, output, rl } = pair({ terminal: true });
  rl.on("line", () => {});
  input.feed("ab");
  eq(rl.line, "ab", "the partial line is visible on a terminal");
  eq(rl.cursor, 2, "the cursor tracks the partial line");
  input.feed("\n");
  eq(output.data, "ab\r\n", "the terminal echo normalizes the line ending");
  eq(rl.line, "", "the line is cleared after it is delivered");
  rl.close();

  const { output: keyedOutput, rl: keyed } = pair({ terminal: true });
  const keyedLines = [];
  keyed.on("line", (line) => keyedLines.push(line));
  keyed.write("abc");
  eq(keyed.line, "abc", "write() edits the terminal line buffer");
  keyed.write(undefined, { name: "return" });
  deepEq(keyedLines, ["abc"], "a return key completes the line");
  eq(keyedOutput.data, "abc\r\n", "write() echoes through the terminal path");
  keyed.close();
});

test("getCursorPos counts the prompt and line against output.columns", () => {
  const { output, rl } = pair({ terminal: true, prompt: "abc> ", columns: 20 });
  eq(output.columns, 20, "the fake output reports columns");
  rl.write("0123456789012345");
  deepEq(rl.getCursorPos(), { rows: 1, cols: 1 }, "21 visible characters at 20 columns wrap");
  rl.close();

  const offTerminal = pair({ terminal: false });
  deepEq(offTerminal.rl.getCursorPos(), { rows: 0, cols: 2 }, "the default prompt is counted");
  offTerminal.rl.close();
});

// ---------------------------------------------------------------------------
// ANSI helpers

test("ANSI cursor helpers emit Node's byte sequences", async () => {
  const out = new FakeOutput();
  let callbacks = 0;
  cursorTo(out, 5);
  cursorTo(out, 5, 3, () => {
    callbacks += 1;
  });
  cursorTo(out, 0, 0);
  cursorTo(out, undefined, undefined, () => {
    callbacks += 1;
  });
  moveCursor(out, -2, 3);
  moveCursor(out, 0, 0);
  moveCursor(out, 0, -4);
  clearLine(out, 0);
  clearLine(out, -1);
  clearLine(out, 1);
  clearLine(out);
  clearScreenDown(out, () => {
    callbacks += 1;
  });
  eq(
    out.data,
    "\u001b[6G" +
      "\u001b[4;6H" +
      "\u001b[1;1H" +
      "\u001b[2D\u001b[3B" +
      "\u001b[4A" +
      "\u001b[2K\u001b[1K\u001b[0K\u001b[2K" +
      "\u001b[0J",
    "exact ANSI byte sequence",
  );
  await tick(20);
  eq(callbacks, 3, "every provided callback runs");
  throwsCode(
    () => cursorTo(out, undefined, 3),
    "ERR_INVALID_CURSOR_POS",
    "a row without a column is rejected",
  );
  throwsCode(() => cursorTo(null, 0), "ERR_INVALID_ARG_TYPE", "a non-writable stream is rejected");
});

// ---------------------------------------------------------------------------
// emitKeypressEvents

test("emitKeypressEvents decodes printable, control and CSI keys", () => {
  const input = new FakeInput();
  emitKeypressEvents(input);
  const seen = [];
  input.on("keypress", (character, key) => {
    seen.push([character === undefined ? null : character, key.name, key.ctrl, key.meta, key.sequence]);
  });
  input.feed("ab");
  input.feed("\u001b[A");
  input.feed("\u0003");
  input.feed("\r\n");
  deepEq(
    seen,
    [
      ["a", "a", false, false, "a"],
      ["b", "b", false, false, "b"],
      [null, "up", false, false, "\u001b[A"],
      ["\u0003", "c", true, false, "\u0003"],
      ["\r", "return", false, false, "\r"],
      ["\n", "enter", false, false, "\n"],
    ],
    "keys are decoded in order",
  );

  // Idempotent, and an escape sequence split across chunks is still one key.
  emitKeypressEvents(input);
  const split = [];
  input.on("keypress", (character, key) => split.push(key.name));
  input.feed("\u001b[");
  input.feed("B");
  deepEq(split, ["down"], "a split sequence is decoded once");
  input.end();
});

test("emitKeypressEvents reports modifiers and drops CSI modifier params from code", () => {
  const input = new FakeInput();
  emitKeypressEvents(input);
  const seen = [];
  input.on("keypress", (character, key) => {
    seen.push([
      character === undefined ? null : character,
      key.name,
      key.ctrl,
      key.alt === true || key.meta,
      key.code,
    ]);
  });
  input.feed("\u001b[1;5A");
  input.feed("\u001bx");
  deepEq(
    seen,
    [
      [null, "up", true, false, "[A"],
      [null, "x", false, true, undefined],
    ],
    "modifier flags are decoded and meta characters report no string argument",
  );
  input.end();
});

// ---------------------------------------------------------------------------
// readline/promises

test("readline/promises question returns a Promise", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const rl = readlinePromises.createInterface({
    input,
    output,
    terminal: false,
    prompt: "P> ",
  });
  ok(rl instanceof readlinePromises.Interface, "createInterface returns the promises Interface");
  ok(rl instanceof Interface, "the promises Interface extends the core Interface");
  const pending = rl.question("Q? ");
  eq(typeof pending.then, "function", "question returns a thenable");
  eq(output.data, "Q? ", "the query is written once");
  input.feed("answer\n");
  eq(await pending, "answer", "the Promise resolves with the line");
  eq(rl.getPrompt(), "P> ", "the prompt is restored");
  rl.close();
});

test("readline/promises rejects after close and on abort", async () => {
  const input = new FakeInput();
  const rl = readlinePromises.createInterface({
    input,
    output: new FakeOutput(),
    terminal: false,
  });
  rl.close();
  let closedError;
  try {
    await rl.question("Q? ");
  } catch (error) {
    closedError = error;
  }
  eq(closedError && closedError.code, "ERR_USE_AFTER_CLOSE", "a closed interface rejects");

  const abortInput = new FakeInput();
  const abortable = readlinePromises.createInterface({
    input: abortInput,
    output: new FakeOutput(),
    terminal: false,
    prompt: "P> ",
  });
  const controller = new AbortController();
  const aborted = abortable.question("Q? ", { signal: controller.signal });
  controller.abort();
  let abortError;
  try {
    await aborted;
  } catch (error) {
    abortError = error;
  }
  eq(abortError && abortError.name, "AbortError", "aborting rejects with AbortError");
  eq(abortError && abortError.code, "ABORT_ERR", "the rejection carries ABORT_ERR");
  eq(abortable.getPrompt(), "P> ", "the prompt is restored on abort");
  abortable.close();
});

test("readline/promises supports async iteration", async () => {
  const input = new FakeInput();
  const rl = readlinePromises.createInterface({
    input,
    output: new FakeOutput(),
    terminal: false,
  });
  input.feed("p\nq\n");
  const values = [];
  const iterator = rl[Symbol.asyncIterator]();
  values.push((await iterator.next()).value);
  values.push((await iterator.next()).value);
  rl.close();
  const done = await iterator.next();
  deepEq(values, ["p", "q"], "both lines are yielded");
  eq(done.done, true, "close ends the promises iterator");
});

// ---------------------------------------------------------------------------
// runner

async function run() {
  for (let index = 0; index < tests.length; index += 1) {
    const current = tests[index];
    try {
      await current.fn();
    } catch (error) {
      failed += 1;
      failures.push(`${current.name} threw: ${error && error.stack ? error.stack : error}`);
    }
  }

  if (failures.length > 0) {
    for (let index = 0; index < failures.length; index += 1) {
      console.log(`not ok - ${failures[index]}`);
    }
    console.log(`readline.test.js: ${passed} passed, ${failed} failed, ${tests.length} tests`);
    process.exitCode = 1;
  }
}

run().catch((error) => {
  try {
    process.stderr.write(
      `readline.test.js crashed: ${error && error.stack ? error.stack : error}\n`,
    );
  } catch (_) {
    // nothing else we can do
  }
  process.exitCode = 1;
});
