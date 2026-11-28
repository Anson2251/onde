"use strict";

// onde's `node:test` onde module: the test API *and* the runner, in one file.
//
// Scope is fixed by m7-plan.md §3.5 and D71. This module ships `test`/`describe`/`it`, the four
// hooks, `t.test` subtests, `t.diagnostic`, `t.plan`, `t.assert`, promise and callback tests,
// timeouts, and the spec reporter `onde --test` prints. Mocks, snapshots, coverage, watch mode,
// `--test-only`, `--test-name-pattern`, other reporters and TAP are deliberately absent: each one
// is a compatibility promise with no test behind it here.
//
// Why the runner is JavaScript rather than Rust: hooks, the promise/`done` duality, plan
// accounting and the timeout race are test semantics, not flag plumbing. `ln-cli` discovers files
// (that *is* argument parsing) and calls `_run` with the list; everything after that is here, which
// is also how Node separates its runner from the CLI.
//
// The public export is the `test` function itself, with `describe`/`it`/hooks attached, because
// that is exactly `require("node:test")` in Node. `_run` is non-enumerable: it is how the runtime
// enters the runner (see `Isolate::run_tests`), not part of the API. The ESM facade in
// `crates/ln-runtime/src/modules.rs` reads enumerable names and skips `_`-prefixed ones, so it
// never leaks.

const assert = require("assert");
const Module = require("module");

// The default per-test timeout. Node has none (`Infinity`); a runner that can hang forever is
// worse than a documented 30 s floor, and every shipped test overrides it with `{ timeout }` when
// it needs more. `{ timeout: 0 }` or `{ timeout: Infinity }` disables both the default and the
// override, which is how a test opts back into Node's behaviour.
const DEFAULT_TIMEOUT = 30000;

// Methods `t.assert` forwards to `node:assert`. They are wrapped (not proxied) so `t.plan(n)` can
// count assertion calls without touching the shared assert module.
const ASSERT_METHODS = [
    "ok",
    "equal",
    "notEqual",
    "strictEqual",
    "notStrictEqual",
    "deepEqual",
    "notDeepEqual",
    "deepStrictEqual",
    "notDeepStrictEqual",
    "fail",
    "ifError",
    "match",
    "doesNotMatch",
    "throws",
    "rejects",
    "doesNotThrow",
    "doesNotReject",
];

// --- output -----------------------------------------------------------------------------------
//
// The spec reporter writes whole lines with one synchronous `process.stdout.write`. That is the
// same channel `console.log` uses, and it keeps the transcript ordered under the single-threaded
// loop: no buffering layer of our own to flush at exit.

function writeLine(text) {
    process.stdout.write(text + "\n");
}

// Node indents every reporter line by two spaces per nesting level.
function line(depth, text) {
    writeLine("  ".repeat(depth > 0 ? depth : 0) + text);
}

// Sub-millisecond precision matters only for display; `performance.now()` exists because
// bootstrap installs the perf_hooks globals, and `Date.now()` is the fallback for a host that
// only has the module.
function now() {
    const performance = globalThis.performance;
    if (
        performance !== null &&
        typeof performance === "object" &&
        typeof performance.now === "function"
    ) {
        return performance.now();
    }
    return Date.now();
}

// Node's spec reporter prints six decimals (`0.528083ms`); matching it means the pilot's
// transcript comparison does not need a special case for the unit, only for the numbers.
function formatDuration(milliseconds) {
    return `${milliseconds.toFixed(6)}ms`;
}

function formatError(error) {
    if (error !== null && typeof error === "object") {
        const name = typeof error.name === "string" ? error.name : "Error";
        const message = typeof error.message === "string" ? error.message : String(error);
        return `${name}: ${message}`;
    }
    return String(error);
}

function invalidArgType(name, expected, actual) {
    const received = typeof actual === "string" ? `'${actual}'` : String(actual);
    const error = new TypeError(
        `The "${name}" argument must be of type ${expected}. Received ${received}`,
    );
    error.code = "ERR_INVALID_ARG_TYPE";
    return error;
}

// --- definitions ------------------------------------------------------------------------------
//
// The tree is built while a test file is evaluated, not while it runs: `describe` calls its
// callback immediately. Node defers the callback to suite start, but nothing in the shipped
// subset can observe the difference (a `before` hook cannot register tests), and building the
// tree eagerly is what lets the runner be a plain sequential walk.

