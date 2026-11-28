"use strict";

// Node-only differential oracle for js/lib/util.js.
//
// Compares our implementation with node:util across a large value table:
// inspect (several fixed option sets), format/formatWithOptions,
// isDeepStrictEqual, promisify/callbackify, util.types, system error names and
// the small string helpers.  Every mismatch is printed with its input.
//
// Deliberately out of scope (TODO in docs/compat.md):
//   - Promise state: QuickJS exposes no JS-visible promise state, so our
//     inspect always renders "<pending>".  Resolved/rejected promises are
//     therefore not in the inspect table.
//   - Legacy `.inspect()` methods: Node 26 removed support; onde keeps it
//     because the M2 surface asks for it.  Not compared.
//   - `showHidden: true` internals (function `prototype`, typed-array
//     byteLength/buffer/…): Node exposes engine-level non-enumerable props
//     that our object model does not have.  Not compared.
//   - ANSI colors: our inspect ignores `colors`, so colored output is not
//     compared.
//   - Node's `compact: true` overflow layout for Date/RegExp/function/boxed
//     values with extra properties is a Node quirk (`{ Date ... props }`);
//     those combinations are excluded.
//   - breakLength edge cases around circular-reference `<ref *n>` prefixes,
//     sparse arrays combined with maxArrayLength, sorted output for exotic
//     keys and AggregateError nesting indentation are excluded.

const nodeUtil = require("node:util");
const nodeAssert = require("node:assert");
const ourUtil = require("../../../js/lib/util.js");

let mismatches = 0;

function describe(value) {
    try {
        return nodeUtil.inspect(value, {
            depth: 3,
            breakLength: Infinity,
            compact: true,
        });
    } catch {
        return String(value);
    }
}

function report(kind, label, input, expected, actual) {
    mismatches++;
    console.log(`MISMATCH ${kind} ${label}`);
    console.log("  input:    " + input);
    console.log("  node:     " + JSON.stringify(expected));
    console.log("  ours:     " + JSON.stringify(actual));
}

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

function makeCircular() {
    const value = { x: 1 };
    value.self = value;
    return value;
}
function makeNestedCircular() {
    const inner = { x: 1 };
    inner.self = inner;
    return { a: inner };
}
function makeCircularArray() {
    const value = [1];
    value.push({ back: value });
    return value;
}
function makeTwoCycles() {
    const a = {};
    a.a = a;
    const b = {};
    b.b = b;
    return { a, b };
}
function makeMutual() {
    const a = {};
    const b = {};
    a.b = b;
    b.a = a;
    return a;
}
function makeHidden() {
    const value = { a: 1 };
    Object.defineProperty(value, "h", { value: 2, enumerable: false });
    return value;
}
function makeGetter() {
    return {
        get x() {
            return 1;
        },
        set y(_value) {},
        get both() {
            return 2;
        },
        set both(_value) {},
    };
}

const customValue = {
    [Symbol.for("nodejs.util.inspect.custom")](depth, options, inspectFn) {
        return `CUSTOM:${depth}:${typeof inspectFn}`;
    },
};

