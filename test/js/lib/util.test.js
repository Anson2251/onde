"use strict";

// Runtime-agnostic self-check for js/lib/util.js.
// Runs unchanged under both `node` and `lite`: it only uses the language and
// the module under test (no `node:` builtins).

const util = require("../../../js/lib/util.js");

let checks = 0;
let failures = 0;

function show(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return String(value) + "n";
  if (typeof value === "symbol") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function ok(condition, label, detail) {
  checks++;
  if (condition) {
    console.log("ok " + label);
  } else {
    failures++;
    console.log("not ok " + label + (detail ? " - " + detail : ""));
  }
}

function is(actual, expected, label) {
  checks++;
  if (Object.is(actual, expected)) {
    console.log("ok " + label);
  } else {
    failures++;
    console.log(
      "not ok " +
        label +
        " - expected " +
        show(expected) +
        ", got " +
        show(actual),
    );
  }
}

function throwsWith(fn, name, code, label) {
  checks++;
  try {
    fn();
  } catch (error) {
    if (error && error.name === name && (code === undefined || error.code === code)) {
      console.log("ok " + label);
    } else {
      failures++;
      console.log(
        "not ok " +
          label +
          " - expected " +
          name +
          (code ? "/" + code : "") +
          ", got " +
          (error && error.name) +
          "/" +
          (error && error.code),
      );
    }
    return;
  }
  failures++;
  console.log("not ok " + label + " - did not throw");
}

// ---------------------------------------------------------------------------
// format()
// ---------------------------------------------------------------------------

is(util.format(), "", "format() with no args returns empty string");
is(util.format("plain"), "plain", "format() passes a lone string through");
is(util.format("%s", "x"), "x", "format %s string");
is(util.format("%s", { a: 1 }), "{ a: 1 }", "format %s object uses inspect");
is(util.format("%s", { a: { b: 1 } }), "{ a: [Object] }", "format %s object uses depth 0");
is(util.format("%d", "12.7"), "12.7", "format %d number");
is(util.format("%d", 12n), "12n", "format %d bigint");
is(util.format("%d", Symbol("x")), "NaN", "format %d symbol is NaN");
is(util.format("%i", "12.9"), "12", "format %i truncates");
is(util.format("%i", "0x10"), "16", "format %i parses hex");
is(util.format("%f", "1.5x"), "1.5", "format %f parses float");
is(util.format("%j", { a: 1 }), '{"a":1}', "format %j JSON");
is(util.format("%j", undefined), "undefined", "format %j undefined");
is(util.format("%c", "color:red"), "", "format %c consumes and emits nothing");
is(util.format("%q", 1), "%q 1", "format leaves invalid placeholders");
is(util.format("abc%"), "abc%", "format leaves a trailing percent");
is(util.format("%s %s", 1), "1 %s", "format leaves placeholders without args");
is(util.format("x", 1, 2, 3), "x 1 2 3", "format appends extra args");
is(util.format("%%"), "%%", "format %% with no remaining args is literal");
is(util.format("%%", 1), "% 1", "format %% consumes when args remain");

const circularFormat = {};
circularFormat.self = circularFormat;
is(util.format("%j", circularFormat), "[Circular]", "format %j circular falls back");

is(
  util.formatWithOptions({ depth: 0 }, "%O", { a: { b: 1 } }),
  "{ a: [Object] }",
  "formatWithOptions honors depth for %O",
);
is(
  util.formatWithOptions({ depth: 0 }, "%o", { a: { b: 1 } }),
  "{ a: { b: 1 } }",
  "formatWithOptions %o forces depth 4",
);
is(
  util.formatWithOptions({ sorted: true }, "%O", { b: 1, a: 2 }),
  "{ a: 2, b: 1 }",
  "formatWithOptions sorts keys",
);

// ---------------------------------------------------------------------------
// inspect(): primitives and strings
// ---------------------------------------------------------------------------

is(util.inspect("hello"), "'hello'", "inspect string");
is(util.inspect("a'b"), '"a\'b"', "inspect chooses double quotes");
is(util.inspect("a'b\"c"), "`a'b\"c`", "inspect chooses backticks");
is(util.inspect("a'b\"c`d"), "'a\\'b\"c`d'", "inspect falls back to single quotes");
is(util.inspect("a\n\t\\"), "'a\\n\\t\\\\'", "inspect escapes control characters");
is(util.inspect(1.5), "1.5", "inspect number");
is(util.inspect(-0), "-0", "inspect negative zero");
is(util.inspect(NaN), "NaN", "inspect NaN");
is(util.inspect(Infinity), "Infinity", "inspect Infinity");
is(util.inspect(12n), "12n", "inspect bigint");
is(util.inspect(Symbol("foo")), "Symbol(foo)", "inspect symbol");
is(util.inspect(undefined), "undefined", "inspect undefined");
is(util.inspect(null), "null", "inspect null");
is(util.inspect(true), "true", "inspect boolean");

// ---------------------------------------------------------------------------
// inspect(): collections and objects
// ---------------------------------------------------------------------------

is(util.inspect([1, 2, 3]), "[ 1, 2, 3 ]", "inspect array");
is(util.inspect([]), "[]", "inspect empty array");
is(util.inspect([1, , 3]), "[ 1, <1 empty item>, 3 ]", "inspect array hole");
is(
  util.inspect([1, 2, 3, 4, 5, 6, 7, 8]),
  "[\n  1, 2, 3, 4,\n  5, 6, 7, 8\n]",
  "inspect groups arrays with more than six entries",
);
is(util.inspect({}), "{}", "inspect empty object");
is(util.inspect({ a: 1, b: "x" }), "{ a: 1, b: 'x' }", "inspect object");
is(util.inspect({ a: { b: { c: { d: 1 } } } }), "{ a: { b: { c: [Object] } } }", "inspect respects default depth");
is(
  util.inspect({ a: { b: { c: { d: 1 } } } }, { depth: null }),
  "{\n  a: { b: { c: { d: 1 } } }\n}",
  "inspect depth null is unlimited",
);
is(util.inspect({ a: { b: 1 } }, { depth: 0 }), "{ a: [Object] }", "inspect depth 0");
is(util.inspect({ b: 1, a: 2 }), "{ b: 1, a: 2 }", "inspect keeps insertion order");
is(util.inspect({ b: 1, a: 2 }, { sorted: true }), "{ a: 2, b: 1 }", "inspect sorted option");
is(util.inspect({ "a-b": 1, "x y": 2, 3: "z" }), "{ '3': 'z', 'a-b': 1, 'x y': 2 }", "inspect quotes non-identifier keys");
is(util.inspect(Object.assign(Object.create(null), { a: 1 })), "[Object: null prototype] { a: 1 }", "inspect null-prototype object");
is(util.inspect(new Map([["a", 1], [2, { x: 1 }]])), "Map(2) { 'a' => 1, 2 => { x: 1 } }", "inspect Map");
is(util.inspect(new Set([1, "a"])), "Set(2) { 1, 'a' }", "inspect Set");
is(util.inspect(new Map()), "Map(0) {}", "inspect empty Map");
is(util.inspect(new Set()), "Set(0) {}", "inspect empty Set");
is(util.inspect(new Date("2020-01-01T00:00:00Z")), "2020-01-01T00:00:00.000Z", "inspect Date");
is(util.inspect(new Date(NaN)), "Invalid Date", "inspect invalid Date");
is(util.inspect(/foo/gi), "/foo/gi", "inspect RegExp");
is(util.inspect([1, 2, 3], { maxArrayLength: 2 }), "[ 1, 2, ... 1 more item ]", "inspect maxArrayLength");
is(util.inspect("abcdef", { maxStringLength: 3 }), "'abc'... 3 more characters", "inspect maxStringLength");
is(util.inspect(1234567, { numericSeparator: true }), "1_234_567", "inspect numericSeparator");
is(util.inspect(new Uint8Array([1, 2])), "Uint8Array(2) [ 1, 2 ]", "inspect Uint8Array");
is(
  util.inspect(new Uint8Array([1, 2, 255]).buffer),
  "ArrayBuffer { [Uint8Contents]: <01 02 ff>, [byteLength]: 3 }",
  "inspect ArrayBuffer",
);
is(util.inspect(new WeakMap()), "WeakMap { <items unknown> }", "inspect WeakMap");
is(util.inspect(new WeakSet()), "WeakSet { <items unknown> }", "inspect WeakSet");
is(util.inspect(new Promise(() => {})), "Promise { <pending> }", "inspect pending Promise");
is(util.inspect([new Number(1), new String("x")]), "[ [Number: 1], [String: 'x'] ]", "inspect boxed primitives");
is(
  util.inspect({ get x() { return 1; } }),
  "{ x: [Getter] }",
  "inspect getter without getters option",
);
is(
  util.inspect({ get x() { return 1; } }, { getters: true }),
  "{ x: [Getter: 1] }",
  "inspect getter with getters option",
);

// Functions and classes.
is(util.inspect(function foo() {}), "[Function: foo]", "inspect named function");
is(util.inspect(function () {}), "[Function (anonymous)]", "inspect anonymous function");
is(util.inspect(class X {}), "[class X]", "inspect class");
is(util.inspect(async function af() {}), "[AsyncFunction: af]", "inspect async function");
is(util.inspect(function* g() {}), "[GeneratorFunction: g]", "inspect generator function");
is(util.inspect(async function* ag() {}), "[AsyncGeneratorFunction: ag]", "inspect async generator");
is(util.inspect(Object.assign(function f() {}, { a: 1 })), "[Function: f] { a: 1 }", "inspect function properties");

// Circular references.
const circularObject = { a: 1 };
circularObject.self = circularObject;
is(util.inspect(circularObject), "<ref *1> { a: 1, self: [Circular *1] }", "inspect circular object");
const circularHolder = { a: circularObject };
is(util.inspect(circularHolder), "{ a: <ref *1> { a: 1, self: [Circular *1] } }", "inspect nested circular legend");
const circularArray = [1];
circularArray.push(circularArray);
is(util.inspect(circularArray), "<ref *1> [ 1, [Circular *1] ]", "inspect circular array");

// Errors: the stack frames are runtime-specific, but the header is Node-shaped.
const inspectedError = util.inspect(new TypeError("boom"));
ok(
  inspectedError.split("\n")[0] === "TypeError: boom",
  "inspect Error header",
  inspectedError.split("\n")[0],
);
const noStackError = new Error("m");
let stackAssignable = true;
try {
  noStackError.stack = undefined;
} catch (_) {
  // QuickJS's stack setter requires a string; the no-stack rendering cannot be exercised there.
  stackAssignable = false;
}
if (stackAssignable) {
  is(util.inspect(noStackError), "[Error: m]", "inspect Error without stack");
}

// Custom inspect hooks.
const customValue = {
  [Symbol.for("nodejs.util.inspect.custom")](depth, options, insp) {
    return "CUSTOM:" + String(depth) + ":" + typeof insp;
  },
};
is(util.inspect(customValue), "CUSTOM:2:function", "inspect custom symbol");
if (stackAssignable) {
  is(util.inspect(noStackError, { customInspect: false }), "[Error: m]", "inspect customInspect false does not break builtins");
}
const legacyValue = {
  inspect() {
    return "LEGACY";
  },
};
is(util.inspect(legacyValue), "LEGACY", "inspect legacy inspect() method");

// seen and colors are accepted/ignored.
is(util.inspect({ a: 1 }, { seen: [] }), "{ a: 1 }", "inspect accepts seen option");
is(util.inspect("x", { colors: true }), "'x'", "inspect ignores colors");

is(util.inspect.defaultOptions.depth, 2, "inspect.defaultOptions.depth");
ok(typeof util.inspect.custom === "symbol", "inspect.custom is a symbol");

// ---------------------------------------------------------------------------
// Deep equality
// ---------------------------------------------------------------------------

is(util.isDeepStrictEqual(NaN, NaN), true, "isDeepStrictEqual NaN equals NaN");
is(util.isDeepStrictEqual(0, -0), false, "isDeepStrictEqual distinguishes -0");
is(util.isDeepStrictEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true, "isDeepStrictEqual nested");
is(util.isDeepStrictEqual({ a: 1 }, { a: 1, b: undefined }), false, "isDeepStrictEqual undefined key");
is(util.isDeepStrictEqual(new Map([[1, { a: 2 }]]), new Map([[1, { a: 2 }]])), true, "isDeepStrictEqual Map");
is(util.isDeepStrictEqual(new Set([1, 2]), new Set([2, 1])), true, "isDeepStrictEqual Set order");
is(util.isDeepStrictEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true, "isDeepStrictEqual typed arrays");
is(util.isDeepStrictEqual(new Uint8Array([1]), new Int8Array([1])), false, "isDeepStrictEqual typed array kinds");
is(util.isDeepStrictEqual(new Date(NaN), new Date(NaN)), true, "isDeepStrictEqual invalid dates");
is(util.isDeepStrictEqual(/a/g, /a/g), true, "isDeepStrictEqual regexp");
is(util.isDeepStrictEqual(/a/g, /a/i), false, "isDeepStrictEqual regexp flags");
is(util.isDeepStrictEqual(new TypeError("x"), new Error("x")), false, "isDeepStrictEqual error kinds");
is(util.isDeepStrictEqual(Object.create({ x: 1 }), {}), true, "isDeepStrictEqual ignores ordinary prototype identity");
is(util.isDeepStrictEqual(Object.assign(Object.create(null), { a: 1 }), {}), false, "isDeepStrictEqual null prototype differs");
const cycleA = {};
cycleA.self = cycleA;
const cycleB = {};
cycleB.self = cycleB;
is(util.isDeepStrictEqual(cycleA, cycleB), true, "isDeepStrictEqual cycles");

// ---------------------------------------------------------------------------
// inherits / promisify / callbackify / deprecate / debuglog / misc
// ---------------------------------------------------------------------------

function Base() {}
Base.prototype.hello = function () {
  return "hi";
};
function Child() {}
util.inherits(Child, Base);
ok(new Child() instanceof Base, "inherits sets the prototype chain");
is(Child.super_, Base, "inherits sets super_");
throwsWith(() => util.inherits(1, Base), "TypeError", undefined, "inherits validates ctor");
throwsWith(() => util.inherits(Child, 1), "TypeError", undefined, "inherits validates superCtor");
throwsWith(() => util.inherits(Child, () => {}), "TypeError", undefined, "inherits requires superCtor.prototype");

is(
  util.promisify.custom,
  Symbol.for("nodejs.util.promisify.custom"),
  "promisify.custom symbol",
);
throwsWith(() => util.promisify(1), "TypeError", "ERR_INVALID_ARG_TYPE", "promisify validates function");

async function promisifyChecks() {
  const single = await util.promisify(function (cb) {
    cb(null, 1);
  })();
  is(single, 1, "promisify resolves a single value");

  const multi = await util.promisify(function (cb) {
    cb(null, 1, 2);
  })();
  is(multi, 1, "promisify resolves the first success value (Node 26)");

  const none = await util.promisify(function (cb) {
    cb(null);
  })();
  is(none, undefined, "promisify resolves undefined with no value");

  const withThis = await util
    .promisify(function (cb) {
      cb(null, this.value);
    })
    .call({ value: 7 });
  is(withThis, 7, "promisify preserves this");

  let rejected;
  try {
    await util.promisify(function (cb) {
      cb(new Error("bad"));
    })();
  } catch (error) {
    rejected = error.message;
  }
  is(rejected, "bad", "promisify rejects on callback error");

  function namedTarget(a, b, cb) {
    cb(null, a + b);
  }
  const namedPromisified = util.promisify(namedTarget);
  is(namedPromisified.name, "namedTarget", "promisify preserves the function name");
  is(namedPromisified.length, namedTarget.length, "promisify preserves the function length");
  is(namedPromisified.prototype, namedTarget.prototype, "promisify preserves the prototype");

  function customPromise(cb) {
    cb(null, "plain");
  }
  customPromise[util.promisify.custom] = () => Promise.resolve("custom");
  is(await util.promisify(customPromise)(), "custom", "promisify honors the custom symbol");

  const callbackified = util.callbackify(async function namedAsync() { return 5; });
  is(callbackified.name, "namedAsyncCallbackified", "callbackify names the wrapper");
  is(callbackified.length, 1, "callbackify increments the arity");
  const callbackResult = await new Promise((resolve) => {
    callbackified((error, value) => resolve([error, value]));
  });
  is(callbackResult[0], null, "callbackify passes null error");
  is(callbackResult[1], 5, "callbackify passes the resolved value");

  const callbackifiedReject = util.callbackify(async () => {
    throw new Error("rej");
  });
  const rejection = await new Promise((resolve) => {
    callbackifiedReject((error) => resolve(error && error.message));
  });
  is(rejection, "rej", "callbackify passes rejection errors");

  throwsWith(
    () => {
      util.callbackify(async () => 1)(1);
    },
    "TypeError",
    "ERR_INVALID_ARG_TYPE",
    "callbackify validates the callback",
  );
}

let deprecateChecks = Promise.resolve();
if (typeof process !== "undefined" && process) {
  let patched = false;
  const originalEmitWarning = process.emitWarning;
  try {
    process.emitWarning = () => {
      patched = true;
    };
  } catch {
    patched = false;
  }
  let called = 0;
  const wrapped = util.deprecate(function (x) {
    called++;
    return x * 2;
  }, "use something else", "DEP_TEST");
  is(wrapped(2), 4, "deprecate forwards return value");
  is(wrapped(3), 6, "deprecate forwards arguments");
  is(called, 2, "deprecate calls the wrapped function every time");
  if (patched) {
    is(typeof originalEmitWarning, "function", "deprecate used process.emitWarning");
  }
  try {
    if (originalEmitWarning === undefined) delete process.emitWarning;
    else process.emitWarning = originalEmitWarning;
  } catch {
    // ignore
  }
}

is(typeof util.debuglog("test"), "function", "debuglog returns a function");
is(util.debuglog("test").enabled, false, "debuglog disabled without NODE_DEBUG");
is(util.debuglog("test")("hello"), undefined, "debuglog is a no-op when disabled");
is(util.getSystemErrorName(-2), "ENOENT", "getSystemErrorName ENOENT");
is(util.getSystemErrorName(-13), "EACCES", "getSystemErrorName EACCES");
is(util.getSystemErrorName(-99999), "Unknown system error -99999", "getSystemErrorName unknown");
throwsWith(() => util.getSystemErrorName(2), "RangeError", "ERR_OUT_OF_RANGE", "getSystemErrorName rejects positive errno");
throwsWith(() => util.getSystemErrorName("x"), "TypeError", "ERR_INVALID_ARG_TYPE", "getSystemErrorName validates number");
is(util.stripVTControlCharacters("\u001b[31mred\u001b[0m"), "red", "stripVTControlCharacters");
is(util.stripVTControlCharacters("plain"), "plain", "stripVTControlCharacters leaves plain text");
throwsWith(() => util.stripVTControlCharacters(5), "TypeError", "ERR_INVALID_ARG_TYPE", "stripVTControlCharacters validates string");
is(util.toUSVString("a\ud800b"), "a\ufffdb", "toUSVString replaces lone high surrogate");
is(util.toUSVString("a\udc00b"), "a\ufffdb", "toUSVString replaces lone low surrogate");
is(util.toUSVString("a\ud83d\ude00b"), "a\ud83d\ude00b", "toUSVString keeps surrogate pairs");

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

is(util.types.isPromise(Promise.resolve(1)), true, "types.isPromise");
is(util.types.isPromise({ then() {} }), false, "types.isPromise rejects thenables");
is(util.types.isDate(new Date()), true, "types.isDate");
is(util.types.isRegExp(/x/), true, "types.isRegExp");
is(util.types.isMap(new Map()), true, "types.isMap");
is(util.types.isSet(new Set()), true, "types.isSet");
is(util.types.isWeakMap(new WeakMap()), true, "types.isWeakMap");
is(util.types.isWeakSet(new WeakSet()), true, "types.isWeakSet");
is(util.types.isArrayBuffer(new ArrayBuffer(1)), true, "types.isArrayBuffer");
is(util.types.isArrayBufferView(new Uint8Array(1)), true, "types.isArrayBufferView");
is(util.types.isTypedArray(new Uint8Array(1)), true, "types.isTypedArray");
is(util.types.isTypedArray(new DataView(new ArrayBuffer(1))), false, "types.isTypedArray excludes DataView");
is(util.types.isUint8Array(new Uint8Array(1)), true, "types.isUint8Array");
is(util.types.isUint8Array(new Int8Array(1)), false, "types.isUint8Array excludes Int8Array");
is(util.types.isAsyncFunction(async function () {}), true, "types.isAsyncFunction");
is(util.types.isGeneratorFunction(function* () {}), true, "types.isGeneratorFunction");
is(util.types.isGeneratorObject((function* () {})()), true, "types.isGeneratorObject");
is(util.types.isBoxedPrimitive(new Number(1)), true, "types.isBoxedPrimitive");
is(util.types.isBoxedPrimitive(1), false, "types.isBoxedPrimitive plain number");
is(util.types.isNativeError(new Error("x")), true, "types.isNativeError");
is(util.types.isNativeError({ name: "Error" }), false, "types.isNativeError plain object");
is(util.types.isSymbol(Symbol()), true, "types.isSymbol");
is(util.types.isBigInt(1n), true, "types.isBigInt");
is(util.types.isNumber(1), true, "types.isNumber");
is(util.types.isString("x"), true, "types.isString");
is(util.types.isBoolean(false), true, "types.isBoolean");
is(util.types.isNull(null), true, "types.isNull");
is(util.types.isUndefined(undefined), true, "types.isUndefined");
is(util.types.isFunction(() => {}), true, "types.isFunction");
is(util.types.isObject({}), true, "types.isObject object");
is(util.types.isObject(null), false, "types.isObject null");
is(util.types.isPrimitive(1), true, "types.isPrimitive number");
is(util.types.isPrimitive({}), false, "types.isPrimitive object");
if (typeof SharedArrayBuffer !== "undefined") {
  is(util.types.isSharedArrayBuffer(new SharedArrayBuffer(1)), true, "types.isSharedArrayBuffer");
}

// Lazy re-exports must not load buffer.js at module load time.
if (typeof globalThis.TextEncoder !== "undefined") {
  is(util.TextEncoder, globalThis.TextEncoder, "TextEncoder re-export");
} else {
  is(util.TextEncoder, undefined, "TextEncoder is undefined when unavailable");
}
if (typeof globalThis.TextDecoder !== "undefined") {
  is(util.TextDecoder, globalThis.TextDecoder, "TextDecoder re-export");
} else {
  is(util.TextDecoder, undefined, "TextDecoder is undefined when unavailable");
}
if (typeof Buffer !== "undefined") {
  is(util.Buffer, Buffer, "Buffer lazy re-export");
  is(util.inspect(Buffer.from([1, 2, 255])), "<Buffer 01 02 ff>", "inspect Buffer");
} else {
  ok(
    typeof util.Buffer === "undefined" || typeof util.Buffer === "function",
    "Buffer lazy re-export has a valid shape when the global is unavailable",
  );
}

// Run the async assertions, then report and set the process exit code.
promisifyChecks()
  .then(() => deprecateChecks)
  .catch((error) => {
    failures++;
    console.log("not ok async checks threw - " + (error && error.stack));
  })
  .then(() => {
    console.log("");
    console.log(`util.test: ${checks - failures}/${checks} checks passed`);
    if (failures > 0) {
      if (typeof process !== "undefined" && process && typeof process.exit === "function") {
        process.exit(1);
      } else {
        throw new Error(`${failures} util.test assertion(s) failed`);
      }
    }
  });
