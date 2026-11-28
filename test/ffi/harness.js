"use strict";

// A tiny test harness for the FFI matrix.
//
// The suite runs under `onde` only (there is no Node equivalent of `onde:ffi`), so it does not use
// `node:test`; a test is a named function that throws on failure. Each file prints a summary and
// sets the exit code, which is what `run.sh` checks.

// The C library's name differs on the two supported platforms. Tests use this instead of
// hardcoding the macOS spelling.
const LIBC = process.platform === "darwin" ? "libc.dylib" : "libc.so.6";

const cases = [];

function test(name, fn) {
  cases.push({ name, fn });
}

function run() {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of cases) {
    try {
      const result = fn();
      if (result !== undefined) throw new Error(`test returned a value: ${String(result)}`);
      passed += 1;
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${name}`);
      if (error && error.message !== undefined) {
        console.error(`     ${error.name || "Error"}: ${error.message}`);
      }
      const stack = error && error.stack ? String(error.stack) : String(error);
      console.error(stack.replace(/^/gm, "     "));
    }
  }
  console.log(`${passed} passed, ${failed} failed`);
  if (failed !== 0) process.exit(1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
}

function equal(actual, expected, message) {
  const a = render(actual);
  const b = render(expected);
  if (a !== b) {
    throw new Error(`${message || "not equal"}: got ${a}, expected ${b}`);
  }
}

function throwsCode(fn, code, message) {
  try {
    fn();
  } catch (error) {
    if (error.code !== code) {
      throw new Error(
        `${message || "wrong error"}: got ${error.code} (${error.message}), expected ${code}`,
      );
    }
    return error;
  }
  throw new Error(`${message || "expected a throw"}: expected ${code}, nothing was thrown`);
}

function render(value) {
  if (typeof value === "bigint") return `${value}n`;
  if (value instanceof Error) return `${value.code}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

module.exports = { test, run, assert, equal, throwsCode, render, LIBC };
