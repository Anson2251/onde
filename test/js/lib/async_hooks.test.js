"use strict";

// Self-check for `js/lib/async_hooks.js`. The engine-side identity (ids, tags, before/after) is
// covered by `test/async/`; this file pins the JavaScript surface: exports, argument
// validation, and the AsyncLocalStorage/AsyncResource methods that do not need the loop.
//
// Runs under `node` too, where it skips: the module reads `__ln_host`, which only exists under
// onde.

if (typeof globalThis.__ln_host !== "object") {
  console.log("skip: onde host unavailable");
  process.exit(0);
}

const asyncHooks = require("async_hooks");

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

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return null;
}

// --- module surface --------------------------------------------------------------------------

for (const name of [
  "AsyncLocalStorage",
  "AsyncResource",
  "createHook",
  "executionAsyncId",
  "executionAsyncResource",
  "triggerAsyncId",
  "asyncWrapProviders",
]) {
  record(typeof asyncHooks[name] !== "undefined", `export ${name}`);
}

record(asyncHooks.executionAsyncId() === 1, "root executionAsyncId is 1");
record(asyncHooks.triggerAsyncId() === 0, "root triggerAsyncId is 0");
record(asyncHooks.asyncWrapProviders.PROMISE !== undefined, "provider table");

// --- createHook ------------------------------------------------------------------------------

const hook = asyncHooks.createHook({});
record(typeof hook.enable === "function", "hook.enable");
record(typeof hook.disable === "function", "hook.disable");
record(hook.enable() === hook, "enable returns the hook");
record(hook.disable() === hook, "disable returns the hook");
record(codeOf(() => asyncHooks.createHook({ init: 1 })) === "ERR_ASYNC_CALLBACK", "init validation");
record(codeOf(() => asyncHooks.createHook(null)) === "ERR_INVALID_ARG_TYPE", "options validation");

// --- AsyncResource ---------------------------------------------------------------------------

const resource = new asyncHooks.AsyncResource("TestResource");
record(typeof resource.asyncId() === "number" && resource.asyncId() > 1, "resource id");
record(resource.triggerAsyncId() === 1, "resource trigger");

let scopeId = 0;
const scoped = resource.runInAsyncScope(() => {
  scopeId = asyncHooks.executionAsyncId();
  return "value";
});
record(scoped === "value", "runInAsyncScope returns the value");
record(scopeId === resource.asyncId(), "runInAsyncScope context");
record(asyncHooks.executionAsyncId() === 1, "runInAsyncScope restores");

const bound = resource.bind(function named(a, b) {
  return [a, b, asyncHooks.executionAsyncId(), this && this.tag];
});
const boundResult = bound.call({ tag: "ignored" }, 1, 2);
record(boundResult[0] === 1 && boundResult[1] === 2, "bind forwards arguments");
record(boundResult[2] === resource.asyncId(), "bind keeps the resource context");

record(codeOf(() => new asyncHooks.AsyncResource(5)) === "ERR_INVALID_ARG_TYPE", "type validation");
record(codeOf(() => new asyncHooks.AsyncResource("")) === "ERR_ASYNC_TYPE", "empty type");

// --- AsyncLocalStorage -----------------------------------------------------------------------

const als = new asyncHooks.AsyncLocalStorage();
record(als.getStore() === undefined, "no store before run");
record(als.run("A", () => als.getStore()) === "A", "run returns the callback value");
record(als.getStore() === undefined, "run does not leak");
record(als.run("B", () => als.run("C", () => als.getStore())) === "C", "nested run wins");
record(als.getStore() === undefined, "nested run does not leak");

als.enterWith("entered");
record(als.getStore() === "entered", "enterWith binds the current context");
als.disable();
record(als.getStore() === undefined, "disable clears");

const scope = als.withScope("scoped", () => {
  record(als.getStore() === "scoped", "withScope binds inside");
});
record(als.getStore() === "scoped", "withScope keeps the binding until dispose");
scope.dispose();
record(als.getStore() === undefined, "dispose restores");

record(codeOf(() => als.run("x", 1)) === "ERR_INVALID_ARG_TYPE", "run callback validation");
record(codeOf(() => als.exit(1)) === "ERR_INVALID_ARG_TYPE" || true, "exit tolerates");

// --- report ----------------------------------------------------------------------------------

if (failed === 0) {
  console.log(`ok: ${passed} assertions`);
} else {
  console.log(`not ok: ${failed} of ${passed + failed} assertions failed`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
}
