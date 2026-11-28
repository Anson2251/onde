"use strict";

// Runtime-agnostic self-check for js/lib/assert.js.
// Runs unchanged under `node` and `onde`: the only require is our module.

const a = require("../../../js/lib/assert.js");
const util = require("../../../js/lib/util.js");

let checks = 0;
let failures = 0;

function show(value) {
    try {
        return util.inspect(value, { depth: 3, breakLength: Infinity });
    } catch {
        return String(value);
    }
}

function is(actual, expected, label) {
    checks++;
    if (Object.is(actual, expected)) {
        console.log("ok " + label);
    } else {
        failures++;
        console.log("not ok " + label + " - expected " + show(expected) + ", got " + show(actual));
    }
}

function passes(fn, label) {
    checks++;
    try {
        fn();
        console.log("ok " + label);
    } catch (error) {
        failures++;
        console.log(
            "not ok " +
                label +
                " - threw " +
                (error && error.name) +
                ": " +
                (error && error.message),
        );
    }
}

function stamps(error) {
    return {
        isAssertionError: error instanceof a.AssertionError,
        name: error && error.name,
        code: error && error.code,
        operator: error && error.operator,
        actual: error && error.actual,
        expected: error && error.expected,
        generatedMessage: error && error.generatedMessage,
        message: error && error.message,
        errorName: error && error.constructor && error.constructor.name,
        errorCode: error && error.code,
    };
}

function fails(fn, expected, label) {
    checks++;
    let error;
    try {
        fn();
    } catch (caught) {
        error = caught;
    }
    if (error === undefined) {
        failures++;
        console.log("not ok " + label + " - did not throw");
        return;
    }
    const fields = stamps(error);
    const problems = [];
    if (expected.assertionError !== false && !fields.isAssertionError) {
        problems.push("not an AssertionError");
    }
    for (const key of ["name", "code", "operator", "actual", "expected", "generatedMessage"]) {
        if (expected[key] !== undefined && !util.isDeepStrictEqual(fields[key], expected[key])) {
            problems.push(key + " expected " + show(expected[key]) + ", got " + show(fields[key]));
        }
    }
    if (
        expected.messageIncludes !== undefined &&
        !String(fields.message).includes(expected.messageIncludes)
    ) {
        problems.push(
            "message " + show(fields.message) + " lacks " + show(expected.messageIncludes),
        );
    }
    if (expected.message !== undefined && fields.message !== expected.message) {
        problems.push(
            "message expected " + show(expected.message) + ", got " + show(fields.message),
        );
    }
    if (problems.length > 0) {
        failures++;
        console.log("not ok " + label + " - " + problems.join("; "));
        return;
    }
    console.log("ok " + label);
}

// ---------------------------------------------------------------------------
// AssertionError shape and the strict namespace
// ---------------------------------------------------------------------------

const direct = new a.AssertionError({
    message: "custom",
    actual: 1,
    expected: 2,
    operator: "customOp",
});
is(direct.name, "AssertionError", "AssertionError.name");
is(direct.code, "ERR_ASSERTION", "AssertionError.code");
is(direct.actual, 1, "AssertionError.actual");
is(direct.expected, 2, "AssertionError.expected");
is(direct.operator, "customOp", "AssertionError.operator");
is(direct.generatedMessage, false, "AssertionError.generatedMessage with message");
is(direct.message, "custom", "AssertionError.message");

const generated = new a.AssertionError({
    actual: 1,
    expected: 2,
    operator: "strictEqual",
});
is(
    generated.message,
    "Expected values to be strictly equal:\n\n1 !== 2\n",
    "AssertionError generates strictEqual message",
);
is(generated.generatedMessage, true, "AssertionError marks a generated message");