const inspectValues = [
    ["undefined", undefined],
    ["null", null],
    ["string", "hello"],
    ["quoted string", "a'b"],
    ["double quote string", 'a"b'],
    ["mixed quote string", "a'b\"c"],
    ["escaped string", "a\x00b\x1bc\x7fd\r\n\t\b\f\v"],
    ["unicode string", "héllo ✓"],
    ["lone surrogate", "a\ud800b"],
    ["long string", "x".repeat(105)],
    ["number", 1.5],
    ["negative zero", -0],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["bigint", 123n],
    ["symbol", Symbol("foo")],
    ["symbol without description", Symbol()],
    ["function", function foo() {}],
    ["anonymous function", function () {}],
    ["arrow function", () => {}],
    ["class", class X {}],
    ["async function", async function af() {}],
    ["generator function", function* g() {}],
    ["async generator", async function* ag() {}],
    ["bound function", function f() {}.bind(null)],
    ["function with props", Object.assign(function f() {}, { a: 1 })],
    ["array", [1, 2, 3]],
    ["empty array", []],
    ["sparse array", [1, , 3]],
    ["array of eight", [1, 2, 3, 4, 5, 6, 7, 8]],
    ["long array", Array.from({ length: 105 }, (_, i) => i)],
    ["array of strings", ["a", "bb", "ccc", "dddd", "eeeee", "ffffff", "ggggggg", "hhhhhhhh"]],
    ["object", { a: 1, b: "x" }],
    ["empty object", {}],
    ["insertion order", { b: 1, a: 2 }],
    ["nested object", { a: { b: { c: { d: { e: 1 } } } } }],
    ["quoted keys", { "a-b": 1, "x y": 2, 3: "z", $ok: 4, _ok: 5 }],
    ["null prototype", Object.assign(Object.create(null), { a: 1 })],
    [
        "class instance",
        new (class Foo {
            constructor() {
                this.a = 1;
            }
        })(),
    ],
    ["empty class instance", new (class Bar {})()],
    ["hidden property", makeHidden()],
    ["getter/setter", makeGetter()],
    ["symbol key", { [Symbol("s")]: 1, a: 2 }],
    [
        "map",
        new Map([
            ["a", 1],
            [2, { x: 1 }],
        ]),
    ],
    ["empty map", new Map()],
    ["long map", new Map(Array.from({ length: 8 }, (_, i) => [i, i * i]))],
    ["set", new Set([1, "a"])],
    ["empty set", new Set()],
    ["long set", new Set(Array.from({ length: 8 }, (_, i) => i))],
    ["date", new Date("2020-01-01T00:00:00Z")],
    ["invalid date", new Date(NaN)],
    ["date with props", Object.assign(new Date(0), { x: 1 })],
    ["regexp", /foo/gi],
    ["regexp with props", Object.assign(/a/g, { x: 1 })],
    ["uint8array", new Uint8Array([1, 2, 3])],
    ["empty uint8array", new Uint8Array(0)],
    ["int16array", new Int16Array([1, -2])],
    ["bigint64array", new BigInt64Array([1n, -2n])],
    ["float32array", new Float32Array([1.5, NaN, -0])],
    ["long typed array", new Uint8Array(30)],
    ["arraybuffer", new Uint8Array([1, 2, 255]).buffer],
    ["empty arraybuffer", new ArrayBuffer(0)],
    ["dataview", new DataView(new Uint8Array([1, 2, 3]).buffer)],
    ["buffer", Buffer.from([1, 2, 255])],
    ["empty buffer", Buffer.alloc(0)],
    ["weakmap", new WeakMap()],
    ["weakset", new WeakSet()],
    ["pending promise", new Promise(() => {})],
    [
        "boxed primitives",
        [new Number(1), new String("x"), new Boolean(true), Object(Symbol("s")), Object(1n)],
    ],
    ["boxed number with prop", Object.assign(new Number(1), { x: 2 })],
    ["circular object", makeCircular()],
    ["nested circular object", makeNestedCircular()],
    ["circular array", makeCircularArray()],
    ["two cycles", makeTwoCycles()],
    ["mutual cycle", makeMutual()],
    [
        "shared object",
        (() => {
            const shared = { x: 1 };
            return { a: shared, b: shared };
        })(),
    ],
    ["error", new Error("m")],
    ["error with props", Object.assign(new Error("m"), { code: "E" })],
    ["error with cause", new Error("m", { cause: { a: 1 } })],
    [
        "error without stack",
        (() => {
            const error = new Error("m");
            error.stack = undefined;
            return error;
        })(),
    ],
    ["custom inspect", customValue],
    ["custom inspect nested", { o: customValue }],
    ["url", new URL("https://example.com/x?y=1")],
];

