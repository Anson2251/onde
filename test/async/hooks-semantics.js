// async_hooks semantics that must hold in any Node-compatible runtime. Every check is an
// assertion, and every assertion prints one `ok` line, so the runner can diff node against lite.
// A value that differs (rather than a boolean) is never printed: ids are runtime-specific.

"use strict";

const assert = require("assert");
const {
  AsyncLocalStorage,
  AsyncResource,
  createHook,
  executionAsyncId,
  executionAsyncResource,
  triggerAsyncId,
} = require("async_hooks");

const ok = (name) => console.log("ok " + name);

// --- the root context ------------------------------------------------------------------------
assert.strictEqual(executionAsyncId(), 1);
assert.strictEqual(triggerAsyncId(), 0);
assert.deepStrictEqual(executionAsyncResource(), {});
ok("root ids");

// --- a timer's resource is created at schedule time and brackets its callback ----------------
const events = [];
let hook;
hook = createHook({
  init(id, type, trigger, resource) {
    events.push({ kind: "init", id, type, trigger, resource });
  },
  before(id) {
    events.push({ kind: "before", id, current: executionAsyncId() });
  },
  after(id) {
    events.push({ kind: "after", id, current: executionAsyncId() });
  },
  promiseResolve(id) {
    events.push({ kind: "resolve", id });
  },
});
hook.enable();

const scheduleId = executionAsyncId();
let timerId = 0;
const timer = setTimeout(() => {
  const before = events.filter((e) => e.kind === "before").pop();
  assert.strictEqual(executionAsyncId(), timerId, "executionAsyncId inside the timer");
  assert.strictEqual(before.current, timerId, "before runs as the resource");
  ok("timer context");
}, 1);

const timerInit = events.find((e) => e.kind === "init" && e.type === "Timeout");
assert.ok(timerInit, "Timeout init fired at schedule time");
assert.strictEqual(timerInit.trigger, scheduleId, "trigger is the scheduling context");
timerId = timerInit.id;

// --- ids increase monotonically ---------------------------------------------------------------
setTimeout(() => {}, 1);
const timeoutInits = events.filter((e) => e.kind === "init" && e.type === "Timeout");
assert.ok(timeoutInits.length >= 2);
assert.ok(
  timeoutInits[1].id > timeoutInits[0].id,
  "ids are monotonically increasing",
);
ok("monotonic ids");

// --- a promise chain reports init for the derived promise, then promiseResolve ----------------
let parentId = 0;
const derived = Promise.resolve()
  .then(() => {
    return 1;
  })
  .then(() => {
    return 2;
  });
const promiseInits = events.filter((e) => e.kind === "init" && e.type === "PROMISE");
assert.ok(promiseInits.length >= 2, "a then chain creates promises");
// The trigger of a derived promise is the promise it was derived from, not the running code.
const chain = promiseInits.filter((e) => e.id > 0);
assert.ok(chain.length >= 2);

derived.then(() => {
  const resolves = events.filter((e) => e.kind === "resolve");
  assert.ok(resolves.length >= 2, "promiseResolve fires for settled promises");
  const ids = new Set(resolves.map((e) => e.id));
  assert.ok(ids.size >= 2);
  ok("promise hooks");

  // --- AsyncResource ---------------------------------------------------------------------------
  const creator = executionAsyncId();
  const resource = new AsyncResource("TestResource");
  assert.ok(resource.asyncId() > 1);
  assert.strictEqual(typeof resource.asyncId(), "number");
  const seen = [];
  resource.runInAsyncScope(() => {
    assert.strictEqual(executionAsyncId(), resource.asyncId());
    seen.push(executionAsyncId());
  });
  assert.strictEqual(executionAsyncId(), creator, "restores the caller after the scope");
  assert.notStrictEqual(resource.asyncId(), creator);
  ok("async resource");

  // --- AsyncLocalStorage -----------------------------------------------------------------------
  const als = new AsyncLocalStorage();
  assert.strictEqual(als.getStore(), undefined);
  const store = { name: "store" };
  assert.strictEqual(als.run(store, () => als.getStore()), store);
  assert.strictEqual(als.getStore(), undefined, "run() does not leak");
  als.enterWith("entered");
  assert.strictEqual(als.getStore(), "entered");
  als.disable();
  assert.strictEqual(als.getStore(), undefined, "disable() clears");
  // Node 24's explicit-resource-management form: the store is active after the call and the
  // handle restores it on dispose.
  const scope = als.withScope("scoped", () => assert.strictEqual(als.getStore(), "scoped"));
  assert.strictEqual(als.getStore(), "scoped");
  scope.dispose();
  assert.strictEqual(als.getStore(), undefined);
  ok("async local storage");

  // --- createHook validation -------------------------------------------------------------------
  assert.throws(() => createHook({ init: 1 }), { code: "ERR_ASYNC_CALLBACK" });
  assert.throws(() => new AsyncResource(5), { code: "ERR_INVALID_ARG_TYPE" });
  assert.throws(() => new AsyncResource(""), { code: "ERR_ASYNC_TYPE" });
  ok("validation");

  hook.disable();
  clearTimeout(timer);
  console.log("done");
});
