"use strict";
const assert = require("assert");
try {
  assert.strictEqual(1, 2);
} catch (error) {
  console.log(error.name, error.code, error.operator);
}
try {
  assert.deepStrictEqual({ a: [1] }, { a: [2] });
} catch (error) {
  console.log(error.name, error.code, error.operator);
}
assert.deepStrictEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] });
assert.throws(() => {
  throw new TypeError("x");
}, TypeError);
console.log("throws-ok");
try {
  assert.fail("boom");
} catch (error) {
  console.log(error.code, error.message === "boom");
}
assert.rejects(Promise.reject(new Error("r")), /r/).then(() => console.log("rejects-ok"));
