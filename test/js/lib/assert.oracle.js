"use strict";

// Node-only differential oracle for js/lib/assert.js.
//
// For every case it runs both node:assert and our assert, then compares:
//   - whether an error was thrown / promise rejected,
//   - AssertionError name/code/operator/actual/expected/generatedMessage,
//   - the message for cases where onde reproduces Node's text exactly.
//
// TODO (docs/compat.md): structured diff bodies are simpler than Node's Myers
// diff for object/array/Map/Set/typed-array/Error mismatches.  The header,
// operator and fields match; only the diff body differs, so those messages are
// excluded from the comparison below.  `assert.ok()`'s generated message
// includes the caller's source expression, which we cannot recover in onde.

const nodeAssert = require("node:assert");
const nodeUtil = require("node:util");
const ourAssert = require("../../../js/lib/assert.js");

let mismatches = 0;

function describe(value) {
  try {
    return nodeUtil.inspect(value, { depth: 3, breakLength: Infinity, compact: true });
  } catch {
    return String(value);
  }
}

function report(label, detail, expected, actual) {
  mismatches++;
  console.log(`MISMATCH ${label}${detail ? " (" + detail + ")" : ""}`);
  console.log("  node:     " + describe(expected));
  console.log("  ours:     " + describe(actual));
}

async function snapshot(fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      await result;
    }
    return { threw: false };
  } catch (error) {
    return { threw: true, error };
  }
}

function normalize(value) {
  if (typeof value === "function") {
    return "fn:" + (value.name || "anonymous");
  }
  if (value instanceof RegExp) {
    return "re:" + value.source + "/" + value.flags;
  }
  if (value instanceof Error) {
    return { error: value.name, message: value.message };
  }
  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value) &&
      !(value instanceof DataView)) {
    const data = [];
    for (let i = 0; i < value.length; i++) {
      data.push(typeof value[i] === "bigint" ? value[i] + "n" : value[i]);
    }
    return { typed: value.constructor.name, data };
  }
  if (value instanceof Map) {
    return {
      map: Array.from(value.entries()).map(([key, item]) => [
        normalize(key),
        normalize(item),
      ]),
    };
  }
  if (value instanceof Set) {
    return { set: Array.from(value).map(normalize) };
  }
  if (value instanceof Date) {
    return "date:" + (Number.isNaN(value.getTime()) ? "NaN" : String(value.getTime()));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) out[key] = normalize(value[key]);
    return out;
  }
  return value;
}

function fields(error) {
  return {
    name: error && error.name,
    code: error && error.code,
    operator: error && error.operator,
    actual: normalize(error && error.actual),
    expected: normalize(error && error.expected),
    generatedMessage: error && error.generatedMessage,
    message: error && error.message,
    isAssertionError: error instanceof nodeAssert.AssertionError,
  };
}

const messageSkip = new Set([
  // Node's source expression is not available to our generated ok() message.
  "ok false",
  "ok false with message",
  "ok false with null message",
  "ok without args",
  "assert false",
  "strict false",
  "strict ok false",
  // Structured diff bodies (header/fields still compared).
  "deepStrictEqual object",
  "deepStrictEqual array",
  "deepStrictEqual map",
  "deepStrictEqual set",
  "deepStrictEqual typed arrays",
  "deepStrictEqual errors",
  "deepStrictEqual null prototype",
  "deepStrictEqual custom object",
  "deepStrictEqual -0",
  "strictEqual objects",
  "equal objects",
  "strict.equal deep",
  "strict.deepEqual",
  "throws validation object",
  "throws validation object mismatch",
  "throws error validation object",
]);

