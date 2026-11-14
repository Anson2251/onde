"use strict";
const controller = new AbortController();
console.log(controller.signal.aborted);
controller.signal.addEventListener("abort", () => console.log("abort-event"));
controller.abort();
console.log(controller.signal.aborted, controller.signal.reason.name, controller.signal.reason.code);
const target = new EventTarget();
const seen = [];
target.addEventListener("t", (event) => seen.push(event.type));
target.dispatchEvent(new Event("t"));
console.log(seen.join(","));
const cloned = structuredClone({ a: [1, 2], m: new Map([["k", 1]]) });
console.log(cloned.a.join("-"), cloned.m.get("k"));
try {
  structuredClone(() => {});
} catch (error) {
  console.log(error.name, error.code);
}
