"use strict";

// Self-check for js/lib/tty.js and the real `process` stdio streams.
//
// Under Node there is no lite host, and `process.stdout` there is Node's own stream, so the
// checks that matter (host fds, lazy getters, `__ln_op` reads) are lite-only. The runner
// (`test/js/run.sh`) executes this file under both runtimes, so the skip must be exit 0.
//
// stdin is deliberately *not* read here: a test must not block on a terminal. The pipe check
// lives in the WP6 verification command (`printf 'x\n' | lite -e '...'`) and in `test/programs`.

if (typeof globalThis.__ln_host !== "object") {
  console.log("skip: lite host unavailable");
  process.exit(0);
}

const tty = require("../../../js/lib/tty.js");
const stream = require("stream");

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

function tick(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds === undefined ? 5 : milliseconds));
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Module shape

test("tty exports", () => {
  eq(typeof tty.isatty, "function", "isatty is a function");
  eq(typeof tty.WriteStream, "function", "WriteStream is a constructor");
  eq(typeof tty.ReadStream, "function", "ReadStream is a constructor");
  const names = Object.keys(tty).sort().join(",");
  eq(names, "ReadStream,WriteStream,isatty", "exports exactly the Node tty surface");
});

// ---------------------------------------------------------------------------
// isatty

test("isatty matches the host and rejects junk", () => {
  const host = globalThis.__ln_host;
  eq(tty.isatty(0), host.isTTY(0) === true, "isatty(0) matches host.isTTY(0)");
  eq(tty.isatty(1), host.isTTY(1) === true, "isatty(1) matches host.isTTY(1)");
  eq(tty.isatty(2), host.isTTY(2) === true, "isatty(2) matches host.isTTY(2)");
  eq(typeof tty.isatty(147), "boolean", "isatty(non-stdio fd) returns a boolean");
  eq(tty.isatty(147), false, "isatty(non-stdio fd) is false");
  for (const value of [-1, 1.5, "1", null, undefined, {}]) {
    eq(tty.isatty(value), false, `isatty(${String(value)}) is false`);
  }
});

// ---------------------------------------------------------------------------
// process.stdout / stderr

test("process.stdout is a real Writable on fd 1", () => {
  const stdout = process.stdout;
  ok(stdout instanceof stream.Writable, "process.stdout is a stream.Writable");
  eq(stdout.fd, 1, "process.stdout.fd is 1");
  eq(stdout.isTTY, tty.isatty(1), "process.stdout.isTTY agrees with isatty(1)");
  eq(stdout === process.stdout, true, "the lazy getter caches the stream");
  ok(stdout.writable, "process.stdout.writable is true");
  eq(stdout.write("tty-stdout-marker\n"), true, "write(string) returns true");
  eq(stdout.write(Buffer.from("tty-buffer-marker\n")), true, "write(Buffer) returns true");
  eq(stdout.write(new Uint8Array([65, 66, 10])), true, "write(Uint8Array) returns true");
});

test("process.stdout write callback runs asynchronously", async () => {
  let calls = 0;
  process.stdout.write("", () => {
    calls += 1;
  });
  eq(calls, 0, "write callback is not called synchronously");
  await tick();
  eq(calls, 1, "write callback runs on a later tick");
});

test("process.stderr is a real Writable on fd 2", () => {
  const stderr = process.stderr;
  ok(stderr instanceof stream.Writable, "process.stderr is a stream.Writable");
  eq(stderr.fd, 2, "process.stderr.fd is 2");
  eq(stderr.isTTY, tty.isatty(2), "process.stderr.isTTY agrees with isatty(2)");
  eq(stderr.write(""), true, "an empty write succeeds without emitting bytes");
});

test("process.stdio are lazy own getters", () => {
  for (const name of ["stdin", "stdout", "stderr"]) {
    const descriptor = Object.getOwnPropertyDescriptor(process, name);
    ok(descriptor !== undefined, `${name} is an own property`);
    eq(typeof descriptor.get, "function", `${name} has a getter`);
    eq(descriptor.enumerable, true, `${name} is enumerable`);
  }
  eq(process.stdin, process.stdin, "process.stdin is cached");
});

// ---------------------------------------------------------------------------
// tty.WriteStream