function createSuite(name, parent, options) {
    return {
        kind: "suite",
        name: String(name),
        parent,
        options: options || {},
        // `visible: false` is the per-file root: its hooks run, but Node prints no header for a file
        // (its tests are the transcript's top level).
        visible: !(options && options.visible === false),
        children: [],
        before: [],
        after: [],
        beforeEach: [],
        afterEach: [],
        diagnostics: [],
        depth: 0,
    };
}

// Definitions made outside `onde --test` land here and are never run. Node runs a test file
// required by a normal script at exit; the onde subset needs the explicit entry (§3.5), and
// silently accepting the calls keeps `import "node:test"` from breaking an otherwise normal
// script. This is part of D71, not an oversight.
const detachedSuite = createSuite("<detached>", null, { visible: false });
let currentSuite = detachedSuite;

function createTest(name, options, fn, parent) {
    const node = {
        kind: "test",
        name: String(name),
        fn,
        options: options || {},
        parent,
        children: [],
        diagnostics: [],
        // `plan` counts both `t.assert` calls and subtests, like Node.
        plan: undefined,
        assertionCount: 0,
        // The subtest drain loop and the promise `t.test()` returns. `settle` is called exactly once,
        // after the node's result line, so an awaited subtest resumes after its transcript line.
        drain: null,
        settle: null,
        bodySettled: false,
        // Resolved when a subtest is registered or when the body settles; the drain loop waits on it
        // instead of polling, so a body that awaits a subtest registered after an earlier await works.
        signal: null,
        signalResolve: null,
        depth: 0,
    };
    node.promise = new Promise((resolve) => {
        node.settle = resolve;
    });
    resetSignal(node);
    node.assert = createAssertAlias(node);
    return node;
}

function resetSignal(node) {
    node.signal = new Promise((resolve) => {
        node.signalResolve = resolve;
    });
}

function createAssertAlias(node, strictMode) {
    const count = () => {
        node.assertionCount += 1;
    };
    // `assert.strict` is a callable with strict-equal overrides for `equal`/`deepEqual`, so the
    // wrapper delegates to it rather than reimplementing the aliases.
    const target = strictMode ? assert.strict : assert;
    const alias = function (...args) {
        count();
        return target(...args);
    };
    for (const name of ASSERT_METHODS) {
        const method = target[name];
        if (typeof method !== "function") continue;
        alias[name] = function (...args) {
            count();
            return method.apply(target, args);
        };
    }
    // One level only: `assert.strict.strict` is itself, so recursing here would never terminate.
    alias.strict = strictMode ? alias : createAssertAlias(node, true);
    alias.AssertionError = target.AssertionError;
    return alias;
}

function unwrapTestArgs(options, fn) {
    if (typeof options === "function") return { options: {}, fn: options };
    return { options: options || {}, fn };
}

function validateBody(label, fn) {
    if (typeof fn !== "function") throw invalidArgType(label, "function", fn);
}

function registerTest(name, options, fn) {
    const body = unwrapTestArgs(options, fn);
    validateBody("fn", body.fn);
    const node = createTest(name, body.options, body.fn, currentSuite);
    currentSuite.children.push(node);
    return node;
}

// `test(name, fn)` and `it(name, fn)` are the same function in Node, as are `test.describe` and
// `describe`; aliasing keeps the two spellings from drifting.
function test(name, options, fn) {
    registerTest(name, options, fn);
}

function describe(name, options, fn) {
    const body = unwrapTestArgs(options, fn);
    validateBody("fn", body.fn);
    const suite = createSuite(name, currentSuite, body.options);
    currentSuite.children.push(suite);
    const previous = currentSuite;
    currentSuite = suite;
    try {
        const result = body.fn();
        if (result !== null && typeof result === "object" && typeof result.then === "function") {
            // An async describe callback would register tests after the tree walk has moved on. The
            // subset is synchronous here; say so instead of dropping the tests (D71).
            throw new TypeError("onde: an async describe() callback is not supported");
        }
    } finally {
        currentSuite = previous;
    }
}