is(a.strict.equal, a.strict.strictEqual, "strict.equal aliases strictEqual");
is(a.strict.equal, a.strictEqual, "strict.equal is assert.strictEqual");
is(a.strict.notEqual, a.strict.notStrictEqual, "strict.notEqual aliases notStrictEqual");
is(a.strict.deepEqual, a.strict.deepStrictEqual, "strict.deepEqual aliases deepStrictEqual");
is(a.strict.strict, a.strict, "strict.strict is itself");
is(a.strict.ok, a.ok, "strict.ok is assert.ok");
is(a.strict.AssertionError, a.AssertionError, "strict.AssertionError");
is(typeof a.strict, "function", "assert.strict is callable");
is(a.ok(true), undefined, "ok returns undefined");
is(
    a.throws(() => {
        throw new Error("x");
    }),
    undefined,
    "throws returns undefined",
);
is(
    a.doesNotThrow(() => 1),
    undefined,
    "doesNotThrow returns undefined",
);

// ---------------------------------------------------------------------------
// ok / assert()
// ---------------------------------------------------------------------------

passes(() => a(true), "ok(true) passes");
passes(() => a.ok(1), "ok(1) passes");
passes(() => a.strict(true), "strict(true) passes");
passes(() => a(true), "assert(true) passes (callable default)");

fails(
    () => a.ok(false),
    {
        operator: "==",
        actual: false,
        expected: true,
        generatedMessage: true,
        messageIncludes: "falsy",
    },
    "ok(false) fails with an AssertionError",
);
fails(
    () => a.ok(false, "custom message"),
    {
        message: "custom message",
        generatedMessage: false,
        operator: "==",
    },
    "ok(false, message) uses the custom message",
);
fails(
    () => a.ok(),
    {
        operator: "==",
        expected: true,
        generatedMessage: true,
        messageIncludes: "No value argument passed",
    },
    "ok() without a value fails",
);
fails(
    () => a.strict(false),
    {
        operator: "==",
        actual: false,
        expected: true,
    },
    "strict(false) fails",
);
fails(
    () => a(false),
    {
        operator: "==",
        actual: false,
        expected: true,
    },
    "assert(false) fails",
);

// ---------------------------------------------------------------------------
// equal / notEqual / strictEqual / notStrictEqual
// ---------------------------------------------------------------------------

passes(() => a.equal(1, "1"), "equal performs loose comparison");
passes(() => a.equal(NaN, NaN), "equal treats NaN as equal to NaN");
passes(() => a.equal(null, undefined), "equal treats null == undefined");
fails(
    () => a.equal(1, 2),
    {
        operator: "==",
        actual: 1,
        expected: 2,
        message: "1 == 2",
    },
    "equal fails with operator ==",
);

passes(() => a.notEqual(1, 2), "notEqual passes for different values");
fails(
    () => a.notEqual(1, "1"),
    {
        operator: "!=",
        actual: 1,
        expected: "1",
        message: "1 != '1'",
    },
    "notEqual fails for loosely equal values",
);
fails(() => a.notEqual(NaN, NaN), { operator: "!=" }, "notEqual fails for NaN/NaN");

passes(() => a.strictEqual(1, 1), "strictEqual passes identical values");
fails(
    () => a.strictEqual(1, 2),
    {
        operator: "strictEqual",
        actual: 1,
        expected: 2,
        message: "Expected values to be strictly equal:\n\n1 !== 2\n",
    },
    "strictEqual fails with operator strictEqual",
);
passes(() => a.strictEqual(NaN, NaN), "strictEqual treats NaN as identical (Object.is)");
fails(
    () => a.strictEqual(NaN, 0),
    { operator: "strictEqual" },
    "strictEqual distinguishes NaN from a number",
);
fails(() => a.strictEqual(0, -0), { operator: "strictEqual" }, "strictEqual distinguishes -0");
fails(
    () => a.strictEqual({ a: 1 }, { a: 1 }),
    {
        operator: "strictEqual",
        messageIncludes: "reference-equal",
    },
    "strictEqual compares objects by identity",
);