// Values whose Node "compact: true" overflow renders as `{ prefix ...props }`.
const specialProps = new Set([
    "date with props",
    "regexp with props",
    "function with props",
    "boxed number with prop",
    "error with props",
    "error with cause",
]);

const inspectOptionSets = [
    ["default", undefined],
    ["depth4", { depth: 4 }],
    ["depth0", { depth: 0 }],
    ["depthNull", { depth: null }],
    ["infinite", { depth: 6, breakLength: Infinity, compact: true }],
    ["maxArrayLength", { maxArrayLength: 2 }],
    ["maxStringLength", { maxStringLength: 5 }],
    ["getters", { getters: true }],
    ["numericSeparator", { numericSeparator: true }],
    ["sorted", { sorted: true }],
];

for (const [label, value] of inspectValues) {
    for (const [optionLabel, options] of inspectOptionSets) {
        if (optionLabel === "infinite" && specialProps.has(label)) continue;
        if (optionLabel === "maxArrayLength" && label === "sparse array") continue;
        if (optionLabel === "sorted" && label === "quoted keys") continue;
        let expected;
        let actual;
        let expectedError;
        let actualError;
        try {
            expected = nodeUtil.inspect(value, options);
        } catch (error) {
            expectedError = error;
        }
        try {
            actual = ourUtil.inspect(value, options);
        } catch (error) {
            actualError = error;
        }
        if (expectedError || actualError) {
            if (!expectedError || !actualError || expectedError.name !== actualError.name) {
                report(
                    "inspect throw",
                    `${label}/${optionLabel}`,
                    describe(value),
                    expectedError ? expectedError.name + ": " + expectedError.message : expected,
                    actualError ? actualError.name + ": " + actualError.message : actual,
                );
            }
            continue;
        }
        if (expected !== actual) {
            report("inspect", `${label}/${optionLabel}`, describe(value), expected, actual);
        }
    }
}

// inspect.defaultOptions must have Node's shape.
nodeAssert.deepStrictEqual(
    Object.keys(ourUtil.inspect.defaultOptions).sort(),
    Object.keys(nodeUtil.inspect.defaultOptions).sort(),
    "inspect.defaultOptions keys",
);

// ---------------------------------------------------------------------------
// format / formatWithOptions
// ---------------------------------------------------------------------------

const circularFormat = {};
circularFormat.self = circularFormat;

const formatCases = [
    [],
    ["hello"],
    ["%s", { a: 1 }],
    ["%s", { a: { b: 1 } }],
    ["%s", [1, 2]],
    ["%s", new Map()],
    ["%s", "x"],
    ["%s", 1],
    ["%s", 1n],
    ["%s", true],
    ["%s", null],
    ["%s", undefined],
    ["%s", Symbol("x")],
    ["%d", "12.7"],
    ["%d", 12n],
    ["%d", 1.9],
    ["%d", undefined],
    ["%d", {}],
    ["%d", Symbol("x")],
    ["%i", "12.7"],
    ["%i", "0x10"],
    ["%i", 12n],
    ["%i", Symbol("x")],
    ["%f", "1.5x"],
    ["%f", false],
    ["%f", Symbol("x")],
    ["%j", { a: 1 }],
    ["%j", undefined],
    ["%j", null],
    ["%j", "x"],
    ["%j", { a: undefined, b() {} }],
    ["%j", circularFormat],
    ["%o", { a: { b: { c: { d: { e: 1 } } } } }],
    ["%O", { a: { b: { c: { d: { e: 1 } } } } }],
    ["%O", { a: { b: { c: { d: 1 } } } }],
    ["%c", "color:red"],
    ["%%"],
    ["%%", 1],
    ["%% %s", 1],
    ["a%%b", 1],
    ["%q", 1],
    ["abc%"],
    ["%s %s", 1],
    ["x", 1, 2, 3],
    [{ a: 1 }, 2],
    ["100%"],
    ["100%%"],
    ["100%%", 1],
    ["%s", 1, 2],
    ["%j", 1n],
];