function addHook(kind, fn) {
    validateBody(kind, fn);
    currentSuite[kind].push(fn);
}
test.test = test;
test.describe = describe;
test.it = test;
test.before = (fn) => addHook("before", fn);
test.after = (fn) => addHook("after", fn);
test.beforeEach = (fn) => addHook("beforeEach", fn);
test.afterEach = (fn) => addHook("afterEach", fn);

// --- per-test context -------------------------------------------------------------------------

function createHookContext(suite) {
    const holder = {
        name: suite.name,
        // Hook diagnostics belong to the suite's line, which is where the reporter prints them.
        diagnostics: suite.diagnostics,
        plan: undefined,
        assertionCount: 0,
    };
    // Hooks get `t.assert` too; the count is kept on the hook's holder and never checked, because a
    // hook has no plan of its own (Node's HookContext does not count either).
    holder.assert = createAssertAlias(holder);
    return contextFor(holder);
}

function createTestContext(node) {
    return contextFor(node);
}

function contextFor(node) {
    return {
        name: node.name,
        // Node buffers a test's diagnostics and prints them after its result line; the reporter does
        // the printing, so the context only records.
        diagnostic(message) {
            node.diagnostics.push(String(message));
        },
        plan(count) {
            if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
                throw invalidArgType("count", "a non-negative integer", count);
            }
            node.plan = count;
        },
        // Subtests are only meaningful on a test context; on a hook this throws like an unknown call.
        test(name, options, fn) {
            if (typeof node.drain === "undefined") {
                throw new TypeError("t.test() is only available on a test context");
            }
            return addSubtest(node, name, options, fn);
        },
        assert: node.assert,
    };
}

function addSubtest(parent, name, options, fn) {
    if (parent.finished) {
        // Node rejects a subtest whose parent already finished; without this, the child would never
        // run and an `await` on its promise would hang.
        throw new Error("Cannot create a subtest after the parent test has finished");
    }
    const body = unwrapTestArgs(options, fn);
    validateBody("fn", body.fn);
    const node = createTest(name, body.options, body.fn, parent);
    parent.children.push(node);
    // A subtest is an assertion for plan purposes (Node counts it).
    parent.assertionCount += 1;
    if (parent.drain === null) {
        parent.drain = drainSubtests(parent);
    } else {
        parent.signalResolve();
    }
    return node.promise;
}

// Run a test's subtests in definition order, waiting for the body to finish so a subtest
// registered after an `await` is still reached. The body's settlement wakes the loop; without
// that, waiting for a subtest the body itself awaits would deadlock.
async function drainSubtests(parent) {
    line(parent.depth, "▶ " + parent.name);
    let failed = false;
    let index = 0;
    for (;;) {
        while (index < parent.children.length) {
            const child = parent.children[index];
            index += 1;
            if (!(await runTest(child, parent.depth + 1))) failed = true;
        }
        if (parent.bodySettled) break;
        await parent.signal;
        resetSignal(parent);
    }
    return failed;
}

// --- timeouts ---------------------------------------------------------------------------------

function timeoutFor(options) {
    const value = options === undefined || options === null ? undefined : options.timeout;
    if (value === undefined || value === null) return DEFAULT_TIMEOUT;
    if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
        throw invalidArgType("options.timeout", "a non-negative number", value);
    }
    // 0 and Infinity mean "no timeout": 0 is the documented opt-out of the onde default (Node's
    // default is Infinity, so this is also how a Node-tuned test behaves as written).
    if (value === 0 || !Number.isFinite(value)) return Infinity;
    return value;
}

function withTimeout(promise, milliseconds) {
    if (!Number.isFinite(milliseconds)) return promise;
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            const error = new Error(`test timed out after ${milliseconds}ms`);
            error.code = "ERR_TEST_FAILURE";
            reject(error);
        }, milliseconds);
        const finish = (callback) => (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            callback(value);
        };
        promise.then(finish(resolve), finish(reject));
    });
}

// --- running ----------------------------------------------------------------------------------

let totals = null;
let failures = null;
let running = false;

function ancestorsOf(node) {
    const chain = [];
    let current = node.parent;
    while (current !== null && current !== undefined) {
        // Only suites carry hooks. A subtest's chain also contains its parent test, which has no
        // `beforeEach`/`afterEach` arrays and must not be walked as a suite.
        if (current.kind === "suite") chain.unshift(current);
        current = current.parent;
    }
    return chain;
}