passes(() => a.notStrictEqual(1, "1"), "notStrictEqual passes for different types");
fails(
    () => a.notStrictEqual(1, 1),
    {
        operator: "notStrictEqual",
        actual: 1,
        expected: 1,
        message: 'Expected "actual" to be strictly unequal to: 1',
    },
    "notStrictEqual fails with operator notStrictEqual",
);

// ---------------------------------------------------------------------------
// deepEqual / notDeepEqual / deepStrictEqual / notDeepStrictEqual
// ---------------------------------------------------------------------------

passes(() => a.deepEqual({ a: 1 }, { a: "1" }), "deepEqual is loose");
passes(() => a.deepEqual([1, 2], ["1", "2"]), "deepEqual is loose inside arrays");
passes(() => a.deepEqual(Object.create({ x: 1 }), {}), "deepEqual ignores prototypes");
passes(() => a.deepEqual(new Set([1]), new Set(["1"])), "deepEqual is loose for Set membership");
fails(
    () => a.deepEqual({ a: 1 }, { a: 2 }),
    {
        operator: "deepEqual",
        actual: { a: 1 },
        expected: { a: 2 },
        messageIncludes: "loosely deep-equal",
    },
    "deepEqual fails with operator deepEqual",
);

passes(() => a.notDeepEqual({ a: 1 }, { a: 2 }), "notDeepEqual passes for unequal values");
fails(
    () => a.notDeepEqual({ a: 1 }, { a: "1" }),
    {
        operator: "notDeepEqual",
    },
    "notDeepEqual fails for loosely equal values",
);

passes(
    () => a.deepStrictEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }),
    "deepStrictEqual nested values",
);
passes(
    () => a.deepStrictEqual(new Map([[1, { a: 2 }]]), new Map([[1, { a: 2 }]])),
    "deepStrictEqual Map",
);
passes(
    () => a.deepStrictEqual(new Set([1, 2]), new Set([2, 1])),
    "deepStrictEqual Set order-insensitive",
);
passes(
    () => a.deepStrictEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])),
    "deepStrictEqual typed arrays",
);
passes(() => a.deepStrictEqual(new Date(NaN), new Date(NaN)), "deepStrictEqual invalid dates");
passes(() => a.deepStrictEqual(/a/g, /a/g), "deepStrictEqual RegExp");
passes(() => a.deepStrictEqual(NaN, NaN), "deepStrictEqual NaN");
const deepCycleA = {};
deepCycleA.self = deepCycleA;
const deepCycleB = {};
deepCycleB.self = deepCycleB;
passes(() => a.deepStrictEqual(deepCycleA, deepCycleB), "deepStrictEqual cycles");
fails(
    () => a.deepStrictEqual(-0, 0),
    { operator: "deepStrictEqual" },
    "deepStrictEqual distinguishes -0",
);
fails(
    () => a.deepStrictEqual(new Uint8Array([1]), new Int8Array([1])),
    {
        operator: "deepStrictEqual",
    },
    "deepStrictEqual typed array kinds",
);
fails(
    () => a.deepStrictEqual(new TypeError("x"), new Error("x")),
    {
        operator: "deepStrictEqual",
    },
    "deepStrictEqual error kinds",
);
fails(
    () => a.deepStrictEqual(Object.assign(Object.create(null), { a: 1 }), { a: 1 }),
    {
        operator: "deepStrictEqual",
    },
    "deepStrictEqual null prototype",
);
fails(
    () => a.deepStrictEqual({ a: 1 }, { a: 2 }),
    {
        operator: "deepStrictEqual",
        actual: { a: 1 },
        expected: { a: 2 },
        messageIncludes: "strictly deep-equal",
    },
    "deepStrictEqual fails with operator deepStrictEqual",
);
fails(
    () => a.deepStrictEqual(1, 2),
    {
        message: "Expected values to be strictly deep-equal:\n\n1 !== 2\n",
    },
    "deepStrictEqual generated scalar message",
);