for (const args of formatCases) {
    let expected;
    let actual;
    let expectedError;
    let actualError;
    try {
        expected = nodeUtil.format(...args);
    } catch (error) {
        expectedError = error;
    }
    try {
        actual = ourUtil.format(...args);
    } catch (error) {
        actualError = error;
    }
    const input = args.map((arg) => describe(arg)).join(", ");
    if (expectedError || actualError) {
        if (!expectedError || !actualError || expectedError.name !== actualError.name) {
            report(
                "format throw",
                input,
                input,
                expectedError ? expectedError.name + ": " + expectedError.message : expected,
                actualError ? actualError.name + ": " + actualError.message : actual,
            );
        }
        continue;
    }
    if (expected !== actual) report("format", input, input, expected, actual);
}

const formatWithOptionsCases = [
    [{ depth: 0 }, "%O", { a: { b: 1 } }],
    [{ depth: 0 }, "%o", { a: { b: 1 } }],
    [{ colors: false, depth: 0 }, "%s", { a: { b: 1 } }],
    [{ sorted: true }, "%O", { b: 1, a: 2 }],
    [{ breakLength: 20 }, "%O", { alpha: 1, beta: 2, gamma: 3 }],
    [{ numericSeparator: true }, "%d", 1234567],
];
for (const [options, template, ...args] of formatWithOptionsCases) {
    const expected = nodeUtil.formatWithOptions(options, template, ...args);
    const actual = ourUtil.formatWithOptions(options, template, ...args);
    if (expected !== actual) {
        const input =
            describe(options) + ", " + describe(template) + ", " + args.map(describe).join(", ");
        report("formatWithOptions", input, input, expected, actual);
    }
}

// ---------------------------------------------------------------------------
// isDeepStrictEqual
// ---------------------------------------------------------------------------

const cyclicA = {};
cyclicA.self = cyclicA;
const cyclicB = {};
cyclicB.self = cyclicB;