async function callFunction(fn, context, options) {
    if (fn.length >= 2) {
        await withTimeout(callbackFunction(fn, context), timeoutFor(options));
        return;
    }
    const result = fn(context);
    if (result !== null && typeof result === "object" && typeof result.then === "function") {
        await withTimeout(result, timeoutFor(options));
    }
}

function callbackFunction(fn, context) {
    return new Promise((resolve, reject) => {
        let called = false;
        const done = (error) => {
            if (called) {
                // Node fails a test whose `done` runs twice; after the promise has settled a rejection
                // would be unobservable, so the second call is ignored (D71).
                return;
            }
            called = true;
            if (error !== undefined && error !== null) reject(error);
            else resolve();
        };
        let returned;
        try {
            returned = fn(context, done);
        } catch (error) {
            if (!called) {
                called = true;
                reject(error);
            }
            return;
        }
        if (
            returned !== null &&
            typeof returned === "object" &&
            typeof returned.then === "function"
        ) {
            // A callback test that also returns a promise is a Node error; the subset treats `done` as
            // authoritative and drains the stray promise so it cannot surface as an unhandled rejection.
            returned.then(undefined, () => {});
        }
    });
}

async function runTest(node, depth) {
    node.depth = depth;
    totals.tests += 1;
    const started = now();
    const ancestors = ancestorsOf(node);
    const context = createTestContext(node);
    let failure = null;

    // `beforeEach` runs outer to inner; a throw stops the test but not the run.
    try {
        for (const suite of ancestors) {
            for (const hook of suite.beforeEach) {
                await callFunction(hook, createHookContext(suite), suite.options);
            }
        }
    } catch (error) {
        failure = error;
    }

    if (failure === null) {
        try {
            await callFunction(node.fn, context, node.options);
        } catch (error) {
            failure = error;
        }
    }
    // Subtests were started by `t.test()`; the parent is not done until they are.
    node.bodySettled = true;
    node.signalResolve();
    if (node.drain !== null) {
        const subtestFailed = await node.drain;
        if (subtestFailed && failure === null) {
            failure = new Error("a subtest failed");
            failure.code = "ERR_TEST_FAILURE";
        }
    }

    if (failure === null && node.plan !== undefined && node.assertionCount !== node.plan) {
        failure = new Error(
            `plan expected ${node.plan} assertions to be executed but ${node.assertionCount} were executed`,
        );
        failure.code = "ERR_TEST_FAILURE";
    }

    // `afterEach` runs inner to outer, and runs even after a failure (cleanup must happen).
    try {
        for (let index = ancestors.length - 1; index >= 0; index -= 1) {
            const suite = ancestors[index];
            for (const hook of suite.afterEach) {
                await callFunction(hook, createHookContext(suite), suite.options);
            }
        }
    } catch (error) {
        if (failure === null) failure = error;
    }

    const duration = now() - started;
    if (failure === null) {
        line(depth, `✔ ${node.name} (${formatDuration(duration)})`);
        totals.pass += 1;
    } else {
        line(depth, `✖ ${node.name} (${formatDuration(duration)})`);
        totals.fail += 1;
        failures.push({ node, error: failure });
    }
    for (const message of node.diagnostics) line(depth, "ℹ " + message);
    node.finished = true;
    node.settle();
    return failure === null;
}

async function runSuite(suite, depth) {
    suite.depth = depth;
    const started = now();
    if (suite.visible) line(depth, "▶ " + suite.name);
    let failed = false;

    try {
        for (const hook of suite.before) {
            await callFunction(hook, createHookContext(suite), suite.options);
        }
    } catch (error) {
        failed = true;
        totals.fail += 1;
        failures.push({ node: { name: suite.name }, error });
    }

    // A failed `before` skips the suite's tests (their fixtures do not exist); `after` still runs.
    if (!failed) {
        for (const child of suite.children) {
            if (child.kind === "suite") {
                if (!(await runSuite(child, depth + 1))) failed = true;
            } else if (!(await runTest(child, depth + 1))) {
                failed = true;
            }
        }
    }

    try {
        for (const hook of suite.after) {
            await callFunction(hook, createHookContext(suite), suite.options);
        }
    } catch (error) {
        failed = true;
        totals.fail += 1;
        failures.push({ node: { name: suite.name }, error });
    }

    const duration = now() - started;
    if (suite.visible) {
        line(depth, `${failed ? "✖" : "✔"} ${suite.name} (${formatDuration(duration)})`);
        totals.suites += 1;
    }
    for (const message of suite.diagnostics) line(depth, "ℹ " + message);
    return !failed;
}