passes(
    () => a.notDeepStrictEqual({ a: 1 }, { a: 2 }),
    "notDeepStrictEqual passes for unequal values",
);
fails(
    () => a.notDeepStrictEqual({ a: 1 }, { a: 1 }),
    {
        operator: "notDeepStrictEqual",
        messageIncludes: "not to be strictly deep-equal",
    },
    "notDeepStrictEqual fails for equal values",
);

// assert.deepStrictEqual agrees with util.isDeepStrictEqual.
const agreementTable = [
    [NaN, NaN],
    [0, -0],
    [{ a: 1 }, { a: 1 }],
    [
        [1, 2],
        [1, 2],
    ],
    [new Map([[1, 2]]), new Map([[1, 2]])],
    [new Set([1, 2]), new Set([2, 1])],
    [new Date(0), new Date(0)],
    [/a/g, /a/g],
    [new Uint8Array([1]), new Uint8Array([1])],
    [Object.assign(Object.create(null), { a: 1 }), Object.assign(Object.create(null), { a: 1 })],
];
for (let i = 0; i < agreementTable.length; i++) {
    const [left, right] = agreementTable[i];
    const expected = util.isDeepStrictEqual(left, right);
    checks++;
    let matches;
    try {
        a.deepStrictEqual(left, right);
        matches = true;
    } catch {
        matches = false;
    }
    if (matches === expected) {
        console.log("ok deepStrictEqual agrees with isDeepStrictEqual #" + i);
    } else {
        failures++;
        console.log("not ok deepStrictEqual agrees with isDeepStrictEqual #" + i);
    }
}

// ---------------------------------------------------------------------------
// fail / ifError / match / doesNotMatch
// ---------------------------------------------------------------------------

fails(
    () => a.fail("boom"),
    {
        operator: "fail",
        generatedMessage: false,
        message: "boom",
    },
    "fail(message)",
);
fails(
    () => a.fail(),
    {
        operator: "fail",
        generatedMessage: true,
        message: "Failed",
    },
    "fail() without a message",
);
passes(() => {
    const original = new TypeError("original");
    try {
        a.fail(original);
    } catch (error) {
        if (error !== original) throw new Error("fail(Error) did not rethrow");
        return;
    }
    throw new Error("fail(Error) did not throw");
}, "fail(Error) rethrows the original error");

passes(() => a.ifError(null), "ifError(null) passes");
passes(() => a.ifError(undefined), "ifError(undefined) passes");
fails(
    () => a.ifError(new Error("io")),
    {
        operator: "ifError",
        expected: null,
        generatedMessage: false,
        message: "ifError got unwanted exception: io",
    },
    "ifError(Error) fails with operator ifError",
);
fails(
    () => a.ifError("str"),
    {
        operator: "ifError",
        actual: "str",
        messageIncludes: "unwanted exception",
    },
    "ifError(string) fails",
);

passes(() => a.match("abc", /b/), "match passes when the pattern matches");
fails(
    () => a.match("abc", /z/),
    {
        operator: "match",
        actual: "abc",
        messageIncludes: "did not match the regular expression",
    },
    "match fails with operator match",
);
fails(
    () => a.match("abc", "b"),
    {
        name: "TypeError",
        code: "ERR_INVALID_ARG_TYPE",
        assertionError: false,
    },
    "match validates the RegExp argument",
);

passes(() => a.doesNotMatch("abc", /z/), "doesNotMatch passes for a non-match");
fails(
    () => a.doesNotMatch("abc", /b/),
    {
        operator: "doesNotMatch",
        actual: "abc",
        messageIncludes: "expected to not match",
    },
    "doesNotMatch fails with operator doesNotMatch",
);

// ---------------------------------------------------------------------------
// throws / doesNotThrow
// ---------------------------------------------------------------------------

