// The five async_hooks callbacks fire with ids that line up: every before/after pair names the
// resource its callback runs as, init happens at creation, and promiseResolve fires for settled
// promises. Only booleans are printed: ids are runtime-specific.
const { createHook, executionAsyncId, triggerAsyncId } = require("async_hooks");

let inits = 0;
let befores = 0;
let afters = 0;
let resolves = 0;
let beforeMatched = true;
let afterMatched = true;
let initTriggerOk = true;
let seen = new Set();

const hook = createHook({
    init(id, type, trigger) {
        inits += 1;
        if (trigger <= 0) initTriggerOk = false;
        seen.add(id);
    },
    before(id) {
        befores += 1;
        if (executionAsyncId() !== id) beforeMatched = false;
    },
    after(id) {
        afters += 1;
        if (executionAsyncId() !== id) afterMatched = false;
    },
    promiseResolve(id) {
        resolves += 1;
        if (!seen.has(id)) initTriggerOk = false;
    },
});
hook.enable();

setTimeout(() => {
    Promise.resolve().then(() => {});
}, 1);

const target = setTimeout(() => {
    hook.disable();
    console.log("inits", inits > 0);
    console.log("before-after-pairs", befores > 0 && afters > 0);
    console.log("before-context", beforeMatched);
    console.log("after-context", afterMatched);
    console.log("resolve-after-init", resolves > 0 && initTriggerOk);
    console.log("root", executionAsyncId() > 0, triggerAsyncId() >= 0);
    clearTimeout(target);
}, 10);