const cases = [
  ["ok true", (assertModule) => assertModule(true)],
  ["ok truthy", (assertModule) => assertModule.ok(1)],
  ["ok false", (assertModule) => assertModule(false)],
  ["ok false with message", (assertModule) => assertModule(false, "custom")],
  ["ok false with null message", (assertModule) => assertModule(false, null)],
  ["ok without args", (assertModule) => assertModule.ok()],
  ["assert false", (assertModule) => assertModule(false)],
  ["strict false", (assertModule) => assertModule.strict(false)],
  ["strict ok false", (assertModule) => assertModule.strict(false, "msg")],

  ["equal pass", (assertModule) => assertModule.equal(1, "1")],
  ["equal NaN pass", (assertModule) => assertModule.equal(NaN, NaN)],
  ["equal null pass", (assertModule) => assertModule.equal(null, undefined)],
  ["equal fail", (assertModule) => assertModule.equal(1, 2)],
  ["equal objects", (assertModule) => assertModule.equal({ a: 1 }, [1])],

  ["notEqual pass", (assertModule) => assertModule.notEqual(1, 2)],
  ["notEqual fail", (assertModule) => assertModule.notEqual(1, "1")],
  ["notEqual NaN fail", (assertModule) => assertModule.notEqual(NaN, NaN)],

  ["strictEqual pass", (assertModule) => assertModule.strictEqual(1, 1)],
  ["strictEqual NaN pass", (assertModule) => assertModule.strictEqual(NaN, NaN)],
  ["strictEqual fail", (assertModule) => assertModule.strictEqual(1, 2)],
  ["strictEqual -0", (assertModule) => assertModule.strictEqual(0, -0)],
  ["strictEqual objects", (assertModule) => assertModule.strictEqual({ a: 1 }, { a: 1 })],

  ["notStrictEqual pass", (assertModule) => assertModule.notStrictEqual(1, "1")],
  ["notStrictEqual fail", (assertModule) => assertModule.notStrictEqual(1, 1)],
  ["notStrictEqual objects", (assertModule) => assertModule.notStrictEqual({ a: 1 }, { a: 1 })],

  ["deepEqual pass", (assertModule) => assertModule.deepEqual({ a: 1 }, { a: "1" })],
  ["deepEqual arrays", (assertModule) => assertModule.deepEqual([1, 2], ["1", "2"])],
  ["deepEqual prototype", (assertModule) => assertModule.deepEqual(Object.create({ x: 1 }), {})],
  ["deepEqual fail", (assertModule) => assertModule.deepEqual({ a: 1 }, { a: 2 })],

  ["notDeepEqual pass", (assertModule) => assertModule.notDeepEqual({ a: 1 }, { a: 2 })],
  ["notDeepEqual fail", (assertModule) => assertModule.notDeepEqual({ a: 1 }, { a: "1" })],

  ["deepStrictEqual pass", (assertModule) => assertModule.deepStrictEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })],
  ["deepStrictEqual Map pass", (assertModule) => assertModule.deepStrictEqual(new Map([[1, { a: 2 }]]), new Map([[1, { a: 2 }]]))],
  ["deepStrictEqual Set pass", (assertModule) => assertModule.deepStrictEqual(new Set([1, 2]), new Set([2, 1]))],
  ["deepStrictEqual typed pass", (assertModule) => assertModule.deepStrictEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))],
  ["deepStrictEqual date pass", (assertModule) => assertModule.deepStrictEqual(new Date(NaN), new Date(NaN))],
  ["deepStrictEqual regexp pass", (assertModule) => assertModule.deepStrictEqual(/a/g, /a/g)],
  ["deepStrictEqual cycles pass", (assertModule) => {
    const left = {};
    left.self = left;
    const right = {};
    right.self = right;
    return assertModule.deepStrictEqual(left, right);
  }],
  ["deepStrictEqual -0 fail", (assertModule) => assertModule.deepStrictEqual(-0, 0)],
  ["deepStrictEqual object", (assertModule) => assertModule.deepStrictEqual({ a: 1 }, { a: 2 })],
  ["deepStrictEqual array", (assertModule) => assertModule.deepStrictEqual([1], [2])],
  ["deepStrictEqual scalar", (assertModule) => assertModule.deepStrictEqual(1, 2)],
  ["deepStrictEqual map", (assertModule) => assertModule.deepStrictEqual(new Map([[1, 2]]), new Map([[1, 3]]))],
  ["deepStrictEqual set", (assertModule) => assertModule.deepStrictEqual(new Set([1]), new Set([2]))],
  ["deepStrictEqual typed arrays", (assertModule) => assertModule.deepStrictEqual(new Uint8Array([1]), new Int8Array([1]))],
  ["deepStrictEqual errors", (assertModule) => assertModule.deepStrictEqual(new TypeError("x"), new Error("x"))],
  ["deepStrictEqual null prototype", (assertModule) => assertModule.deepStrictEqual(Object.assign(Object.create(null), { a: 1 }), { a: 1 })],
  ["deepStrictEqual custom object", (assertModule) => assertModule.deepStrictEqual(1, 2, "nope")],
  ["deepStrictEqual message function", (assertModule) => assertModule.deepStrictEqual(1, 2, (left, right) => `got ${left} want ${right}`)],

  ["notDeepStrictEqual pass", (assertModule) => assertModule.notDeepStrictEqual({ a: 1 }, { a: 2 })],
  ["notDeepStrictEqual fail", (assertModule) => assertModule.notDeepStrictEqual({ a: 1 }, { a: 1 })],

  ["fail", (assertModule) => assertModule.fail("boom")],
  ["fail without message", (assertModule) => assertModule.fail()],
  ["fail number", (assertModule) => assertModule.fail(42)],
  ["fail Error pass-through", (assertModule) => assertModule.fail(new TypeError("orig"))],

  ["ifError null", (assertModule) => assertModule.ifError(null)],
  ["ifError undefined", (assertModule) => assertModule.ifError(undefined)],
  ["ifError error", (assertModule) => assertModule.ifError(new Error("io"))],
  ["ifError string", (assertModule) => assertModule.ifError("str")],
  ["ifError number", (assertModule) => assertModule.ifError(1)],

  ["match pass", (assertModule) => assertModule.match("abc", /b/)],
  ["match fail", (assertModule) => assertModule.match("abc", /z/)],
  ["match invalid regexp", (assertModule) => assertModule.match("abc", "b")],
  ["match non-string", (assertModule) => assertModule.match(5, /5/)],
  ["match custom message", (assertModule) => assertModule.match("abc", /z/, "custom")],

  ["doesNotMatch pass", (assertModule) => assertModule.doesNotMatch("abc", /z/)],
  ["doesNotMatch fail", (assertModule) => assertModule.doesNotMatch("abc", /b/)],
  ["doesNotMatch non-string", (assertModule) => assertModule.doesNotMatch(5, /5/)],

  ["throws pass", (assertModule) => assertModule.throws(() => { throw new Error("x"); })],
  ["throws constructor pass", (assertModule) => assertModule.throws(() => { throw new TypeError("x"); }, TypeError)],
  ["throws regexp pass", (assertModule) => assertModule.throws(() => { throw new Error("boom"); }, /boo/)],
  ["throws regexp non-error", (assertModule) => assertModule.throws(() => { throw "str"; }, /str/)],
  ["throws validation function pass", (assertModule) => assertModule.throws(() => { throw new Error("x"); }, (error) => error.message === "x")],
  ["throws validation object", (assertModule) => assertModule.throws(() => { const error = new Error("x"); error.code = "E"; throw error; }, { code: "E" })],
  ["throws regexp property", (assertModule) => assertModule.throws(() => { const error = new Error("boom"); throw error; }, { message: /boo/ })],
  ["throws error validation object", (assertModule) => assertModule.throws(() => { throw new Error("x"); }, new Error("x"))],
  ["throws custom message", (assertModule) => assertModule.throws(() => { throw new Error("x"); }, TypeError, "custom")],
  ["throws message only", (assertModule) => assertModule.throws(() => { throw new Error("x"); }, "custom message")],
  ["throws constructor mismatch", (assertModule) => assertModule.throws(() => { throw new Error("x"); }, TypeError)],
  ["throws regexp mismatch", (assertModule) => assertModule.throws(() => { throw new Error("x"); }, /y/)],
  ["throws validation object mismatch", (assertModule) => assertModule.throws(() => { throw new Error("x"); }, { code: "E" })],
  ["throws validation function mismatch", (assertModule) => assertModule.throws(() => { throw new Error("x"); }, () => true)],
  ["throws missing exception", (assertModule) => assertModule.throws(() => {})],
  ["throws missing exception message", (assertModule) => assertModule.throws(() => {}, "m")],
  ["throws missing constructor message", (assertModule) => assertModule.throws(() => {}, TypeError, "custom")],
  ["throws non-function", (assertModule) => assertModule.throws(1)],
  ["throws primitive with object expectation", (assertModule) => assertModule.throws(() => { throw 5; }, { name: "Error" })],
  ["throws empty validation object", (assertModule) => assertModule.throws(() => { throw new Error("x"); }, {})],
  ["throws invalid error argument", (assertModule) => assertModule.throws(() => {}, 5)],
  ["throws ambiguous message", (assertModule) => {
    const error = new Error("same");
    return assertModule.throws(() => { throw error; }, "same");
  }],

  ["doesNotThrow pass", (assertModule) => assertModule.doesNotThrow(() => 5)],
  ["doesNotThrow matching expected", (assertModule) => assertModule.doesNotThrow(() => { throw new TypeError("d"); }, TypeError)],
  ["doesNotThrow custom message", (assertModule) => assertModule.doesNotThrow(() => { throw new Error("d"); }, "custom")],
  ["doesNotThrow regexp", (assertModule) => assertModule.doesNotThrow(() => { throw new Error("boom"); }, /boom/)],
  ["doesNotThrow validation function", (assertModule) => assertModule.doesNotThrow(() => { throw new Error("boom"); }, (error) => error.message === "boom")],
  ["doesNotThrow invalid expected", (assertModule) => assertModule.doesNotThrow(() => { throw new Error("boom"); }, 5)],

  ["rejects pass", (assertModule) => assertModule.rejects(Promise.reject(new Error("r")))],
  ["rejects function pass", (assertModule) => assertModule.rejects(async () => { throw new Error("r"); })],
  ["rejects constructor pass", (assertModule) => assertModule.rejects(Promise.reject(new TypeError("r")), TypeError)],
  ["rejects resolve", (assertModule) => assertModule.rejects(Promise.resolve(1))],
  ["rejects constructor mismatch", (assertModule) => assertModule.rejects(Promise.reject(new Error("r")), TypeError)],
  ["rejects non-promise return", (assertModule) => assertModule.rejects(() => 5)],
  ["rejects invalid argument", (assertModule) => assertModule.rejects(5)],
  ["rejects sync throw", (assertModule) => assertModule.rejects(() => { throw new Error("sync"); })],
  ["rejects custom message", (assertModule) => assertModule.rejects(Promise.reject(new Error("r")), "custom")],
  ["rejects validation function", (assertModule) => assertModule.rejects(Promise.reject(new Error("r")), (error) => error.message === "r")],
  ["doesNotReject pass", (assertModule) => assertModule.doesNotReject(Promise.resolve(1))],
  ["doesNotReject fail", (assertModule) => assertModule.doesNotReject(Promise.reject(new Error("z")))],
  ["doesNotReject non-promise", (assertModule) => assertModule.doesNotReject(() => 5)],

  ["strictEqual missing arguments", (assertModule) => assertModule.strictEqual(1)],
  ["deepStrictEqual missing arguments", (assertModule) => assertModule.deepStrictEqual()],
  ["ok invalid message", (assertModule) => assertModule.ok(false, 5)],
];