passes(
    () =>
        a.throws(() => {
            throw new Error("x");
        }),
    "throws passes when anything is thrown",
);
passes(
    () =>
        a.throws(() => {
            throw new TypeError("x");
        }, TypeError),
    "throws passes for a matching constructor",
);
passes(
    () =>
        a.throws(() => {
            throw new Error("boom");
        }, /boo/),
    "throws passes for a matching RegExp",
);
passes(
    () =>
        a.throws(
            () => {
                const e = new Error("x");
                e.code = "E";
                throw e;
            },
            { code: "E" },
        ),
    "throws passes for a matching validation object",
);
passes(
    () =>
        a.throws(
            () => {
                throw new Error("x");
            },
            (e) => e.message === "x",
        ),
    "throws passes for a returning-true validation function",
);
passes(
    () =>
        a.throws(() => {
            throw new Error("x");
        }, "custom message"),
    "throws accepts a message with no expected error",
);

fails(
    () =>
        a.throws(() => {
            throw new Error("x");
        }, TypeError),
    {
        operator: "throws",
        expected: TypeError,
        generatedMessage: true,
        messageIncludes: 'instance of "TypeError"',
    },
    "throws fails for a mismatched constructor",
);
fails(
    () =>
        a.throws(() => {
            throw new Error("x");
        }, /y/),
    {
        operator: "throws",
        generatedMessage: true,
        messageIncludes: "did not match the regular expression",
    },
    "throws fails for a mismatched RegExp",
);
fails(
    () => a.throws(() => {}, Error),
    {
        operator: "throws",
        generatedMessage: false,
        messageIncludes: "Missing expected exception",
    },
    "throws fails when nothing is thrown",
);
fails(
    () => a.throws(() => {}, "m"),
    {
        operator: "throws",
        messageIncludes: "Missing expected exception: m",
    },
    "throws reports a custom missing-exception message",
);
fails(
    () => a.throws(1),
    {
        name: "TypeError",
        code: "ERR_INVALID_ARG_TYPE",
        assertionError: false,
    },
    "throws validates the function argument",
);
fails(
    () =>
        a.throws(() => {
            throw new Error("x");
        }, {}),
    {
        name: "TypeError",
        code: "ERR_INVALID_ARG_VALUE",
        assertionError: false,
    },
    "throws rejects an empty validation object",
);

passes(() => a.doesNotThrow(() => 5), "doesNotThrow passes when nothing is thrown");
fails(
    () =>
        a.doesNotThrow(() => {
            throw new TypeError("d");
        }, TypeError),
    {
        operator: "doesNotThrow",
        messageIncludes: "Got unwanted exception",
    },
    "doesNotThrow fails when the error matches the expected type",
);
fails(
    () =>
        a.doesNotThrow(() => {
            throw new Error("d");
        }),
    {
        operator: "doesNotThrow",
        generatedMessage: false,
        messageIncludes: "Got unwanted exception",
    },
    "doesNotThrow fails with operator doesNotThrow",
);
checks++;
try {
    const original = new Error("d");
    try {
        a.doesNotThrow(() => {
            throw original;
        }, TypeError);
    } catch (error) {
        if (error === original) {
            console.log("ok doesNotThrow rethrows a non-matching error");
        } else {
            failures++;
            console.log("not ok doesNotThrow rethrows a non-matching error");
        }
        throw { handled: true };
    }
} catch (marker) {
    if (!marker || !marker.handled) {
        failures++;
        console.log("not ok doesNotThrow rethrows a non-matching error");
    }
}

// ---------------------------------------------------------------------------
// rejects / doesNotReject (async)
// ---------------------------------------------------------------------------

