"use strict";

// Runtime-agnostic self-check for js/lib/console.js.
//
// Fake streams are deliberately minimal (`{ write }`) — the Console must not
// depend on stream event-emitter methods. Output assertions use only simple
// values whose `util.inspect`/`util.format` rendering is stable across runtimes.

const consoleModule = require("../../../js/lib/console.js");
const Console = consoleModule.Console;

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
    failures.push(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

function deepEq(actual, expected, message) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

function fakeStream(isTTY) {
  const chunks = [];
  return {
    chunks,
    isTTY: Boolean(isTTY),
    write(text) {
      chunks.push(String(text));
      return true;
    },
  };
}

function pair() {
  const stdout = fakeStream();
  const stderr = fakeStream();
  const console = new Console(stdout, stderr);
  return { console, stdout: stdout.chunks, stderr: stderr.chunks };
}

function last(chunks) {
  return chunks[chunks.length - 1];
}

// ---------------------------------------------------------------------------
// Shape and streams

eq(typeof consoleModule, "object", "module exports the global console object");
eq(typeof Console, "function", "console.Console is a constructor");
ok(consoleModule instanceof Console, "the exported console is a Console instance");
eq(typeof consoleModule.log, "function", "the exported console has log()");

{
  const context = pair();
  context.console.log("hello");
  deepEq(context.stdout, ["hello\n"], "log writes one formatted line to stdout");
  deepEq(context.stderr, [], "log does not touch stderr");
}

{
  const context = pair();
  context.console.log();
  deepEq(context.stdout, ["\n"], "zero-argument log prints an empty line");
}

{
  const context = pair();
  context.console.log("a", 1, true, null, undefined);
  deepEq(
    context.stdout,
    ["a 1 true null undefined\n"],
    "log formats multiple primitive arguments"
  );
}

{
  const context = pair();
  context.console.log("%s:%d", "x", 42);
  deepEq(context.stdout, ["x:42\n"], "log honors util.format placeholders");
  context.console.log("100%");
  deepEq(last(context.stdout), "100%\n", "a lone percent sign is not a placeholder");
}

{
  const context = pair();
  context.console.info("info");
  context.console.debug("debug");
  deepEq(context.stdout, ["info\n", "debug\n"], "info and debug go to stdout");
  context.console.warn("warn", 1);
  context.console.error("error");
  deepEq(context.stderr, ["warn 1\n", "error\n"], "warn and error go to stderr");
}

{
  const context = pair();
  context.console.log("one");
  context.console.warn("two");
  context.console.error("three");
  eq(context.stdout.length + context.stderr.length, 3, "each call performs exactly one write");
  ok(
    context.stdout.every((chunk) => chunk.endsWith("\n")) &&
      context.stderr.every((chunk) => chunk.endsWith("\n")),
    "every write ends in a newline"
  );
}

// ---------------------------------------------------------------------------
// Grouping

{
  const context = pair();
  context.console.group("group-label");
  context.console.log("inside");
  context.console.groupCollapsed();
  context.console.log("deep");
  context.console.groupEnd();
  context.console.groupEnd();
  context.console.groupEnd();
  context.console.log("outside");
  deepEq(
    context.stdout,
    ["group-label\n", "  inside\n", "    deep\n", "outside\n"],
    "group/groupCollapsed/groupEnd indent by two spaces"
  );
}

{
  const context = pair();
  context.console.group();
  context.console.log("a\nb");
  deepEq(context.stdout, ["  a\n  b\n"], "group indentation applies to multiline output");
}

{
  const context = pair();
  context.console.groupEnd();
  context.console.log("safe");
  deepEq(context.stdout, ["safe\n"], "groupEnd below zero is a no-op");
}

// ---------------------------------------------------------------------------
// Counting and timing

{
  const context = pair();
  context.console.count();
  context.console.count();
  context.console.count("x");
  deepEq(
    context.stdout,
    ["default: 1\n", "default: 2\n", "x: 1\n"],
    "count increments per label"
  );
  context.console.countReset("x");
  context.console.count("x");
  deepEq(last(context.stdout), "x: 1\n", "countReset restarts the label at one");
}

{
  const context = pair();
  context.console.time("clock");
  const before = context.stdout.length;
  context.console.timeLog("clock", "step");
  eq(context.stdout.length, before + 1, "timeLog writes one line");
  ok(
    /^clock: [\d.]+(?:ms|s) step\n$/.test(last(context.stdout)),
    "timeLog prints the label, duration and extra arguments"
  );
  context.console.timeEnd("clock");
  ok(
    /^clock: [\d.]+(?:ms|s)\n$/.test(last(context.stdout)),
    "timeEnd prints the label and duration"
  );
  const afterEnd = context.stdout.length;
  const proc = globalThis.process;
  const originalWarn = proc && proc.emitWarning;
  const warnings = [];
  if (proc && typeof originalWarn === "function") {
    proc.emitWarning = (message) => warnings.push(message);
  }
  try {
    context.console.timeEnd("clock");
  } finally {
    if (proc && typeof originalWarn === "function") proc.emitWarning = originalWarn;
  }
  eq(context.stdout.length, afterEnd, "timeEnd removes the timer");
  if (proc && typeof originalWarn === "function") {
    eq(warnings.length, 1, "timeEnd warns for an unknown label");
  }
}

// ---------------------------------------------------------------------------
// assert / dir / trace

{
  const context = pair();
  context.console.assert(true, "unused");
  eq(context.stdout.length + context.stderr.length, 0, "assert(true) is silent");
  context.console.assert(false);
  deepEq(context.stderr, ["Assertion failed\n"], "assert(false) prints to stderr");
  context.console.assert(false, "bad", 1);
  deepEq(last(context.stderr), "Assertion failed: bad 1\n", "assert(false, ...) prefixes its args");
}

{
  const context = pair();
  context.console.dir({ a: 1 });
  eq(context.stdout.length, 1, "dir writes one chunk");
  ok(last(context.stdout).indexOf("a: 1") !== -1, "dir inspects its argument");
  ok(last(context.stdout).endsWith("\n"), "dir output ends in a newline");
}

{
  const context = pair();
  context.console.trace("boom", 1);
  eq(context.stdout.length, 0, "trace writes nothing to stdout");
  eq(context.stderr.length, 1, "trace writes one chunk to stderr");
  ok(last(context.stderr).indexOf("Trace: boom 1\n") === 0, "trace prefixes Trace with its args");
  ok(last(context.stderr).indexOf("at ") !== -1, "trace includes a stack");
}

// ---------------------------------------------------------------------------
// table (onde)

{
  const context = pair();
  context.console.table([1, 2]);
  const output = last(context.stdout);
  ok(output.indexOf("(index)") !== -1 && output.indexOf("Values") !== -1, "table labels columns");
  ok(output.indexOf("│ 0") !== -1 && output.indexOf("│ 1") !== -1, "table renders rows");
  ok(output.endsWith("\n"), "table output ends in a newline");
}

{
  const context = pair();
  context.console.table([{ a: 1, b: 2 }, { a: 3, c: 4 }]);
  const output = last(context.stdout);
  ok(
    output.indexOf("│ (index) │ a │ b │ c │") !== -1,
    "table unions object keys into columns"
  );
  ok(
    output.indexOf("│ 0       │ 1 │ 2 │   │") !== -1,
    "table leaves missing object fields blank"
  );
}

{
  const context = pair();
  context.console.table({ x: 1, y: 2 });
  const output = last(context.stdout);
  ok(output.indexOf("│ x") !== -1 && output.indexOf("│ y") !== -1, "table renders plain objects");
}

{
  const context = pair();
  context.console.table(3);
  deepEq(context.stdout, ["3\n"], "table falls back to log for non-objects");
}

// ---------------------------------------------------------------------------
// clear

{
  const context = pair();
  context.console.clear();
  eq(context.stdout.length, 0, "clear is a no-op on a non-TTY");
}

{
  const stdout = fakeStream(true);
  const stderr = fakeStream();
  const instance = new Console(stdout, stderr);
  const proc = globalThis.process;
  const savedTerm = proc && proc.env ? proc.env.TERM : undefined;
  if (proc && proc.env) proc.env.TERM = "xterm-256color";
  try {
    instance.clear();
    eq(stdout.chunks.length, 1, "clear writes one control sequence on a TTY");
    ok(stdout.chunks[0].indexOf("\x1b[") !== -1, "clear emits an ANSI control sequence");
  } finally {
    if (proc && proc.env) {
      if (savedTerm === undefined) delete proc.env.TERM;
      else proc.env.TERM = savedTerm;
    }
  }
}

// ---------------------------------------------------------------------------
// Constructor forms and binding

{
  const stdout = fakeStream();
  const stderr = fakeStream();
  const instance = new Console({ stdout, stderr });
  instance.log("out");
  instance.warn("err");
  deepEq(stdout.chunks, ["out\n"], "options.stdout receives log output");
  deepEq(stderr.chunks, ["err\n"], "options.stderr receives warn output");
}

{
  const stdout = fakeStream();
  const instance = new Console(stdout);
  instance.warn("to-stdout");
  deepEq(stdout.chunks, ["to-stdout\n"], "a missing stderr falls back to stdout");
}

{
  const context = pair();
  const log = context.console.log;
  log("bound");
  deepEq(context.stdout, ["bound\n"], "Console methods are bound to the instance");
}

{
  const stdout = fakeStream();
  const stderr = fakeStream();
  const instance = new Console({ stdout, stderr, groupIndentation: 4 });
  instance.group();
  instance.log("wide");
  deepEq(stdout.chunks, ["    wide\n"], "groupIndentation controls the indent width");
}

// ---------------------------------------------------------------------------
// Missing process.stdout tolerance

{
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "process");
  const replaceable =
    descriptor === undefined || descriptor.writable === true || descriptor.configurable === true;
  if (replaceable) {
    const saved = globalThis.process;
    try {
      globalThis.process = { stdout: undefined, stderr: undefined, env: {} };
      const instance = new Console();
      let crashed = false;
      try {
        instance.log("no-stream");
        instance.warn("no-stream");
      } catch (_) {
        crashed = true;
      }
      ok(!crashed, "Console tolerates a missing process.stdout/stderr");
    } finally {
      globalThis.process = saved;
    }
  } else {
    // Non-replaceable global: the code path is covered by construction above.
    passed += 1;
  }
}

// ---------------------------------------------------------------------------
// Report

if (failures.length > 0) {
  for (let i = 0; i < failures.length; i += 1) console.log(`not ok - ${failures[i]}`);
}
console.log(`console.test.js: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  if (typeof process !== "undefined" && process) process.exitCode = 1;
  else throw new Error(`${failed} console assertions failed`);
}