async function main() {
  for (const [label, fn] of cases) {
    const expected = await snapshot(() => fn(nodeAssert));
    const actual = await snapshot(() => fn(ourAssert));
    if (expected.threw !== actual.threw) {
      report(
        "decision",
        label,
        expected.threw ? expected.error : "no throw",
        actual.threw ? actual.error : "no throw",
      );
      continue;
    }
    if (!expected.threw) continue;

    const expectedFields = fields(expected.error);
    const actualFields = fields(actual.error);
    for (const key of [
      "name",
      "code",
      "operator",
      "actual",
      "expected",
      "generatedMessage",
    ]) {
      if (
        !nodeUtil.isDeepStrictEqual(expectedFields[key], actualFields[key])
      ) {
        report("field " + key, label, expectedFields[key], actualFields[key]);
      }
    }
    if (
      !messageSkip.has(label) &&
      expectedFields.message !== actualFields.message
    ) {
      report("message", label, expectedFields.message, actualFields.message);
    }
  }

  // Namespace wiring.
  const namespaceChecks = [
    ["strict.equal === strict.strictEqual", nodeAssert.strict.equal === nodeAssert.strict.strictEqual, ourAssert.strict.equal === ourAssert.strict.strictEqual],
    ["strict.equal === assert.strictEqual", nodeAssert.strict.equal === nodeAssert.strictEqual, ourAssert.strict.equal === ourAssert.strictEqual],
    ["strict.notEqual === assert.notStrictEqual", nodeAssert.strict.notEqual === nodeAssert.notStrictEqual, ourAssert.strict.notEqual === ourAssert.notStrictEqual],
    ["strict.deepEqual === assert.deepStrictEqual", nodeAssert.strict.deepEqual === nodeAssert.deepStrictEqual, ourAssert.strict.deepEqual === ourAssert.deepStrictEqual],
    ["strict.strict === strict", nodeAssert.strict.strict === nodeAssert.strict, ourAssert.strict.strict === ourAssert.strict],
    ["strict.ok === assert.ok", nodeAssert.strict.ok === nodeAssert.ok, ourAssert.strict.ok === ourAssert.ok],
    ["strict.AssertionError", nodeAssert.strict.AssertionError === nodeAssert.AssertionError, ourAssert.strict.AssertionError === ourAssert.AssertionError],
  ];
  for (const [label, expected, actual] of namespaceChecks) {
    if (expected !== actual) report("namespace", label, expected, actual);
  }

  // Direct AssertionError construction.
  const directExpected = new nodeAssert.AssertionError({
    actual: 1,
    expected: 2,
    operator: "strictEqual",
  });
  const directActual = new ourAssert.AssertionError({
    actual: 1,
    expected: 2,
    operator: "strictEqual",
  });
  for (const key of ["name", "code", "message", "generatedMessage", "operator"]) {
    if (directExpected[key] !== directActual[key]) {
      report("AssertionError." + key, "direct construction", directExpected[key], directActual[key]);
    }
  }

  nodeAssert.ok(cases.length >= 60, "assert oracle table is large");
  console.log("");
  console.log(
    `assert.oracle: ${cases.length} cases, ${mismatches} mismatch(es)`,
  );
  if (mismatches > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