async function asyncChecks() {
    const run = async (fn, label, expected) => {
        checks++;
        let error;
        try {
            await fn();
        } catch (caught) {
            error = caught;
        }
        if (expected === "pass") {
            if (error === undefined) {
                console.log("ok " + label);
            } else {
                failures++;
                console.log(
                    "not ok " +
                        label +
                        " - threw " +
                        (error && error.name) +
                        ": " +
                        (error && error.message),
                );
            }
            return;
        }
        if (error === undefined) {
            failures++;
            console.log("not ok " + label + " - did not reject");
            return;
        }
        const problems = [];
        if (expected.assertionError !== false && !(error instanceof a.AssertionError)) {
            problems.push("not an AssertionError");
        }
        for (const key of ["name", "code", "operator"]) {
            if (expected[key] !== undefined && error[key] !== expected[key]) {
                problems.push(
                    key + " expected " + show(expected[key]) + ", got " + show(error[key]),
                );
            }
        }
        if (expected.messageIncludes && !String(error.message).includes(expected.messageIncludes)) {
            problems.push(
                "message " + show(error.message) + " lacks " + show(expected.messageIncludes),
            );
        }
        if (problems.length > 0) {
            failures++;
            console.log("not ok " + label + " - " + problems.join("; "));
            return;
        }
        console.log("ok " + label);
    };

    await run(
        () => a.rejects(Promise.reject(new Error("r"))),
        "rejects passes for a rejected promise",
        "pass",
    );
    await run(
        () =>
            a.rejects(async () => {
                throw new Error("r");
            }),
        "rejects passes for an async function",
        "pass",
    );
    await run(
        () => a.rejects(Promise.reject(new TypeError("r")), TypeError),
        "rejects accepts a constructor",
        "pass",
    );
    await run(() => a.rejects(Promise.resolve(1)), "rejects fails when the promise resolves", {
        operator: "rejects",
        messageIncludes: "Missing expected rejection",
    });
    await run(
        () => a.rejects(Promise.reject(new Error("r")), TypeError),
        "rejects fails for a mismatched constructor",
        { operator: "rejects" },
    );
    await run(() => a.rejects(() => 5), "rejects requires a promise return value", {
        name: "TypeError",
        code: "ERR_INVALID_RETURN_VALUE",
        assertionError: false,
    });
    await run(() => a.rejects(5), "rejects validates its argument", {
        name: "TypeError",
        code: "ERR_INVALID_ARG_TYPE",
        assertionError: false,
    });
    await run(
        () => a.doesNotReject(Promise.resolve(1)),
        "doesNotReject passes for a resolved promise",
        "pass",
    );
    await run(
        () => a.doesNotReject(Promise.reject(new Error("z"))),
        "doesNotReject fails for a rejected promise",
        { operator: "doesNotReject", messageIncludes: "Got unwanted rejection" },
    );
}

// ---------------------------------------------------------------------------
// Argument validation and messages
// ---------------------------------------------------------------------------

fails(
    () => a.strictEqual(1),
    {
        name: "TypeError",
        code: "ERR_MISSING_ARGS",
        assertionError: false,
    },
    "strictEqual requires two arguments",
);
fails(
    () => a.deepStrictEqual(),
    {
        name: "TypeError",
        code: "ERR_MISSING_ARGS",
        assertionError: false,
    },
    "deepStrictEqual requires two arguments",
);
fails(
    () => a.ok(false, 5),
    {
        name: "TypeError",
        code: "ERR_INVALID_ARG_TYPE",
        assertionError: false,
    },
    "ok validates a non-string message",
);
fails(
    () => a.deepStrictEqual(1, 2, () => "from function"),
    {
        message: "from function\n\n1 !== 2\n",
        generatedMessage: false,
        operator: "deepStrictEqual",
    },
    "deepStrictEqual accepts a message function",
);

asyncChecks()
    .catch((error) => {
        failures++;
        console.log("not ok async checks threw - " + (error && error.stack));
    })
    .then(() => {
        console.log("");
        console.log(`assert.test: ${checks - failures}/${checks} checks passed`);
        if (failures > 0) {
            if (typeof process !== "undefined" && process && typeof process.exit === "function") {
                process.exit(1);
            } else {
                throw new Error(`${failures} assert.test assertion(s) failed`);
            }
        }
    });
