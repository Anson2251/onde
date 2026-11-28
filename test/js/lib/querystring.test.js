"use strict";

// Runtime-agnostic self-check for js/lib/querystring.js.
// Run with `node test/js/lib/querystring.test.js`.

const querystring = require("../../../js/lib/querystring.js");

let passed = 0;

function assert(condition, label) {
    if (!condition) {
        console.error("not ok " + label);
        process.exit(1);
    }
    passed++;
    console.log("ok " + label);
}

function assertEqual(actual, expected, label) {
    const actualJson = JSON.stringify(actual);
    const expectedJson = JSON.stringify(expected);
    assert(
        actualJson === expectedJson,
        label +
            (actualJson === expectedJson ? "" : ` (expected ${expectedJson}, got ${actualJson})`),
    );
}

const simple = querystring.parse("a=1&b=2");
assertEqual(simple, { a: "1", b: "2" }, "parse() returns key/value pairs");
assertEqual(Object.getPrototypeOf(simple), null, "parse() returns a null-prototype object");
assertEqual(
    querystring.parse("a=1&a=2&a=3"),
    { a: ["1", "2", "3"] },
    "repeated keys become arrays",
);
assertEqual(querystring.parse("a"), { a: "" }, "keys without '=' get an empty value");
assertEqual(querystring.parse("a="), { a: "" }, "empty values are kept");
assertEqual(querystring.parse(""), {}, "empty input parses to an empty object");
assertEqual(querystring.parse("a=1&&b=2&"), { a: "1", b: "2" }, "empty segments are skipped");
assertEqual(querystring.parse("a+b=1"), { "a b": "1" }, "'+' decodes to a space");
assertEqual(querystring.parse("a=%E4%B8%AD"), { a: "中" }, "percent decoding is UTF-8 aware");
assertEqual(querystring.parse("a=%zz"), { a: "%zz" }, "invalid percent escapes survive literally");
assertEqual(querystring.parse("a=1;b=2"), { a: "1;b=2" }, "';' is not a separator by default");
assertEqual(querystring.parse("a=1;b=2", ";"), { a: "1", b: "2" }, "custom separators work");
assertEqual(
    querystring.parse("a:1|b:2", "|", ":"),
    { a: "1", b: "2" },
    "custom separators and equals work",
);
assertEqual(
    querystring.parse("a=%41", "&", "=", { decodeURIComponent: (v) => `[${v}]` }),
    // Node applies the custom decoder to keys as well as values.
    { "[a]": "[%41]" },
    "custom decodeURIComponent is used",
);
assertEqual(
    Object.keys(querystring.parse("a=1&b=2&c=3", "&", "=", { maxKeys: 2 })),
    ["a", "b"],
    "maxKeys limits the number of pairs",
);
assertEqual(
    Object.keys(querystring.parse("a=1&b=2&c=3", "&", "=", { maxKeys: 0 })).length,
    3,
    "maxKeys: 0 means unlimited",
);

let many = "";
for (let i = 0; i < 1005; i++) many += (i ? "&" : "") + "k" + i + "=1";
assertEqual(Object.keys(querystring.parse(many)).length, 1000, "maxKeys defaults to 1000");

const polluted = querystring.parse("__proto__=x&constructor=y");
assertEqual(polluted.__proto__, "x", "__proto__ is an own key, not the prototype");
assertEqual(
    Object.getPrototypeOf(polluted),
    null,
    "__proto__ parsing does not pollute Object.prototype",
);
assertEqual({}.x, undefined, "Object.prototype was not polluted");

assertEqual(querystring.stringify({ a: 1, b: "x y" }), "a=1&b=x%20y", "stringify() encodes values");
assertEqual(
    querystring.stringify({ a: ["1", "2"], b: "3" }),
    "a=1&a=2&b=3",
    "array values repeat the key",
);
assertEqual(querystring.stringify({ a: [], b: "2" }), "b=2", "empty arrays are skipped");
assertEqual(
    querystring.stringify({ a: null, b: undefined, c: NaN, d: Infinity, e: "", f: true }),
    "a=&b=&c=&d=&e=&f=true",
    "null/undefined/non-finite values stringify as empty",
);
assertEqual(querystring.stringify({ a: 1 }, ";", ":"), "a:1", "custom sep/eq are honoured");
assertEqual(querystring.stringify({ a: "x" }, "", ""), "a=x", "empty sep/eq fall back to defaults");
assertEqual(
    querystring.stringify({ a: "x y" }, "&", "=", { encodeURIComponent: (v) => v.toUpperCase() }),
    "A=X Y",
    "custom encodeURIComponent is used",
);

assertEqual(querystring.escape("a b+c/d"), "a%20b%2Bc%2Fd", "escape() percent-encodes");
assertEqual(querystring.escape("!*()~'"), "!*()~'", "escape() leaves unreserved punctuation");
assertEqual(querystring.unescape("a%20b"), "a b", "unescape() decodes");
assertEqual(querystring.unescape("%zz"), "%zz", "unescape() tolerates invalid escapes");
assertEqual(querystring.unescape("a+b"), "a+b", "unescape() does not map '+' to space");
assertEqual(querystring.decode("a=1"), { a: "1" }, "decode() aliases parse()");
assertEqual(querystring.encode({ a: "1" }), "a=1", "encode() aliases stringify()");
assertEqual(
    typeof querystring.unescapeBuffer("%41", true),
    "object",
    "unescapeBuffer() returns a byte container",
);

console.log(`# querystring: ${passed} assertions passed`);