test("WriteStream basics", () => {
  const ws = new tty.WriteStream(1);
  ok(ws instanceof stream.Writable, "WriteStream extends Writable");
  eq(ws.fd, 1, "fd is stored");
  eq(ws.isTTY, tty.isatty(1), "isTTY agrees with isatty");
  const depth = ws.getColorDepth();
  ok(
    depth === 1 || depth === 4 || depth === 8 || depth === 24,
    `getColorDepth() is 1/4/8/24 (${depth})`,
  );
  eq(typeof ws.hasColors(), "boolean", "hasColors() returns a boolean");
  eq(ws.hasColors(2), true, "hasColors(2) is true for any terminal");
  eq(ws.getColorDepth({ TERM: "xterm-256color" }), 8, "COLORTERM/TERM heuristic reports 256 colors");
  eq(ws.getColorDepth({ TERM: "dumb" }), 1, "TERM=dumb reports no color");
  eq(ws.getColorDepth({ COLORTERM: "truecolor" }), 24, "COLORTERM=truecolor reports 24-bit");
  ok(Array.isArray(ws.getWindowSize()), "getWindowSize() is an array");
  if (ws.isTTY) {
    eq(typeof ws.columns, "number", "a terminal stream has numeric columns");
    eq(typeof ws.rows, "number", "a terminal stream has numeric rows");
  } else {
    eq(ws.columns, undefined, "a non-terminal stream has no columns");
    eq(ws.rows, undefined, "a non-terminal stream has no rows");
  }
});

test("WriteStream end() flushes", async () => {
  const ws = new tty.WriteStream(1);
  const returned = ws.end("tty-end-marker\n");
  eq(returned, ws, "end() returns the stream");
  await tick();
  eq(ws.writableEnded, true, "writableEnded after end()");
  eq(ws.writableFinished, true, "writableFinished after end()");
});

test("WriteStream validates fd", () => {
  for (const value of [undefined, null, "1", -1, 1.5, 999]) {
    let caught;
    try {
      new tty.WriteStream(value);
    } catch (error) {
      caught = error;
    }
    ok(caught !== undefined, `new WriteStream(${String(value)}) throws`);
    eq(caught.name, "RangeError", "invalid fd is a RangeError");
    eq(caught.code, "ERR_INVALID_FD", "invalid fd carries ERR_INVALID_FD");
  }
});

// ---------------------------------------------------------------------------
// tty.ReadStream + process.stdin

test("ReadStream basics", () => {
  const rs = new tty.ReadStream(0);
  ok(rs instanceof stream.Readable, "ReadStream extends Readable");
  eq(rs.fd, 0, "fd is stored");
  eq(rs.isTTY, tty.isatty(0), "isTTY agrees with isatty");
  eq(typeof rs.pause, "function", "pause exists");
  eq(typeof rs.resume, "function", "resume exists");
  eq(typeof rs.setEncoding, "function", "setEncoding exists");
  eq(rs.isRaw, false, "isRaw starts false");
  eq(rs.pause(), rs, "pause() returns the stream");
  if (!rs.isTTY) {
    let caught;
    try {
      rs.setRawMode(true);
    } catch (error) {
      caught = error;
    }
    eq(caught && caught.code, "ERR_TTY_SET_RAW_MODE", "setRawMode throws on a non-TTY");
  }
});

test("process.stdin is a real Readable on fd 0", () => {
  const stdin = process.stdin;
  ok(stdin instanceof stream.Readable, "process.stdin is a stream.Readable");
  eq(stdin.fd, 0, "process.stdin.fd is 0");
  eq(stdin.isTTY, tty.isatty(0), "process.stdin.isTTY agrees with isatty(0)");
  eq(typeof stdin.resume, "function", "resume exists");
  eq(typeof stdin.pause, "function", "pause exists");
  eq(typeof stdin.setEncoding, "function", "setEncoding exists");
});

// ---------------------------------------------------------------------------
// process surface preserved

test("the rest of process is unchanged", () => {
  ok(Array.isArray(process.argv), "process.argv is still an array");
  eq(typeof process.cwd(), "string", "process.cwd() still works");
  eq(typeof process.hrtime.bigint(), "bigint", "process.hrtime.bigint() still works");
  eq(typeof process.memoryUsage().heapUsed, "number", "process.memoryUsage() still works");
  eq(process.exitCode, undefined, "process.exitCode starts undefined");
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
    for (let index = 0; index < failures.length; index += 1) console.log(`not ok - ${failures[index]}`);
  }
  console.log(`tty.test.js: ${passed} passed, ${failed} failed, ${tests.length} tests`);

  if (failed > 0) process.exitCode = 1;
}

run().catch((error) => {
  try {
    process.stderr.write(`tty.test.js crashed: ${error && error.stack ? error.stack : error}\n`);
  } catch (_) {
    // nothing else we can do
  }
  process.exitCode = 1;
});