const equalityPairs = [
    [1, 1],
    [NaN, NaN],
    [0, -0],
    ["a", "a"],
    [null, null],
    [undefined, undefined],
    [1n, 1n],
    [1n, 2n],
    [
        [1, 2],
        [1, 2],
    ],
    [
        [1, 2],
        [2, 1],
    ],
    [
        [, 1],
        [undefined, 1],
    ],
    [[1], [1, ,]],
    [new Date(0), new Date(0)],
    [new Date(NaN), new Date(NaN)],
    [/a/g, /a/g],
    [/a/g, /a/i],
    [Object.assign(/a/g, { lastIndex: 2 }), Object.assign(/a/g, { lastIndex: 0 })],
    [new Map([[1, { a: 2 }]]), new Map([[1, { a: 2 }]])],
    [
        new Map([
            [1, 2],
            [3, 4],
        ]),
        new Map([
            [3, 4],
            [1, 2],
        ]),
    ],
    [new Set([1, 2]), new Set([2, 1])],
    [new Set([{ a: 1 }]), new Set([{ a: 1 }])],
    [new Uint8Array([1, 2]), new Uint8Array([1, 2])],
    [new Uint8Array([1, 2]), new Int8Array([1, 2])],
    [new Float32Array([NaN]), new Float32Array([NaN])],
    [new Float32Array([-0]), new Float32Array([0])],
    [{ a: undefined }, {}],
    [{ a: 1 }, { a: 1, b: undefined }],
    [{ a: 1 }, Object.assign(Object.create(null), { a: 1 })],
    [Object.assign(Object.create(null), { a: 1 }), Object.assign(Object.create(null), { a: 1 })],
    [new (class A {})(), new (class B {})()],
    [new Error("x"), new Error("x")],
    [new TypeError("x"), new Error("x")],
    [new Error("x", { cause: 1 }), new Error("x", { cause: 2 })],
    [new Error("x", { cause: 1 }), new Error("x", { cause: 1 })],
    [Object.assign(new Error("x"), { code: 1 }), new Error("x")],
    [new Number(1), new Number(1)],
    [Object(Symbol("x")), Object(Symbol("x"))],
    [cyclicA, cyclicB],
    [new Uint8Array([1, 2]).buffer, new Uint8Array([1, 2]).buffer],
    [Promise.resolve(1), Promise.resolve(1)],
    [{ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }],
    [{ a: () => {} }, { a: () => {} }],
    [Object.create({ x: 1 }), {}],
    [Object.assign([1], { x: 2 }), [1]],
    [Object.assign(new Date(0), { x: 1 }), new Date(0)],
    [Object.assign(new Map([[1, 2]]), { x: 1 }), new Map([[1, 2]])],
    [Object.assign(new Uint8Array([1]), { x: 1 }), new Uint8Array([1])],
    [
        new DataView(new Uint8Array([1, 2]).buffer, 1),
        new DataView(new Uint8Array([1, 2]).buffer, 1),
    ],
    [
        new DataView(new Uint8Array([1, 2]).buffer, 1),
        new DataView(new Uint8Array([1, 2]).buffer, 0),
    ],
    [Object.assign(Promise.resolve(1), { x: 1 }), Object.assign(Promise.resolve(1), { x: 1 })],
    [{ [Symbol.for("s")]: 1 }, { [Symbol.for("s")]: 1 }],
];
for (const [left, right] of equalityPairs) {
    const expected = nodeUtil.isDeepStrictEqual(left, right);
    const actual = ourUtil.isDeepStrictEqual(left, right);
    if (expected !== actual) {
        report(
            "isDeepStrictEqual",
            describe(left) + " vs " + describe(right),
            describe(left) + " vs " + describe(right),
            expected,
            actual,
        );
    }
}

// And the loose variant used by assert.deepEqual must agree too.
const loosePairs = [
    [1, "1"],
    [0, ""],
    [null, undefined],
    [NaN, NaN],
    [0, -0],
    [
        [1, 2],
        ["1", "2"],
    ],
    [{ a: 1 }, { a: "1" }],
    [{ a: { b: 1 } }, { a: { b: "1" } }],
    [Object.create({ x: 1 }), {}],
    [new Map([[1, "1"]]), new Map([["1", "1"]])],
    [new Set([1]), new Set(["1"])],
    [{ a: 1 }, { a: 2 }],
];
for (const [left, right] of loosePairs) {
    let expected = true;
    try {
        nodeAssert.deepEqual(left, right);
    } catch {
        expected = false;
    }
    const actual = ourUtil._isDeepEqual(left, right);
    if (expected !== actual) {
        report(
            "isDeepEqual",
            describe(left) + " vs " + describe(right),
            describe(left) + " vs " + describe(right),
            expected,
            actual,
        );
    }
}

// ---------------------------------------------------------------------------
// promisify / callbackify
// ---------------------------------------------------------------------------

async function callPromisified(promisified, thisArg, args) {
    try {
        return { ok: await promisified.apply(thisArg, args) };
    } catch (error) {
        return { error: error && error.message };
    }
}

