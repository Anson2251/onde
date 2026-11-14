"use strict";

// Runtime-agnostic self-check for js/lib/globals.js.
//
//   node test/js/lib/globals.test.js
//
// The module under test is required by relative path and the assertions are
// literals, so this file must also pass under `lite` (no node: imports, no
// Buffer, no assert). Every line starting with "ok " is one passed assertion;
// the process exits 1 when any assertion fails.

const {
  DOMException,
  Event,
  EventTarget,
  AbortController,
  AbortSignal,
  structuredClone,
} = require("../../../js/lib/globals.js");

let passed = 0;
let failed = 0;
let currentSection = "";

function section(name) {
  currentSection = name;
}

function ok(condition, label, detail) {
  if (condition) {
    passed += 1;
    console.log("ok " + label);
  } else {
    failed += 1;
    let suffix = "";
    if (detail !== undefined) {
      try {
        suffix = " (" + String(detail) + ")";
      } catch (_) {
        suffix = "";
      }
    }
    console.log("not ok " + label + " [" + currentSection + "]" + suffix);
  }
}

function is(actual, expected, label) {
  ok(Object.is(actual, expected), label, "expected " + String(expected) + ", got " + String(actual));
}

function jsonIs(actual, expected, label) {
  let actualText;
  let expectedText;
  try {
    actualText = JSON.stringify(actual);
    expectedText = JSON.stringify(expected);
  } catch (error) {
    ok(false, label, error);
    return;
  }
  ok(actualText === expectedText, label, "expected " + expectedText + ", got " + actualText);
}

function expectThrow(fn, name, code, label) {
  try {
    fn();
  } catch (error) {
    ok(
      error !== null && typeof error === "object" && error.name === name &&
        (code === undefined || error.code === code),
      label,
      "got " + (error && (error.name + "/" + String(error.code) + ": " + error.message))
    );
    return error;
  }
  ok(false, label, "did not throw");
  return undefined;
}

function expectDataCloneError(fn, label) {
  const error = expectThrow(fn, "DataCloneError", 25, label);
  ok(error instanceof DOMException, label + " is a DOMException");
}

function tagOf(value) {
  return Object.prototype.toString.call(value);
}