// --- file loading -----------------------------------------------------------------------------
//
// Test files are loaded as CommonJS through the installed `module` facade. `createRequire(file)`
// gives a `require` whose base directory is the test file's own, so a test file's relative
// requires behave exactly as they do when the file is the entry point. `.mjs` test files are not
// supported: the subset runs the CJS loader the rest of the runtime uses (D71, §3.5).
function loadTestFile(file) {
    const requireFromFile = Module.createRequire(file);
    requireFromFile(file);
}

// --- reporting --------------------------------------------------------------------------------

function printSummary(duration) {
    writeLine(`ℹ tests ${totals.tests}`);
    writeLine(`ℹ suites ${totals.suites}`);
    writeLine(`ℹ pass ${totals.pass}`);
    writeLine(`ℹ fail ${totals.fail}`);
    writeLine(`ℹ cancelled ${totals.cancelled}`);
    writeLine(`ℹ skipped ${totals.skipped}`);
    writeLine(`ℹ todo ${totals.todo}`);
    writeLine(`ℹ duration_ms ${duration}`);
}

function printFailures() {
    if (failures.length === 0) return;
    writeLine("");
    writeLine("✖ failing tests:");
    writeLine("");
    for (const { node, error } of failures) {
        const location = node.fileCode ? ` at ${node.fileCode}` : "";
        writeLine(`✖ ${node.name}${location}`);
        for (const text of formatError(error).split("\n")) writeLine("  " + text);
        const stack = error !== null && typeof error === "object" ? error.stack : undefined;
        if (typeof stack === "string") {
            const lines = stack.split("\n");
            // The first line is the "Name: message" header already printed above.
            for (const text of lines.slice(1)) writeLine("  " + text);
        }
        writeLine("");
    }
}

// A file that cannot even be loaded is one failure with the file's name: that is the only report
// that can name what broke before any test existed. Node's message shape is different here; the
// status and the fact that it was the file, not a test, is what matters.
function reportLoadFailure(file, error) {
    totals.fail += 1;
    line(0, `✖ ${file}`);
    failures.push({ node: { name: file }, error });
}

// --- entry point ------------------------------------------------------------------------------

async function runFiles(files) {
    totals = {
        tests: 0,
        suites: 0,
        pass: 0,
        fail: 0,
        cancelled: 0,
        skipped: 0,
        todo: 0,
    };
    failures = [];
    const started = now();
    const list = Array.isArray(files) ? files.map(String) : [];

    // One root per file, so top-level `before`/`after` hooks run once per file, exactly as they do
    // in Node's per-file child processes. The root is invisible: Node's transcript has no file
    // header, its tests are the top-level lines.
    for (const file of list) {
        const root = createSuite(file, null, { visible: false });
        const previous = currentSuite;
        currentSuite = root;
        let loaded = true;
        try {
            loadTestFile(file);
        } catch (error) {
            loaded = false;
            reportLoadFailure(file, error);
        } finally {
            currentSuite = previous;
        }
        if (loaded) await runSuite(root, -1);
    }

    const duration = now() - started;
    printSummary(duration);
    printFailures();
    // No files is a failed run, not a quiet success: a CI job that discovers nothing must not go
    // green (the CLI refuses an empty list too, this is defence in depth).
    process.exitCode = totals.fail > 0 || list.length === 0 ? 1 : 0;
}

// The runtime calls this (see `Isolate::run_tests`). It must never reject: Rust drops the returned
// promise, so a rejection would surface as an unhandled rejection with no test name attached.
async function run(files) {
    if (running) {
        writeLine("onde: the test runner is already running");
        process.exitCode = 1;
        return;
    }
    running = true;
    try {
        await runFiles(files);
    } catch (error) {
        writeLine("onde: the test runner failed");
        for (const text of formatError(error).split("\n")) writeLine("  " + text);
        process.exitCode = 1;
    } finally {
        running = false;
    }
}

Object.defineProperty(test, "_run", {
    value: run,
    enumerable: false,
    writable: false,
    configurable: false,
});

module.exports = test;
