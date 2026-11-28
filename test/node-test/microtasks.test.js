"use strict";

// Adapted from test/conformance/microtasks/c09-await-ordering.js and c12-shared-fifo.js.
//
// The conformance cases print an ordering transcript; here the same order is collected into an
// array and asserted, so the case is a `node:test` file that Node 26 and `onde --test` run
// unchanged. Only `queueMicrotask` and promise reactions are queued: both runtimes give them one
// FIFO in settle order from any position, and one `setImmediate` flushes that queue before the
// assertion runs. (`process.nextTick` is deliberately not part of the pilot: its priority against
// promise jobs depends on whether it was queued from top-level code or from inside a microtask,
// and a runner starts tests in the latter position.)

const test = require("node:test");
const assert = require("node:assert");

function afterImmediate() {
    return new Promise((resolve) => setImmediate(resolve));
}

test.describe("microtasks", () => {
    test("queueMicrotask and promise reactions share one FIFO", async () => {
        const order = [];
        queueMicrotask(() => order.push("qm1"));
        Promise.resolve().then(() => order.push("then1"));
        Promise.resolve().then(() => {
            order.push("then2");
            queueMicrotask(() => order.push("qm-from-then2"));
        });
        queueMicrotask(() => order.push("qm2"));
        order.push("sync");

        await afterImmediate();

        // C12's expected order: sync qm1 then1 then2 qm2 qm-from-then2
        assert.deepStrictEqual(order, ["sync", "qm1", "then1", "then2", "qm2", "qm-from-then2"]);
    });

    test("await enqueues its continuation before a later then", async () => {
        const order = [];
        async function f() {
            order.push("f-start");
            await null;
            order.push("f-after");
        }
        f();
        Promise.resolve().then(() => order.push("then"));
        queueMicrotask(() => order.push("qm"));
        order.push("sync");

        await afterImmediate();

        // C9's expected order: f-start sync f-after then qm
        assert.deepStrictEqual(order, ["f-start", "sync", "f-after", "then", "qm"]);
    });
});

test("a callback test completes on done()", (t, done) => {
    t.plan(1);
    t.diagnostic("callback style");
    setImmediate(() => {
        t.assert.strictEqual(typeof done, "function");
        done();
    });
});