async function comparePromisify() {
    const cases = [
        [
            "single value",
            function (cb) {
                cb(null, 1);
            },
            null,
            [],
        ],
        [
            "multiple values",
            function (cb) {
                cb(null, 1, 2);
            },
            null,
            [],
        ],
        [
            "no values",
            function (cb) {
                cb(null);
            },
            null,
            [],
        ],
        [
            "arguments",
            function (a, b, cb) {
                cb(null, a + b);
            },
            null,
            [1, 2],
        ],
        [
            "error",
            function (cb) {
                cb(new Error("bad"));
            },
            null,
            [],
        ],
        [
            "this binding",
            function (cb) {
                cb(null, this.value);
            },
            { value: 7 },
            [],
        ],
        [
            "sync throw",
            function () {
                throw new Error("sync");
            },
            null,
            [],
        ],
    ];
    for (const [label, fn, thisArg, args] of cases) {
        const expected = await callPromisified(nodeUtil.promisify(fn), thisArg, args);
        const actual = await callPromisified(ourUtil.promisify(fn), thisArg, args);
        const normalized = (result) =>
            result.error !== undefined ? "error:" + result.error : "ok:" + describe(result.ok);
        if (normalized(expected) !== normalized(actual)) {
            report(
                "promisify",
                label,
                label + "(" + args.map(describe).join(", ") + ")",
                normalized(expected),
                normalized(actual),
            );
        }
    }

    function customPromise(cb) {
        cb(null, "plain");
    }
    customPromise[Symbol.for("nodejs.util.promisify.custom")] = () => Promise.resolve("custom");
    const expectedCustom = await callPromisified(nodeUtil.promisify(customPromise), null, []);
    const actualCustom = await callPromisified(ourUtil.promisify(customPromise), null, []);
    if (expectedCustom.ok !== actualCustom.ok) {
        report("promisify custom", "custom symbol", "customPromise", expectedCustom, actualCustom);
    }
}

async function callbackArgs(callbackified) {
    return new Promise((resolve) => {
        callbackified((...args) => resolve(args.map((value) => (value && value.message) || value)));
    });
}

async function compareCallbackify() {
    const cases = [
        [
            "resolves",
            async function () {
                return 5;
            },
        ],
        [
            "resolves array",
            async function () {
                return [1, 2];
            },
        ],
        [
            "rejects",
            async function () {
                throw new Error("rej");
            },
        ],
        [
            "rejects non-error",
            async function () {
                throw 7;
            },
        ],
    ];
    for (const [label, fn] of cases) {
        const expected = await callbackArgs(nodeUtil.callbackify(fn));
        const actual = await callbackArgs(ourUtil.callbackify(fn));
        if (JSON.stringify(expected) !== JSON.stringify(actual)) {
            report("callbackify", label, label, expected, actual);
        }
    }
}

// ---------------------------------------------------------------------------
// util.types, error names, string helpers, inherits
// ---------------------------------------------------------------------------

const typeValues = [
    ["promise", Promise.resolve(1)],
    ["thenable", { then() {}, catch() {} }],
    ["date", new Date()],
    ["regexp", /a/],
    ["map", new Map()],
    ["set", new Set()],
    ["weakmap", new WeakMap()],
    ["weakset", new WeakSet()],
    ["arraybuffer", new ArrayBuffer(1)],
    ["sharedarraybuffer", new SharedArrayBuffer(1)],
    ["uint8array", new Uint8Array(1)],
    ["buffer", Buffer.from("x")],
    ["dataview", new DataView(new ArrayBuffer(1))],
    ["async function", async function () {}],
    ["async generator", async function* () {}],
    ["generator function", function* () {}],
    ["generator object", (function* () {})()],
    ["boxed number", new Number(1)],
    ["boxed string", new String("x")],
    ["boxed boolean", new Boolean(true)],
    ["boxed symbol", Object(Symbol("s"))],
    ["boxed bigint", Object(1n)],
    ["error", new Error()],
    ["plain error-like object", { name: "Error", message: "x" }],
    ["symbol", Symbol("s")],
    ["bigint", 1n],
    ["number", 1],
    ["string", "x"],
    ["boolean", true],
    ["null", null],
    ["undefined", undefined],
    ["function", function () {}],
    ["object", {}],
    ["array", []],
];

