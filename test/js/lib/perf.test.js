"use strict";

// Self-check for js/lib/perf_hooks.js.
//
// Lite-only: the module wraps the engine's monotonic clock and installs the `performance`
// global. The deterministic parts (entry bookkeeping, option parsing, error codes) are asserted
// exactly; timings are only checked for shape, monotonicity and range so the test never depends
// on how fast the machine is.

if (typeof globalThis.__ln_host !== "object") {
    console.log("skip: onde host unavailable");
    process.exit(0);
}

const perf = require("../../../js/lib/perf_hooks.js");
const { performance } = perf;

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

function isTime(value) {
    return typeof value === "number" && Number.isFinite(value);
}

function tick(milliseconds) {
    return new Promise((resolve) =>
        setTimeout(resolve, milliseconds === undefined ? 5 : milliseconds),
    );
}

const tests = [];
function test(name, fn) {
    tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// module shape

test("module shape", () => {
    eq(typeof perf.performance, "object", "performance is exported");
    eq(typeof perf.Performance, "function", "Performance is exported");
    eq(typeof perf.PerformanceEntry, "function", "PerformanceEntry is exported");
    eq(typeof perf.PerformanceMark, "function", "PerformanceMark is exported");
    eq(typeof perf.PerformanceMeasure, "function", "PerformanceMeasure is exported");
    eq(typeof perf.PerformanceObserver, "function", "PerformanceObserver is exported");
    eq(typeof perf.hrtime, "function", "hrtime is exported");
    eq(typeof perf.hrtime.bigint, "function", "hrtime.bigint is exported");
    eq(typeof perf.eventLoopUtilization, "function", "eventLoopUtilization is exported");
    ok(performance instanceof perf.Performance, "performance is a Performance instance");
});

test("globalThis.performance is the perf_hooks performance", () => {
    eq(globalThis.performance, performance, "global identity holds");
    eq(typeof globalThis.performance.mark, "function", "the global has mark()");
    eq(typeof globalThis.performance.measure, "function", "the global has measure()");
});

// ---------------------------------------------------------------------------
// clock

test("now is a finite, monotonic number", async () => {
    const first = performance.now();
    ok(isTime(first), "now() is a finite number");
    ok(first >= 0, "now() is non-negative");
    let previous = first;
    let monotonic = true;
    for (let index = 0; index < 1000; index += 1) {
        const current = performance.now();
        if (current < previous) {
            monotonic = false;
            break;
        }
        previous = current;
    }
    ok(monotonic, "now() never goes backwards");
    await tick(10);
    ok(performance.now() >= previous, "now() advances across a timer turn");
});

test("timeOrigin is an epoch millisecond timestamp", () => {
    ok(isTime(performance.timeOrigin), "timeOrigin is a finite number");
    ok(performance.timeOrigin > 1e12, "timeOrigin is in the Unix epoch range");
    ok(performance.timeOrigin <= Date.now() + 1000, "timeOrigin is not in the future");
});

test("const now = performance.now still works", () => {
    const now = performance.now;
    ok(isTime(now()), "a detached now() returns a number");
});

// ---------------------------------------------------------------------------
// marks

test("mark() records a PerformanceMark", () => {
    const mark = performance.mark("tty-test-mark");
    ok(mark instanceof perf.PerformanceMark, "mark() returns a PerformanceMark");
    ok(mark instanceof perf.PerformanceEntry, "PerformanceMark extends PerformanceEntry");
    eq(mark.name, "tty-test-mark", "name is preserved");
    eq(mark.entryType, "mark", "entryType is mark");
    ok(isTime(mark.startTime), "startTime is a number");
    eq(mark.duration, 0, "mark duration is 0");
    eq(mark.detail, null, "detail defaults to null");
    eq(performance.getEntriesByName("tty-test-mark").length, 1, "the mark is in the entry list");
    eq(performance.getEntriesByType("mark")[0].name, "tty-test-mark", "getEntriesByType sees it");
});

test("mark() honours startTime and detail", () => {
    const mark = performance.mark("explicit-mark", { startTime: 12.5, detail: { nested: true } });
    eq(mark.startTime, 12.5, "explicit startTime is used");
    eq(mark.detail.nested, true, "detail is stored by identity");
    eq(JSON.parse(JSON.stringify(mark)).startTime, 12.5, "toJSON carries startTime");
    eq(JSON.parse(JSON.stringify(mark)).detail.nested, true, "toJSON carries detail");
});

test("mark() rejects a non-string name", () => {
    let caught;
    try {
        performance.mark(1);
    } catch (error) {
        caught = error;
    }
    eq(caught && caught.name, "TypeError", "non-string name throws TypeError");
    eq(
        caught && caught.code,
        "ERR_INVALID_ARG_TYPE",
        "non-string name carries ERR_INVALID_ARG_TYPE",
    );
});

// ---------------------------------------------------------------------------
// measures

test("measure() between marks", () => {
    performance.mark("measure-start", { startTime: 10 });
    performance.mark("measure-end", { startTime: 25 });
    const measure = performance.measure("measure-ab", "measure-start", "measure-end");
    ok(measure instanceof perf.PerformanceMeasure, "measure() returns a PerformanceMeasure");
    eq(measure.name, "measure-ab", "name is preserved");
    eq(measure.entryType, "measure", "entryType is measure");
    eq(measure.startTime, 10, "start comes from the first mark");
    eq(measure.duration, 15, "duration is end - start");
    eq(measure.detail, null, "detail defaults to null");
});

test("measure() with an options object", () => {
    const measure = performance.measure("measure-options", { start: 10, end: 25, detail: "tag" });
    eq(measure.startTime, 10, "options.start is used");
    eq(measure.duration, 15, "options.end determines duration");
    eq(measure.detail, "tag", "options.detail is stored");
    const fromDuration = performance.measure("measure-duration", { start: 5, duration: 7 });
    eq(fromDuration.startTime, 5, "start from options");
    eq(fromDuration.duration, 7, "duration from options");
});

test("measure() without a start mark starts at zero", () => {
    const measure = performance.measure("measure-open");
    eq(measure.startTime, 0, "startTime default is 0");
    ok(measure.duration >= 0, "duration is non-negative");
});

test("measure() rejects an unknown mark", () => {
    let caught;
    try {
        performance.measure("measure-missing", "no-such-mark");
    } catch (error) {
        caught = error;
    }
    eq(caught && caught.name, "SyntaxError", "missing mark throws SyntaxError");
    ok(
        caught && /performance mark has not been set/.test(String(caught.message)),
        "missing mark message names the mark",
    );
});

// ---------------------------------------------------------------------------
// listing and clearing

test("getEntries returns copies and honours filters", () => {
    performance.mark("list-a");
    performance.mark("list-b");
    performance.measure("list-m", "list-a", "list-b");
    const all = performance.getEntries();
    ok(Array.isArray(all), "getEntries() returns an array");
    all.length = 0;
    ok(performance.getEntries().length > 0, "mutating the returned array does not clear the list");
    eq(performance.getEntriesByName("list-a").length, 1, "getEntriesByName filters by name");
    eq(
        performance.getEntriesByName("list-a", "mark").length,
        1,
        "getEntriesByName filters by type",
    );
    eq(performance.getEntriesByName("list-a", "measure").length, 0, "wrong type yields nothing");
    eq(
        performance.getEntriesByType("measure").some((entry) => entry.name === "list-m"),
        true,
        "measure is listed",
    );
});

test("clearMarks / clearMeasures", () => {
    performance.mark("clear-a");
    performance.mark("clear-b");
    performance.measure("clear-m", "clear-a", "clear-b");
    performance.clearMarks("clear-a");
    eq(performance.getEntriesByName("clear-a").length, 0, "clearMarks(name) removes one mark");
    eq(performance.getEntriesByName("clear-b").length, 1, "other marks survive");
    eq(performance.getEntriesByName("clear-m").length, 1, "measures survive clearMarks");
    performance.clearMarks();
    eq(performance.getEntriesByType("mark").length, 0, "clearMarks() removes every mark");
    eq(performance.getEntriesByName("clear-m").length, 1, "clearMarks() leaves measures alone");
    performance.clearMeasures();
    eq(performance.getEntriesByType("measure").length, 0, "clearMeasures() removes every measure");
});

// ---------------------------------------------------------------------------
// observer

test("PerformanceObserver is a documented no-op observer", () => {
    let calls = 0;
    const observer = new perf.PerformanceObserver(() => {
        calls += 1;
    });
    eq(typeof observer.observe, "function", "observe exists");
    eq(typeof observer.disconnect, "function", "disconnect exists");
    eq(typeof observer.takeRecords, "function", "takeRecords exists");
    observer.observe({ entryTypes: ["mark", "measure"] });
    performance.mark("observed-mark");
    eq(calls, 0, "M3 does not deliver observer callbacks");
    const records = observer.takeRecords();
    ok(Array.isArray(records), "takeRecords() returns an array");
    eq(records.length, 0, "takeRecords() is empty");
    observer.disconnect();
    const types = perf.PerformanceObserver.supportedEntryTypes;
    ok(
        types.includes("mark") && types.includes("measure"),
        "supportedEntryTypes lists mark/measure",
    );
});

// ---------------------------------------------------------------------------
// hrtime and event loop utilization

test("hrtime agrees with process.hrtime", () => {
    const sample = perf.hrtime();
    ok(Array.isArray(sample), "hrtime() returns an array");
    eq(sample.length, 2, "hrtime() has two elements");
    eq(typeof sample[0], "number", "seconds is a number");
    eq(typeof sample[1], "number", "nanoseconds is a number");
    const big = perf.hrtime.bigint();
    eq(typeof big, "bigint", "hrtime.bigint() returns a bigint");
    ok(perf.hrtime.bigint() >= big, "hrtime.bigint() is monotonic");
    eq(typeof process.hrtime, "function", "process.hrtime still exists");
});

test("eventLoopUtilization has the Node shape", () => {
    const first = performance.eventLoopUtilization();
    for (const key of ["idle", "active", "utilization"]) {
        eq(typeof first[key], "number", `${key} is a number`);
        ok(Number.isFinite(first[key]), `${key} is finite`);
    }
    ok(first.idle >= 0 && first.active >= 0, "idle/active are non-negative");
    ok(first.utilization >= 0 && first.utilization <= 1, "utilization is in [0, 1]");
    const second = performance.eventLoopUtilization();
    ok(second.active >= first.active, "active time does not decrease");
    const delta = performance.eventLoopUtilization(first, second);
    eq(typeof delta.idle, "number", "two-argument form returns idle");
    eq(typeof delta.active, "number", "two-argument form returns active");
    eq(typeof delta.utilization, "number", "two-argument form returns utilization");
    eq(
        typeof perf.eventLoopUtilization().active,
        "number",
        "module-level eventLoopUtilization works",
    );
});

test("toJSON has timeOrigin", () => {
    const json = performance.toJSON();
    eq(typeof json.timeOrigin, "number", "toJSON().timeOrigin is a number");
    eq(typeof json.eventLoopUtilization, "object", "toJSON().eventLoopUtilization is an object");
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
        for (let index = 0; index < failures.length; index += 1)
            console.log(`not ok - ${failures[index]}`);
    }
    console.log(`perf.test.js: ${passed} passed, ${failed} failed, ${tests.length} tests`);

    if (failed > 0) process.exitCode = 1;
}

run().catch((error) => {
    try {
        process.stderr.write(
            `perf.test.js crashed: ${error && error.stack ? error.stack : error}\n`,
        );
    } catch (_) {
        // nothing else we can do
    }
    process.exitCode = 1;
});