async function main() {
// ---------------------------------------------------------------------------
// DOMException

section("DOMException");
{
  const error = new DOMException("boom", "AbortError");
  ok(error instanceof Error, "DOMException is an Error");
  is(error.name, "AbortError", "DOMException.name");
  is(error.message, "boom", "DOMException.message");
  is(error.code, 20, "DOMException.code for AbortError");
  ok(typeof error.stack === "string" && error.stack.length > 0, "DOMException has a stack");
  is(tagOf(error), "[object DOMException]", "DOMException toStringTag");

  is(new DOMException("", "DataCloneError").code, 25, "DOMException code for DataCloneError");
  is(new DOMException("", "TimeoutError").code, 23, "DOMException code for TimeoutError");
  is(new DOMException("", "SyntaxError").code, 12, "DOMException code for SyntaxError");
  is(new DOMException("", "EncodingError").code, 0, "DOMException code 0 for non-legacy name");
  is(new DOMException("", "MadeUp").code, 0, "DOMException code 0 for unknown name");

  const defaults = new DOMException();
  is(defaults.name, "Error", "DOMException default name");
  is(defaults.message, "", "DOMException default message");
  is(defaults.code, 0, "DOMException default code");

  is(DOMException.ABORT_ERR, 20, "DOMException.ABORT_ERR");
  is(DOMException.DATA_CLONE_ERR, 25, "DOMException.DATA_CLONE_ERR");
  is(DOMException.prototype.ABORT_ERR, 20, "DOMException.prototype.ABORT_ERR");
}

// ---------------------------------------------------------------------------
// Event

section("Event");
{
  const event = new Event("click");
  is(event.type, "click", "Event.type");
  is(event.bubbles, false, "Event.bubbles defaults false");
  is(event.cancelable, false, "Event.cancelable defaults false");
  is(event.composed, false, "Event.composed defaults false");
  is(event.defaultPrevented, false, "Event.defaultPrevented defaults false");
  is(event.target, null, "Event.target defaults null");
  is(event.currentTarget, null, "Event.currentTarget defaults null");
  is(event.eventPhase, 0, "Event.eventPhase defaults NONE");
  is(event.isTrusted, false, "Event.isTrusted defaults false");
  ok(typeof event.timeStamp === "number" && event.timeStamp >= 0, "Event.timeStamp is a number");
  is(tagOf(event), "[object Event]", "Event toStringTag");

  const configured = new Event("custom", { bubbles: true, cancelable: true, composed: true });
  is(configured.bubbles, true, "Event option bubbles");
  is(configured.cancelable, true, "Event option cancelable");
  is(configured.composed, true, "Event option composed");

  is(Event.NONE, 0, "Event.NONE");
  is(Event.CAPTURING_PHASE, 1, "Event.CAPTURING_PHASE");
  is(Event.AT_TARGET, 2, "Event.AT_TARGET");
  is(Event.BUBBLING_PHASE, 3, "Event.BUBBLING_PHASE");

  const notCancelable = new Event("no");
  notCancelable.preventDefault();
  is(notCancelable.defaultPrevented, false, "preventDefault is a no-op when not cancelable");

  const cancelable = new Event("yes", { cancelable: true });
  cancelable.preventDefault();
  is(cancelable.defaultPrevented, true, "preventDefault sets defaultPrevented when cancelable");
  cancelable.preventDefault();
  is(cancelable.defaultPrevented, true, "preventDefault is idempotent");

  is(cancelable.composedPath().length, 0, "composedPath is empty outside dispatch");

  expectThrow(function () { new Event(); }, "TypeError", "ERR_MISSING_ARGS", "Event requires a type");
  expectThrow(function () { new Event(Symbol("type")); }, "TypeError", undefined, "Event rejects symbol type");
  is(new Event("").type, "", "Event accepts an empty type");

  class MyEvent extends Event {}
  const subclass = new MyEvent("sub");
  ok(subclass instanceof Event, "Event subclass is an Event");
  is(subclass.type, "sub", "Event subclass keeps type");
}

// ---------------------------------------------------------------------------
// EventTarget: listeners, dispatch and options

section("EventTarget");
{
  const target = new EventTarget();
  is(tagOf(target), "[object EventTarget]", "EventTarget toStringTag");

  let calls = 0;
  let observed = null;
  function listener(event) {
    calls += 1;
    observed = event;
  }
  target.addEventListener("x", listener);
  const event = new Event("x");
  const returned = target.dispatchEvent(event);
  is(calls, 1, "listener is called once");
  is(returned, true, "dispatchEvent returns true without cancelation");
  is(observed, event, "listener receives the dispatched event");
  is(event.target, target, "event.target is the dispatching target");
  is(event.currentTarget, null, "event.currentTarget is restored after dispatch");
  is(event.eventPhase, Event.NONE, "event.eventPhase is restored after dispatch");
  is(event.target, target, "event.target stays set after dispatch (Node behaviour)");
  is(event.composedPath().length, 0, "composedPath is empty after dispatch");

  const phases = [];
  const phaseTarget = new EventTarget();
  phaseTarget.addEventListener("phase", function (phaseEvent) {
    phases.push([
      phaseEvent.eventPhase,
      phaseEvent.target === phaseTarget,
      phaseEvent.currentTarget === phaseTarget,
      this === phaseTarget,
      phaseEvent.composedPath().length,
    ]);
  });
  phaseTarget.dispatchEvent(new Event("phase"));
  is(phases.length, 1, "one phase observation");
  is(phases[0][0], Event.AT_TARGET, "listener runs at AT_TARGET");
  is(phases[0][1], true, "target is set while dispatching");
  is(phases[0][2], true, "currentTarget is the target at target phase");
  is(phases[0][3], true, "function listener this is currentTarget");
  is(phases[0][4], 1, "composedPath contains the target");

  // Duplicates: same type/callback/capture is one listener; a different capture
  // flag is a distinct registration.
  let duplicateCalls = 0;
  const duplicateFn = function () { duplicateCalls += 1; };
  const duplicateTarget = new EventTarget();
  duplicateTarget.addEventListener("dup", duplicateFn);
  duplicateTarget.addEventListener("dup", duplicateFn);
  duplicateTarget.dispatchEvent(new Event("dup"));
  is(duplicateCalls, 1, "duplicate listener registration is suppressed");

  let captureCalls = 0;
  const captureFn = function () { captureCalls += 1; };
  const captureTarget = new EventTarget();
  captureTarget.addEventListener("capture", captureFn, false);
  captureTarget.addEventListener("capture", captureFn, true);
  captureTarget.dispatchEvent(new Event("capture"));
  is(captureCalls, 2, "same callback with a different capture flag is distinct");

  // once
  let onceCalls = 0;
  const onceTarget = new EventTarget();
  onceTarget.addEventListener("once", function () { onceCalls += 1; }, { once: true });
  onceTarget.dispatchEvent(new Event("once"));
  onceTarget.dispatchEvent(new Event("once"));
  is(onceCalls, 1, "once listener fires once");

  // Adding a duplicate with { once: true } does not upgrade an existing listener.
  let upgradeCalls = 0;
  const upgradeFn = function () { upgradeCalls += 1; };
  const upgradeTarget = new EventTarget();
  upgradeTarget.addEventListener("upgrade", upgradeFn);
  upgradeTarget.addEventListener("upgrade", upgradeFn, { once: true });
  upgradeTarget.dispatchEvent(new Event("upgrade"));
  upgradeTarget.dispatchEvent(new Event("upgrade"));
  is(upgradeCalls, 2, "duplicate once registration does not upgrade an existing listener");

  // boolean options mean capture
  let booleanCapture = 0;
  const booleanTarget = new EventTarget();
  booleanTarget.addEventListener("bool", function () { booleanCapture += 1; }, true);
  booleanTarget.dispatchEvent(new Event("bool"));
  is(booleanCapture, 1, "boolean addEventListener option means capture");

  // removal
  let removeCalls = 0;
  const removeFn = function () { removeCalls += 1; };
  const removeTarget = new EventTarget();
  removeTarget.addEventListener("remove", removeFn, true);
  removeTarget.removeEventListener("remove", removeFn, false);
  removeTarget.dispatchEvent(new Event("remove"));
  is(removeCalls, 1, "removeEventListener ignores a capture mismatch");
  removeTarget.removeEventListener("remove", removeFn, true);
  removeTarget.dispatchEvent(new Event("remove"));
  is(removeCalls, 1, "removeEventListener removes a matching listener");

  // listener objects
  const listenerObject = {
    seen: null,
    handleEvent(event) {
      this.seen = event.type;
      ok(this === listenerObject, "listener object handleEvent this is the listener object");
    },
  };
  const objectTarget = new EventTarget();
  objectTarget.addEventListener("object", listenerObject);
  objectTarget.dispatchEvent(new Event("object"));
  is(listenerObject.seen, "object", "listener object handleEvent is invoked");

  // invalid listeners
  expectThrow(
    function () { new EventTarget().addEventListener("x", 3); },
    "TypeError", "ERR_INVALID_ARG_TYPE", "addEventListener rejects a non-callable listener"
  );
  let noOpCalls = 0;
  new EventTarget().addEventListener("x", null);
  new EventTarget().removeEventListener("x", undefined);
  ok(true, "add/removeEventListener tolerate null and undefined listeners");
  expectThrow(
    function () { new EventTarget().addEventListener("x"); },
    "TypeError", "ERR_MISSING_ARGS", "addEventListener requires a listener argument"
  );
  expectThrow(
    function () { new EventTarget().removeEventListener("x"); },
    "TypeError", "ERR_MISSING_ARGS", "removeEventListener requires a listener argument"
  );

  // dispatch validation
  expectThrow(
    function () { new EventTarget().dispatchEvent({ type: "fake" }); },
    "TypeError", "ERR_INVALID_ARG_TYPE", "dispatchEvent requires an Event"
  );
  is(new EventTarget().dispatchEvent(new Event("empty")), true, "dispatch with no listeners returns true");

  // cancelation return value
  const bubbleTarget = new EventTarget();
  bubbleTarget.addEventListener("cancel", function (cancelEvent) { cancelEvent.preventDefault(); });
  const cancelEvent = new Event("cancel", { cancelable: true });
  is(bubbleTarget.dispatchEvent(cancelEvent), false, "dispatchEvent returns false when canceled");
  is(cancelEvent.defaultPrevented, true, "canceled event reports defaultPrevented");

  const nonCancelableTarget = new EventTarget();
  nonCancelableTarget.addEventListener("no", function (noEvent) { noEvent.preventDefault(); });
  const nonCancelable = new Event("no");
  is(nonCancelableTarget.dispatchEvent(nonCancelable), true, "preventDefault on non-cancelable keeps return true");

  // stopImmediatePropagation / stopPropagation
  const immediateTarget = new EventTarget();
  const immediateOrder = [];
  immediateTarget.addEventListener("stop", function (stopEvent) {
    immediateOrder.push(1);
    stopEvent.stopImmediatePropagation();
  });
  immediateTarget.addEventListener("stop", function () { immediateOrder.push(2); });
  immediateTarget.dispatchEvent(new Event("stop"));
  is(immediateOrder.join(","), "1", "stopImmediatePropagation skips remaining listeners");

  const propagationTarget = new EventTarget();
  const propagationOrder = [];
  propagationTarget.addEventListener("stop", function (stopEvent) {
    propagationOrder.push(1);
    stopEvent.stopPropagation();
  });
  propagationTarget.addEventListener("stop", function () { propagationOrder.push(2); });
  propagationTarget.dispatchEvent(new Event("stop"));
  is(propagationOrder.join(","), "1,2", "stopPropagation does not skip same-target listeners");

  // mutation during dispatch
  const addingTarget = new EventTarget();
  const addingOrder = [];
  addingTarget.addEventListener("add", function () {
    addingOrder.push("first");
    addingTarget.addEventListener("add", function () { addingOrder.push("added"); });
  });
  addingTarget.dispatchEvent(new Event("add"));
  is(addingOrder.join(","), "first", "listener added during dispatch is not called in that dispatch");
  addingTarget.dispatchEvent(new Event("add"));
  is(addingOrder.join(","), "first,first,added", "listener added during dispatch runs on the next dispatch");

  const removingTarget = new EventTarget();
  const removingOrder = [];
  const removedListener = function () { removingOrder.push("removed"); };
  removingTarget.addEventListener("remove", function () {
    removingOrder.push("first");
    removingTarget.removeEventListener("remove", removedListener);
  });
  removingTarget.addEventListener("remove", removedListener);
  removingTarget.dispatchEvent(new Event("remove"));
  is(removingOrder.join(","), "first", "listener removed during dispatch is not called");

  // subclassing
  class MyTarget extends EventTarget {
    constructor() {
      super();
      this.value = 7;
    }
    method() {
      return "method";
    }
  }
  const subclassTarget = new MyTarget();
  let subclassThis = null;
  subclassTarget.addEventListener("sub", function () { subclassThis = this; });
  subclassTarget.dispatchEvent(new Event("sub"));
  is(subclassTarget.value, 7, "EventTarget subclass keeps its fields");
  is(subclassTarget.method(), "method", "EventTarget subclass keeps its methods");
  is(subclassThis, subclassTarget, "EventTarget subclass listener this is the subclass instance");
  ok(subclassTarget instanceof EventTarget, "EventTarget subclass instance passes instanceof");

  // reentrant dispatch of the same event
  const recursiveTarget = new EventTarget();
  const recursiveEvent = new Event("recursive");
  let recursion = null;
  recursiveTarget.addEventListener("recursive", function () {
    try {
      recursiveTarget.dispatchEvent(recursiveEvent);
    } catch (error) {
      recursion = error;
    }
  });
  recursiveTarget.dispatchEvent(recursiveEvent);
  ok(recursion !== null, "reentrant dispatch of the same event throws");
  is(recursion && recursion.name, "Error", "reentrant dispatch error name");
  is(recursion && recursion.code, "ERR_EVENT_RECURSION", "reentrant dispatch error code");
}

// ---------------------------------------------------------------------------
// EventTarget: listener errors and AbortSignal integration

section("EventTarget listeners");
{
  // Listener errors are reported asynchronously, and dispatch continues.
  const originalQueueMicrotask = typeof globalThis.queueMicrotask === "function"
    ? globalThis.queueMicrotask
    : undefined;
  const reported = [];
  let stubbed = false;
  if (originalQueueMicrotask !== undefined) {
    try {
      globalThis.queueMicrotask = function (callback) { reported.push(callback); };
      stubbed = globalThis.queueMicrotask !== originalQueueMicrotask;
    } catch (_) {
      stubbed = false;
    }
  }
  try {
    const errorTarget = new EventTarget();
    const order = [];
    const thrown = new Error("listener boom");
    errorTarget.addEventListener("error", function () {
      order.push("thrower");
      throw thrown;
    });
    errorTarget.addEventListener("error", function () { order.push("second"); });
    let dispatchResult;
    try {
      dispatchResult = errorTarget.dispatchEvent(new Event("error"));
    } catch (_) {
      dispatchResult = "threw synchronously";
    }
    is(order.join(","), "thrower,second", "listener error does not stop later listeners");
    is(dispatchResult, true, "listener error does not change dispatch result");
    if (stubbed) {
      is(reported.length, 1, "listener error is queued on a microtask");
      let rethrown = null;
      try {
        reported[0]();
      } catch (error) {
        rethrown = error;
      }
      is(rethrown, thrown, "microtask rethrows the original listener error");
    } else {
      ok(true, "queueMicrotask unavailable to the test; async error reporting not asserted");
      ok(true, "queueMicrotask unavailable to the test; rethrow identity not asserted");
    }
  } finally {
    if (originalQueueMicrotask !== undefined) {
      try {
        globalThis.queueMicrotask = originalQueueMicrotask;
      } catch (_) {
        // ignore
      }
    }
  }

  // AbortSignal integration.
  const controller = new AbortController();
  const signalTarget = new EventTarget();
  let signalCalls = 0;
  signalTarget.addEventListener("signal", function () { signalCalls += 1; }, { signal: controller.signal });
  signalTarget.dispatchEvent(new Event("signal"));
  is(signalCalls, 1, "signal option registers a listener");
  controller.abort();
  signalTarget.dispatchEvent(new Event("signal"));
  is(signalCalls, 1, "aborting a signal removes its listeners");

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const lateTarget = new EventTarget();
  let lateCalls = 0;
  lateTarget.addEventListener("late", function () { lateCalls += 1; }, { signal: alreadyAborted.signal });
  lateTarget.dispatchEvent(new Event("late"));
  is(lateCalls, 0, "an already-aborted signal adds no listener");

  expectThrow(
    function () { new EventTarget().addEventListener("x", function () {}, { signal: {} }); },
    "TypeError", "ERR_INVALID_ARG_TYPE", "signal option must be an AbortSignal"
  );
}

// ---------------------------------------------------------------------------
// EventTarget: capture / bubble propagation over a parentNode tree

section("EventTarget tree");
{
  function makeTree() {
    const root = new EventTarget();
    const middle = new EventTarget();
    const leaf = new EventTarget();
    Object.defineProperty(middle, "parentNode", { value: root, configurable: true });
    Object.defineProperty(leaf, "parentNode", { value: middle, configurable: true });
    return { root: root, middle: middle, leaf: leaf };
  }

  function observeTree(bubbles) {
    const tree = makeTree();
    const log = [];
    function add(target, name) {
      target.addEventListener("tree", function (event) {
        log.push(name + ":capture:" + event.eventPhase);
        ok(event.target === tree.leaf, name + " capture sees leaf target");
        ok(event.currentTarget === target, name + " capture sees itself as currentTarget");
      }, true);
      target.addEventListener("tree", function (event) {
        log.push(name + ":bubble:" + event.eventPhase);
      }, false);
    }
    add(tree.root, "root");
    add(tree.middle, "middle");
    add(tree.leaf, "leaf");
    tree.leaf.dispatchEvent(new Event("tree", { bubbles: bubbles }));
    return { tree: tree, log: log };
  }

  const nonBubbling = observeTree(false);
  is(
    nonBubbling.log.join(","),
    "root:capture:1,middle:capture:1,leaf:capture:2,leaf:bubble:2",
    "non-bubbling event captures to the target only"
  );
  is(nonBubbling.tree.leaf.parentNode, nonBubbling.tree.middle, "parentNode chain is intact");

  const bubbling = observeTree(true);
  is(
    bubbling.log.join(","),
    "root:capture:1,middle:capture:1,leaf:capture:2,leaf:bubble:2,middle:bubble:3,root:bubble:3",
    "bubbling event captures and bubbles in order"
  );

  // composedPath during the root's capture listener
  {
    const tree = makeTree();
    let pathLength = 0;
    tree.root.addEventListener("tree", function (event) {
      pathLength = event.composedPath().length;
      ok(event.composedPath()[0] === tree.leaf, "composedPath starts at the target");
      ok(event.composedPath()[2] === tree.root, "composedPath ends at the root");
    }, true);
    tree.leaf.dispatchEvent(new Event("tree"));
    is(pathLength, 3, "composedPath contains the whole ancestor chain");
  }

  // stopPropagation during an ancestor's capture phase prevents the target
  {
    const tree = makeTree();
    const log = [];
    tree.middle.addEventListener("tree", function (event) {
      log.push("middle");
      event.stopPropagation();
    }, true);
    tree.leaf.addEventListener("tree", function () { log.push("leaf"); });
    tree.root.addEventListener("tree", function () { log.push("root-bubble"); }, false);
    tree.leaf.dispatchEvent(new Event("tree", { bubbles: true }));
    is(log.join(","), "middle", "stopPropagation in capture prevents the target and bubble");
  }

  // stopPropagation at the target still runs the remaining target listeners
  {
    const tree = makeTree();
    const log = [];
    tree.leaf.addEventListener("tree", function (event) {
      log.push("leaf1");
      event.stopPropagation();
    });
    tree.leaf.addEventListener("tree", function () { log.push("leaf2"); });
    tree.middle.addEventListener("tree", function () { log.push("middle-bubble"); });
    tree.leaf.dispatchEvent(new Event("tree", { bubbles: true }));
    is(log.join(","), "leaf1,leaf2", "stopPropagation at target keeps same-target listeners and blocks bubbling");
  }

  // `parent` is accepted as a fallback for `parentNode`
  {
    const root = new EventTarget();
    const child = new EventTarget();
    Object.defineProperty(child, "parent", { value: root, configurable: true });
    const log = [];
    root.addEventListener("fallback", function () { log.push("root"); }, true);
    child.addEventListener("fallback", function () { log.push("child"); });
    child.dispatchEvent(new Event("fallback"));
    is(log.join(","), "root,child", "parent is accepted as a tree link");
  }

  // cycles terminate
  {
    const first = new EventTarget();
    const second = new EventTarget();
    Object.defineProperty(first, "parentNode", { value: second, configurable: true });
    Object.defineProperty(second, "parentNode", { value: first, configurable: true });
    let count = 0;
    first.addEventListener("cycle", function () { count += 1; });
    second.addEventListener("cycle", function () { count += 1; });
    first.dispatchEvent(new Event("cycle", { bubbles: true }));
    is(count, 2, "cyclic parent links terminate");
  }
}

// ---------------------------------------------------------------------------
// AbortController / AbortSignal

section("AbortController");
{
  const controller = new AbortController();
  const signal = controller.signal;
  ok(signal instanceof AbortSignal, "controller.signal is an AbortSignal");
  ok(signal instanceof EventTarget, "AbortSignal is an EventTarget");
  is(tagOf(signal), "[object AbortSignal]", "AbortSignal toStringTag");
  is(tagOf(controller), "[object AbortController]", "AbortController toStringTag");
  is(signal.aborted, false, "new signal is not aborted");
  is(signal.reason, undefined, "new signal has no reason");
  let cleanThrows = false;
  try {
    signal.throwIfAborted();
  } catch (_) {
    cleanThrows = true;
  }
  is(cleanThrows, false, "throwIfAborted does not throw before abort");

  const events = [];
  signal.onabort = function (event) {
    events.push(["onabort", event.type, event.target === signal, this === signal, event.isTrusted]);
    ok(event.isTrusted, "abort event is trusted");
  };
  signal.addEventListener("abort", function (event) {
    events.push(["listener", event.type]);
    is(event.type, "abort", "abort event type");
  });
  controller.abort();
  is(signal.aborted, true, "abort sets aborted");
  is(events.length, 2, "abort dispatches to onabort and listeners");
  is(events[0][0], "onabort", "onabort participates in listener order");
  is(events[0][1], "abort", "onabort receives an abort event");
  is(events[0][2], true, "abort event target is the signal");
  is(events[0][3], true, "onabort this is the signal");
  is(events[1][0], "listener", "addEventListener listener runs after onabort");

  is(signal.reason.name, "AbortError", "default abort reason name");
  is(signal.reason.code, 20, "default abort reason code");
  ok(signal.reason instanceof DOMException, "default abort reason is a DOMException");
  ok(signal.reason instanceof Error, "default abort reason is an Error");

  controller.abort();
  is(events.length, 2, "abort is idempotent");

  const custom = new AbortController();
  const arbitraryReason = { why: "because" };
  custom.abort(arbitraryReason);
  is(custom.signal.reason, arbitraryReason, "abort preserves an arbitrary reason");
  custom.abort("ignored");
  is(custom.signal.reason, arbitraryReason, "second abort does not replace the reason");

  const nullReason = new AbortController();
  nullReason.abort(null);
  is(nullReason.signal.reason, null, "abort(null) uses null as the reason");

  const falsyReason = new AbortController();
  falsyReason.abort(0);
  let thrownReason;
  try {
    falsyReason.signal.throwIfAborted();
  } catch (error) {
    thrownReason = error;
  }
  is(thrownReason, 0, "throwIfAborted throws the exact reason value");

  const identityReason = new AbortController();
  const identity = new Error("nope");
  identityReason.abort(identity);
  let identityThrown;
  try {
    identityReason.signal.throwIfAborted();
  } catch (error) {
    identityThrown = error;
  }
  is(identityThrown, identity, "throwIfAborted throws the identity reason");

  let onceAbort = 0;
  const onceSignal = new AbortController();
  onceSignal.signal.addEventListener("abort", function () { onceAbort += 1; }, { once: true });
  onceSignal.abort();
  is(onceAbort, 1, "AbortSignal supports once listeners");

  const manual = new AbortController();
  let manualCalls = 0;
  manual.signal.onabort = function () { manualCalls += 1; };
  manual.signal.dispatchEvent(new Event("abort"));
  is(manualCalls, 1, "dispatching abort manually invokes onabort");
  is(manual.signal.aborted, false, "dispatching abort manually does not set aborted");

  const handler = function () {};
  const handlerSignal = new AbortController().signal;
  handlerSignal.onabort = handler;
  is(handlerSignal.onabort, handler, "onabort getter returns the handler");
  handlerSignal.onabort = null;
  is(handlerSignal.onabort, null, "onabort can be cleared");

  expectThrow(function () { new AbortSignal(); }, "TypeError", undefined, "AbortSignal cannot be constructed directly");
}

// ---------------------------------------------------------------------------
// AbortSignal statics

section("AbortSignal statics");
{
  const staticAbort = AbortSignal.abort();
  is(staticAbort.aborted, true, "AbortSignal.abort returns an aborted signal");
  is(staticAbort.reason.name, "AbortError", "AbortSignal.abort default reason");
  is(staticAbort.reason.code, 20, "AbortSignal.abort default reason code");
  is(AbortSignal.abort("custom").reason, "custom", "AbortSignal.abort preserves a reason");

  const immediate = AbortSignal.timeout(50);
  is(immediate.aborted, false, "AbortSignal.timeout is not aborted synchronously");
  expectThrow(
    function () { AbortSignal.timeout(-1); },
    "RangeError", "ERR_OUT_OF_RANGE", "AbortSignal.timeout rejects negative delays"
  );
  expectThrow(
    function () { AbortSignal.timeout(1.5); },
    "RangeError", "ERR_OUT_OF_RANGE", "AbortSignal.timeout rejects non-integer delays"
  );
  expectThrow(
    function () { AbortSignal.timeout("5"); },
    "TypeError", "ERR_INVALID_ARG_TYPE", "AbortSignal.timeout rejects non-number delays"
  );

  const emptyAny = AbortSignal.any([]);
  is(emptyAny.aborted, false, "AbortSignal.any([]) is not aborted");
  ok(emptyAny instanceof AbortSignal, "AbortSignal.any returns an AbortSignal");

  const first = new AbortController();
  const second = new AbortController();
  const combined = AbortSignal.any([first.signal, second.signal]);
  let combinedEvents = 0;
  combined.addEventListener("abort", function () { combinedEvents += 1; });
  second.abort("second-reason");
  first.abort("first-reason");
  is(combined.aborted, true, "AbortSignal.any aborts when a source aborts");
  is(combined.reason, "second-reason", "AbortSignal.any uses the first aborted source reason");
  is(combinedEvents, 1, "AbortSignal.any fires one abort event");

  const preset = AbortSignal.any([AbortSignal.abort("preset"), new AbortController().signal]);
  is(preset.aborted, true, "AbortSignal.any handles an already-aborted source");
  is(preset.reason, "preset", "AbortSignal.any keeps the already-aborted reason");

  expectThrow(
    function () { AbortSignal.any(null); },
    "TypeError", "ERR_INVALID_ARG_TYPE", "AbortSignal.any rejects non-iterables"
  );
  expectThrow(
    function () { AbortSignal.any([{}]); },
    "TypeError", "ERR_INVALID_ARG_TYPE", "AbortSignal.any rejects non-signals"
  );

  if (typeof setTimeout === "function") {
    const timed = AbortSignal.timeout(5);
    const didFire = await new Promise(function (resolve) {
      // The timeout signal's timer is unref'd (Node), so hold the loop open.
      const keepAlive = setTimeout(function () { resolve(false); }, 1000);
      timed.addEventListener("abort", function () {
        clearTimeout(keepAlive);
        resolve(true);
      });
    });
    ok(didFire, "AbortSignal.timeout fires");
    is(timed.aborted, true, "timeout signal is aborted after firing");
    is(timed.reason.name, "TimeoutError", "timeout reason name");
    is(timed.reason.code, 23, "timeout reason code");
    ok(timed.reason instanceof DOMException, "timeout reason is a DOMException");
  } else {
    ok(true, "setTimeout unavailable; AbortSignal.timeout firing not asserted");
    ok(true, "setTimeout unavailable; timeout aborted not asserted");
    ok(true, "setTimeout unavailable; timeout name not asserted");
    ok(true, "setTimeout unavailable; timeout code not asserted");
    ok(true, "setTimeout unavailable; timeout DOMException not asserted");
  }
}

// ---------------------------------------------------------------------------
// structuredClone: values, built-ins, cycles and identity

section("structuredClone");
{
  is(structuredClone(42), 42, "structuredClone number");
  is(structuredClone("text"), "text", "structuredClone string");
  is(structuredClone(true), true, "structuredClone boolean");
  is(structuredClone(null), null, "structuredClone null");
  is(structuredClone(undefined), undefined, "structuredClone undefined");
  is(structuredClone(10n), 10n, "structuredClone bigint");

  const source = { a: 1, b: { c: [1, 2, { d: "e" }] } };
  const objectClone = structuredClone(source);
  jsonIs(objectClone, source, "structuredClone nested object round-trips");
  ok(objectClone !== source, "structuredClone returns a new object");
  ok(objectClone.b !== source.b, "structuredClone clones nested objects recursively");

  class Point {
    constructor() {
      this.x = 1;
    }
    method() {
      return "method";
    }
  }
  const pointClone = structuredClone(new Point());
  is(Object.getPrototypeOf(pointClone), Object.prototype, "class instances become plain objects");
  is(pointClone.x, 1, "class instance own fields are cloned");
  is(pointClone.method, undefined, "class instance methods are not cloned");

  const taggedClass = new (class Tagged {
    constructor() {
      this.x = 1;
    }
    get [Symbol.toStringTag]() {
      return "Tagged";
    }
  })();
  jsonIs(structuredClone(taggedClass), { x: 1 }, "objects with a custom toStringTag are cloned as plain objects");

  const eventTargetClone = structuredClone(new EventTarget());
  is(Object.getPrototypeOf(eventTargetClone), Object.prototype, "EventTarget instances clone as plain objects");
  is(Reflect.ownKeys(eventTargetClone).length, 0, "EventTarget clone has no own properties");
  jsonIs(structuredClone(new Event("x")), {}, "Event instances clone as plain objects");

  const nullPrototype = Object.create(null);
  nullPrototype.a = 1;
  const nullPrototypeClone = structuredClone(nullPrototype);
  is(Object.getPrototypeOf(nullPrototypeClone), Object.prototype, "null-prototype objects become plain objects");
  is(nullPrototypeClone.a, 1, "null-prototype own properties are cloned");

  const arraySource = [1, 2, 3];
  arraySource.extra = "kept";
  const arrayClone = structuredClone(arraySource);
  is(arrayClone.length, 3, "array length is preserved");
  is(arrayClone.extra, "kept", "array extra properties are cloned");

  const sparse = [, , 1];
  const sparseClone = structuredClone(sparse);
  is(sparseClone.length, 3, "sparse array length is preserved");
  ok(0 in sparseClone === false, "sparse array holes are preserved");

  const mapSource = new Map([["a", 1], [3, { v: 2 }]]);
  const mapClone = structuredClone(mapSource);
  ok(mapClone instanceof Map, "Map clone stays a Map");
  is(mapClone.size, 2, "Map clone size");
  is(mapClone.get("a"), 1, "Map clone primitive entry");
  is(mapClone.get(3).v, 2, "Map clone object value");
  ok(mapClone.get(3) !== mapSource.get(3), "Map clone deep-clones values");

  const key = { key: true };
  const keyedMapClone = structuredClone(new Map([[key, "value"]]));
  const clonedKey = keyedMapClone.keys().next().value;
  ok(clonedKey !== key, "Map object keys are cloned");
  is(clonedKey.key, true, "Map object keys keep their fields");

  const setSource = new Set([1, "a", { o: 1 }]);
  const setClone = structuredClone(setSource);
  ok(setClone instanceof Set, "Set clone stays a Set");
  is(setClone.size, 3, "Set clone size");
  is(Array.from(setClone)[0], 1, "Set clone primitive member");

  const dateClone = structuredClone(new Date(123456789));
  ok(dateClone instanceof Date, "Date clone stays a Date");
  is(dateClone.getTime(), 123456789, "Date clone keeps the time value");

  const regexpSource = /ab+c/gi;
  regexpSource.lastIndex = 3;
  const regexpClone = structuredClone(regexpSource);
  ok(regexpClone instanceof RegExp, "RegExp clone stays a RegExp");
  is(regexpClone.source, "ab+c", "RegExp clone source");
  is(regexpClone.flags, "gi", "RegExp clone flags");
  is(regexpClone.lastIndex, 0, "RegExp clone resets lastIndex");

  const bufferSource = new ArrayBuffer(4);
  new Uint8Array(bufferSource)[0] = 7;
  const bufferClone = structuredClone(bufferSource);
  ok(bufferClone instanceof ArrayBuffer, "ArrayBuffer clone stays an ArrayBuffer");
  is(bufferClone.byteLength, 4, "ArrayBuffer clone length");
  is(new Uint8Array(bufferClone)[0], 7, "ArrayBuffer clone bytes");
  ok(bufferClone !== bufferSource, "ArrayBuffer clone is a new buffer");

  const repeated = structuredClone([bufferSource, bufferSource]);
  ok(repeated[0] === repeated[1], "repeated ArrayBuffer references keep identity");

  const viewSource = new Uint8Array([1, 2, 3]);
  const viewClone = structuredClone(viewSource);
  ok(viewClone instanceof Uint8Array, "typed array clone stays a Uint8Array");
  is(viewClone.join(","), "1,2,3", "typed array clone contents");
  ok(viewClone.buffer !== viewSource.buffer, "typed array clone gets a new buffer");

  const largeBuffer = new ArrayBuffer(16);
  new Uint8Array(largeBuffer).fill(7);
  const largeViewClone = structuredClone(new Uint8Array(largeBuffer, 4, 3));
  is(largeViewClone.byteOffset, 4, "typed array clone keeps byteOffset");
  is(largeViewClone.byteLength, 3, "typed array clone keeps byteLength");
  is(largeViewClone.buffer.byteLength, 16, "typed array clone copies the whole backing buffer");
  is(new Uint8Array(largeViewClone.buffer)[0], 7, "typed array clone keeps bytes outside the view");
  is(new Uint8Array(largeViewClone.buffer)[15], 7, "typed array clone keeps trailing bytes");

  const dataViewClone = structuredClone(new DataView(largeBuffer, 4, 3));
  ok(dataViewClone instanceof DataView, "DataView clone stays a DataView");
  is(dataViewClone.byteOffset, 4, "DataView clone byteOffset");
  is(dataViewClone.byteLength, 3, "DataView clone byteLength");
  is(dataViewClone.buffer.byteLength, 16, "DataView clone backing buffer length");

  const typedSubclass = new (class MyBytes extends Uint8Array {})([1, 2]);
  const typedSubclassClone = structuredClone(typedSubclass);
  is(typedSubclassClone.constructor, Uint8Array, "typed array subclasses clone to the base constructor");

  if (typeof BigInt64Array === "function") {
    const bigIntClone = structuredClone(new BigInt64Array([1n, 2n]));
    is(bigIntClone.constructor, BigInt64Array, "BigInt64Array clone constructor");
    is(bigIntClone[1], 2n, "BigInt64Array clone value");
  } else {
    ok(true, "BigInt64Array unavailable; typed array coverage skipped");
    ok(true, "BigInt64Array unavailable; typed array coverage skipped");
  }

  const errorSource = new TypeError("bad");
  errorSource.code = "E_BAD";
  errorSource.extra = { not: "cloned" };
  const errorClone = structuredClone(errorSource);
  ok(errorClone instanceof TypeError, "TypeError clone keeps its constructor");
  is(errorClone.name, "TypeError", "TypeError clone name");
  is(errorClone.message, "bad", "TypeError clone message");
  ok(typeof errorClone.stack === "string", "Error clone keeps a stack");
  is(errorClone.code, undefined, "Error clone does not copy arbitrary own props");
  is(errorClone.extra, undefined, "Error clone does not copy arbitrary object props");

  class CustomError extends Error {
    constructor(message) {
      super(message);
      this.name = "CustomError";
    }
  }
  const customErrorClone = structuredClone(new CustomError("custom"));
  is(customErrorClone.constructor, Error, "Error subclasses clone to Error");
  is(customErrorClone.name, "Error", "custom Error name is not preserved (Node behaviour)");

  const causeSource = new Error("with cause", { cause: { reason: "because" } });
  const causeClone = structuredClone(causeSource);
  is(causeClone.cause.reason, "because", "Error cause is cloned");
  ok(Object.keys(causeClone).indexOf("cause") === -1, "cloned Error cause is non-enumerable");

  is(structuredClone(Object(3)).valueOf(), 3, "Number wrapper clone");
  ok(structuredClone(Object("x")) instanceof String, "String wrapper clone");
  is(structuredClone(Object("x")).valueOf(), "x", "String wrapper value");
  is(structuredClone(Object(true)).valueOf(), true, "Boolean wrapper clone");
  is(structuredClone(Object(5n)).valueOf(), 5n, "BigInt wrapper clone");

  const domExceptionClone = structuredClone(new DOMException("message", "AbortError"));
  ok(domExceptionClone instanceof DOMException, "DOMException clone stays a DOMException");
  is(domExceptionClone.name, "AbortError", "DOMException clone name");
  is(domExceptionClone.message, "message", "DOMException clone message");
  is(domExceptionClone.code, 20, "DOMException clone code");

  const cyclic = { name: "cyclic" };
  cyclic.self = cyclic;
  const cyclicClone = structuredClone(cyclic);
  ok(cyclicClone !== cyclic, "cyclic clone is a new object");
  is(cyclicClone.self, cyclicClone, "cycles are preserved");

  const cyclicMap = new Map();
  cyclicMap.set("self", cyclicMap);
  const cyclicMapClone = structuredClone(cyclicMap);
  is(cyclicMapClone.get("self"), cyclicMapClone, "Map cycles are preserved");

  const alias = { shared: true };
  const aliasClone = structuredClone([alias, alias]);
  is(aliasClone[0], aliasClone[1], "repeated object references keep identity");

  const symbolKeyed = { a: 1 };
  symbolKeyed[Symbol("hidden")] = 2;
  const symbolKeyedClone = structuredClone(symbolKeyed);
  is(Reflect.ownKeys(symbolKeyedClone).length, 1, "symbol-keyed properties are not cloned");

  const hiddenFunction = {};
  Object.defineProperty(hiddenFunction, "fn", { value: function () {}, enumerable: false });
  jsonIs(structuredClone(hiddenFunction), {}, "non-enumerable function properties are skipped");

  const frozenClone = structuredClone(Object.freeze({ a: 1 }));
  is(Object.isFrozen(frozenClone), false, "cloned objects are not frozen");

  jsonIs(structuredClone({ a: 1 }, null), { a: 1 }, "structuredClone accepts null options");
  jsonIs(structuredClone({ a: 1 }, undefined), { a: 1 }, "structuredClone accepts undefined options");
}

// ---------------------------------------------------------------------------
// structuredClone: DataCloneError cases

section("structuredClone errors");
{  expectDataCloneError(function () { structuredClone(Symbol("nope")); }, "symbol value cannot be cloned");
  expectDataCloneError(function () { structuredClone(function () {}); }, "function cannot be cloned");
  expectDataCloneError(function () { structuredClone(new WeakMap()); }, "WeakMap cannot be cloned");
  expectDataCloneError(function () { structuredClone(new WeakSet()); }, "WeakSet cannot be cloned");
  expectDataCloneError(function () { structuredClone(Promise.resolve(1)); }, "Promise cannot be cloned");
  expectDataCloneError(
    function () { structuredClone({ nested: { fn: function () {} } }); },
    "nested function cannot be cloned"
  );

  const detachedSource = new ArrayBuffer(4);
  detachedSource.transfer(0);
  expectDataCloneError(
    function () { structuredClone(detachedSource); },
    "detached ArrayBuffer cannot be cloned"
  );
}

// ---------------------------------------------------------------------------
// structuredClone: transfer

section("structuredClone transfer");
{
  const supportsTransfer = typeof ArrayBuffer.prototype.transfer === "function" ||
    typeof ArrayBuffer.prototype.transferToFixedLength === "function";

  const source = new ArrayBuffer(4);
  new Uint8Array(source)[0] = 7;
  const transferred = structuredClone(source, { transfer: [source] });
  is(transferred.byteLength, 4, "transferred buffer keeps its length");
  is(new Uint8Array(transferred)[0], 7, "transferred buffer keeps its bytes");
  ok(transferred !== source, "transferred buffer is a new buffer");
  if (supportsTransfer) {
    is(source.byteLength, 0, "transfer detaches the source buffer");
    is(source.detached, true, "transferred source reports detached");
  } else {
    ok(true, "engine has no ArrayBuffer transfer; source detachment not asserted");
    ok(true, "engine has no ArrayBuffer transfer; source detached flag not asserted");
  }

  const viewedBuffer = new ArrayBuffer(8);
  new Uint8Array(viewedBuffer).fill(5);
  const view = new Uint8Array(viewedBuffer, 2, 3);
  const viewTransferClone = structuredClone(view, { transfer: [viewedBuffer] });
  is(viewTransferClone.byteOffset, 2, "transferred view keeps byteOffset");
  is(viewTransferClone.byteLength, 3, "transferred view keeps byteLength");
  is(viewTransferClone.buffer.byteLength, 8, "transferred view keeps the full backing buffer");
  is(viewTransferClone.join(","), "5,5,5", "transferred view keeps its bytes");
  if (supportsTransfer) {
    is(viewedBuffer.detached, true, "transferring a viewed buffer detaches it");
  } else {
    ok(true, "engine has no ArrayBuffer transfer; viewed source detachment not asserted");
  }

  const bothBuffer = new ArrayBuffer(8);
  new Uint8Array(bothBuffer).fill(5);
  const bothView = new Uint8Array(bothBuffer, 2, 3);
  const bothClone = structuredClone({ buffer: bothBuffer, view: bothView }, { transfer: [bothBuffer] });
  is(bothClone.buffer, bothClone.view.buffer, "buffer and view share the transferred clone");
  is(bothClone.view.byteOffset, 2, "shared transferred view keeps byteOffset");
  is(bothClone.view.join(","), "5,5,5", "shared transferred view keeps bytes");

  const identityBuffer = new ArrayBuffer(4);
  const identityClone = structuredClone([identityBuffer, identityBuffer], { transfer: [identityBuffer] });
  is(identityClone[0], identityClone[1], "repeated transferred buffer keeps identity");
  if (supportsTransfer) {
    is(identityBuffer.detached, true, "repeated transferred buffer source is detached");
  } else {
    ok(true, "engine has no ArrayBuffer transfer; repeated source detachment not asserted");
  }

  const unusedBuffer = new ArrayBuffer(4);
  structuredClone(1, { transfer: [unusedBuffer] });
  if (supportsTransfer) {
    is(unusedBuffer.byteLength, 0, "transfer detaches buffers not present in the value");
  } else {
    ok(true, "engine has no ArrayBuffer transfer; unused buffer detachment not asserted");
  }

  expectDataCloneError(
    function () { structuredClone(1, { transfer: [new Uint8Array(4)] }); },
    "transfer list rejects views"
  );
  {
    const buffer = new ArrayBuffer(4);
    expectDataCloneError(
      function () { structuredClone(1, { transfer: [buffer, buffer] }); },
      "transfer list rejects duplicates"
    );
  }
  expectThrow(
    function () { structuredClone(1, { transfer: "invalid" }); },
    "TypeError", "ERR_INVALID_ARG_TYPE", "transfer must be an iterable"
  );
  {
    const detached = new ArrayBuffer(4);
    detached.transfer(0);
    expectDataCloneError(
      function () { structuredClone(1, { transfer: [detached] }); },
      "transfer list rejects detached buffers"
    );
  }
  {
    const buffer = new ArrayBuffer(4);
    expectDataCloneError(
      function () { structuredClone(function () {}, { transfer: [buffer] }); },
      "failed serialization still throws DataCloneError"
    );
    if (supportsTransfer) {
      is(buffer.byteLength, 4, "failed serialization does not detach the source");
    } else {
      ok(true, "engine has no ArrayBuffer transfer; failed-serialization detachment not asserted");
    }
  }
}
} // main

// ---------------------------------------------------------------------------
// Summary / exit status

main().then(
  function report() {
    section("summary");
    console.log("# " + passed + " passed, " + failed + " failed");
    if (failed > 0) {
      if (typeof process !== "undefined" && process !== null && typeof process.exit === "function") {
        process.exit(1);
      }
      throw new Error(failed + " assertions failed");
    }
  },
  function harnessFailure(error) {
    console.error("not ok harness: " + (error && error.stack ? error.stack : String(error)));
    if (typeof process !== "undefined" && process !== null && typeof process.exit === "function") {
      process.exit(1);
    }
    throw error;
  }
);