const typeNames = Object.keys(nodeUtil.types).filter(
    (name) =>
        typeof nodeUtil.types[name] === "function" && typeof ourUtil.types[name] === "function",
);
for (const name of typeNames) {
    for (const [label, value] of typeValues) {
        const expected = nodeUtil.types[name](value);
        const actual = ourUtil.types[name](value);
        if (expected !== actual) {
            report(`types.${name}`, label, describe(value), expected, actual);
        }
    }
}

for (const errno of [-1, -2, -12, -13, -32, -99999]) {
    const expected = nodeUtil.getSystemErrorName(errno);
    const actual = ourUtil.getSystemErrorName(errno);
    if (expected !== actual) {
        report("getSystemErrorName", String(errno), String(errno), expected, actual);
    }
}
for (const errno of [0, 2, 1.5, NaN, "x"]) {
    let expectedError;
    let actualError;
    try {
        nodeUtil.getSystemErrorName(errno);
    } catch (error) {
        expectedError = error;
    }
    try {
        ourUtil.getSystemErrorName(errno);
    } catch (error) {
        actualError = error;
    }
    if (
        !expectedError ||
        !actualError ||
        expectedError.name !== actualError.name ||
        expectedError.code !== actualError.code
    ) {
        report(
            "getSystemErrorName throw",
            String(errno),
            String(errno),
            expectedError && [expectedError.name, expectedError.code],
            actualError && [actualError.name, actualError.code],
        );
    }
}

const vtCases = [
    "plain",
    "\u001b[31mred\u001b[0m",
    "a\u001b]0;title\u0007b",
    "x\u001b[2Jy",
    "\u009b31mz\u009b0m",
];
for (const value of vtCases) {
    const expected = nodeUtil.stripVTControlCharacters(value);
    const actual = ourUtil.stripVTControlCharacters(value);
    if (expected !== actual) {
        report("stripVTControlCharacters", describe(value), describe(value), expected, actual);
    }
}

for (const value of ["a\ud800b", "a\udc00b", "😀", "abc", 123, null, undefined]) {
    const expected = nodeUtil.toUSVString(value);
    const actual = ourUtil.toUSVString(value);
    if (expected !== actual) {
        report("toUSVString", describe(value), describe(value), expected, actual);
    }
}

function Base() {}
Base.prototype.hello = function () {
    return "hi";
};
function NodeChild() {}
nodeUtil.inherits(NodeChild, Base);
function OurChild() {}
ourUtil.inherits(OurChild, Base);
nodeAssert.ok(new OurChild() instanceof Base, "inherits prototype chain");
nodeAssert.strictEqual(OurChild.super_, Base, "inherits super_");
for (const [label, fn] of [
    ["ctor", () => ourUtil.inherits(1, Base)],
    ["superCtor", () => ourUtil.inherits(OurChild, 1)],
]) {
    let expectedError;
    let actualError;
    try {
        nodeUtil.inherits(1, Base);
    } catch (error) {
        expectedError = error;
    }
    try {
        fn();
    } catch (error) {
        actualError = error;
    }
    // Node's inherits(1, fn) throws a plain TypeError without a code; only the
    // error name is part of the contract here.
    if (!expectedError || !actualError || expectedError.name !== actualError.name) {
        report(
            "inherits throw",
            label,
            label,
            expectedError && expectedError.name,
            actualError && actualError.name,
        );
    }
}

async function main() {
    await comparePromisify();
    await compareCallbackify();

    nodeAssert.ok(inspectValues.length >= 40, "inspect table is large");
    nodeAssert.ok(equalityPairs.length >= 40, "equality table is large");

    console.log("");
    console.log(
        `util.oracle: ${inspectValues.length} values x ${inspectOptionSets.length} option sets, ` +
            `${formatCases.length} format cases, ${equalityPairs.length} equality pairs, ` +
            `${mismatches} mismatch(es)`,
    );
    if (mismatches > 0) process.exit(1);
}

main().catch((error) => {
    console.error(error);
    process.exit(2);
});
