"use strict";

// Runtime-agnostic self-check for js/lib/internal/errors.js, the shared error vocabulary.
//
//   node test/js/lib/errors.test.js
//   ./target/debug/onde test/js/lib/errors.test.js
//
// Only the module under test (plus our Buffer, for the `<Buffer ...>` rendering) is required;
// no `node:` builtins are used.

const {
  abortError,
  coded,
  describeValue,
  invalidArgType,
  invalidArgValue,
  invalidPropertyType,
  missingArgs,
  outOfRange,
  unknownEncoding,
} = require("../../../js/lib/internal/errors.js");

const Buffer = require("../../../js/lib/buffer.js");

let passed = 0;
let failed = 0;

function show(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "symbol") return String(value);
  if (typeof value === "bigint") return `${value}n`;
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function ok(label, actual, expected) {
  if (Object.is(actual, expected)) {
    passed++;
    console.log("ok " + label);
    return;
  }
  failed++;
  console.error("FAIL " + label);
  console.error("  expected: " + show(expected));
  console.error("  actual:   " + show(actual));
}

function is(label, actual, expected) {
  ok(label, actual, expected);
}

function capture(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

function checkError(label, fn, Ctor, code, message) {
  const error = capture(fn);
  ok(label + ": instanceof " + Ctor.name, error instanceof Ctor, true);
  ok(label + ": name", error && error.name, Ctor.name);
  ok(label + ": code", error && error.code, code);
  ok(label + ": message", error && error.message, message);
}

// ---------------------------------------------------------------------------
// coded
// ---------------------------------------------------------------------------

{
  const custom = capture(() => {
    throw coded(TypeError, "ERR_CUSTOM", "custom message");
  });
  ok("coded: constructor", custom instanceof TypeError, true);
  ok("coded: code", custom.code, "ERR_CUSTOM");
  ok("coded: message", custom.message, "custom message");

  const plain = capture(() => {
    throw coded(RangeError, undefined, "no code");
  });
  ok("coded: constructor without code", plain instanceof RangeError, true);
  ok("coded: code stays undefined", plain.code, undefined);
}

// ---------------------------------------------------------------------------
// describeValue
// ---------------------------------------------------------------------------

{
  is("describeValue(null)", describeValue(null), "null");
  is("describeValue(undefined)", describeValue(undefined), "undefined");
  is("describeValue(number)", describeValue(1), "type number (1)");
  is("describeValue(boolean)", describeValue(true), "type boolean (true)");
  is("describeValue(bigint)", describeValue(10n), "type bigint (10n)");
  is("describeValue(string)", describeValue("abc"), "type string ('abc')");
  is("describeValue(symbol)", describeValue(Symbol("s")), "type symbol (Symbol(s))");
  is("describeValue(object)", describeValue({}), "an instance of Object");
  is("describeValue(array)", describeValue([]), "an instance of Array");

  class Thing {}
  is("describeValue(class instance)", describeValue(new Thing()), "an instance of Thing");

  function named() {}
  is("describeValue(named function)", describeValue(named), "function named");
  is("describeValue(anonymous function)", describeValue(() => {}), "function");
}

// ---------------------------------------------------------------------------
// invalidArgType / invalidPropertyType
// ---------------------------------------------------------------------------

{
  checkError(
    "invalidArgType(dotted name)",
    () => {
      throw invalidArgType("options.signal", "an instance of AbortSignal", 1);
    },
    TypeError,
    "ERR_INVALID_ARG_TYPE",
    'The "options.signal" property must be an instance of AbortSignal. Received type number (1)',
  );

  checkError(
    "invalidArgType(bare type)",
    () => {
      throw invalidArgType("count", "number", "two");
    },
    TypeError,
    "ERR_INVALID_ARG_TYPE",
    'The "count" argument must be of type number. Received type string (\'two\')',
  );

  checkError(
    "invalidArgType(of type)",
    () => {
      throw invalidArgType("name", "of type string", 1);
    },
    TypeError,
    "ERR_INVALID_ARG_TYPE",
    'The "name" argument must be of type string. Received type number (1)',
  );

  checkError(
    "invalidArgType(an instance of)",
    () => {
      throw invalidArgType("signal", "an instance of AbortSignal", 1);
    },
    TypeError,
    "ERR_INVALID_ARG_TYPE",
    'The "signal" argument must be an instance of AbortSignal. Received type number (1)',
  );

  checkError(
    "invalidArgType(one of)",
    () => {
      throw invalidArgType("value", "one of string or number", true);
    },
    TypeError,
    "ERR_INVALID_ARG_TYPE",
    'The "value" argument must be one of string or number. Received type boolean (true)',
  );

  checkError(
    "invalidArgType(must clause)",
    () => {
      throw invalidArgType("value", "must be one of type number or string", true);
    },
    TypeError,
    "ERR_INVALID_ARG_TYPE",
    'The "value" argument must be one of type number or string. Received type boolean (true)',
  );

  checkError(
    "invalidArgType(Object)",
    () => {
      throw invalidArgType("options", "Object", 1);
    },
    TypeError,
    "ERR_INVALID_ARG_TYPE",
    'The "options" argument must be an instance of Object. Received type number (1)',
  );

  checkError(
    "invalidArgType(array of expected)",
    () => {
      throw invalidArgType("value", ["string", "Buffer"], 1);
    },
    TypeError,
    "ERR_INVALID_ARG_TYPE",
    'The "value" argument must be of type string or Buffer. Received type number (1)',
  );

  checkError(
    "invalidPropertyType(plain name)",
    () => {
      throw invalidPropertyType("level", "number", "1");
    },
    TypeError,
    "ERR_INVALID_ARG_TYPE",
    'The "level" property must be of type number. Received type string (\'1\')',
  );

  checkError(
    "invalidPropertyType(dotted name)",
    () => {
      throw invalidPropertyType("options.level", "number", "1");
    },
    TypeError,
    "ERR_INVALID_ARG_TYPE",
    'The "options.level" property must be of type number. Received type string (\'1\')',
  );

  checkError(
    "invalidArgType(last argument)",
    () => {
      throw invalidArgType("last argument", "of type function", 1);
    },
    TypeError,
    "ERR_INVALID_ARG_TYPE",
    "The last argument must be of type function. Received type number (1)",
  );
}

// ---------------------------------------------------------------------------
// invalidArgValue
// ---------------------------------------------------------------------------

{
  checkError(
    "invalidArgValue(string)",
    () => {
      throw invalidArgValue("encoding", "bogus", "is invalid");
    },
    TypeError,
    "ERR_INVALID_ARG_VALUE",
    "The argument 'encoding' is invalid. Received 'bogus'",
  );

  checkError(
    "invalidArgValue(number)",
    () => {
      throw invalidArgValue("highWaterMark", -1, "must be a non-negative number");
    },
    TypeError,
    "ERR_INVALID_ARG_VALUE",
    "The argument 'highWaterMark' must be a non-negative number. Received -1",
  );

  checkError(
    "invalidArgValue(bigint)",
    () => {
      throw invalidArgValue("size", 10n, "is invalid");
    },
    TypeError,
    "ERR_INVALID_ARG_VALUE",
    "The argument 'size' is invalid. Received 10n",
  );

  checkError(
    "invalidArgValue(object)",
    () => {
      throw invalidArgValue("error", {}, "may not be an empty object");
    },
    TypeError,
    "ERR_INVALID_ARG_VALUE",
    "The argument 'error' may not be an empty object. Received {}",
  );

  checkError(
    "invalidArgValue(Buffer)",
    () => {
      throw invalidArgValue("value", Buffer.from([0x61, 0x62]), "is invalid");
    },
    TypeError,
    "ERR_INVALID_ARG_VALUE",
    "The argument 'value' is invalid. Received <Buffer 6162>",
  );

  checkError(
    "invalidArgValue(empty Buffer)",
    () => {
      throw invalidArgValue("value", Buffer.alloc(0), "is invalid");
    },
    TypeError,
    "ERR_INVALID_ARG_VALUE",
    "The argument 'value' is invalid. Received <Buffer >",
  );

  const long = "a".repeat(200);
  checkError(
    "invalidArgValue(truncation)",
    () => {
      throw invalidArgValue("text", long, "is invalid");
    },
    TypeError,
    "ERR_INVALID_ARG_VALUE",
    "The argument 'text' is invalid. Received " + "'" + "a".repeat(127) + "...",
  );
}

// ---------------------------------------------------------------------------
// missingArgs
// ---------------------------------------------------------------------------

{
  checkError(
    "missingArgs(one)",
    () => {
      throw missingArgs("callback");
    },
    TypeError,
    "ERR_MISSING_ARGS",
    'The "callback" argument must be specified',
  );

  checkError(
    "missingArgs(two)",
    () => {
      throw missingArgs("actual", "expected");
    },
    TypeError,
    "ERR_MISSING_ARGS",
    'The "actual" and "expected" arguments must be specified',
  );

  checkError(
    "missingArgs(three)",
    () => {
      throw missingArgs("a", "b", "c");
    },
    TypeError,
    "ERR_MISSING_ARGS",
    'The "a", "b" and "c" arguments must be specified',
  );
}

// ---------------------------------------------------------------------------
// outOfRange
// ---------------------------------------------------------------------------

{
  checkError(
    "outOfRange(small)",
    () => {
      throw outOfRange("offset", ">= 0 and <= 7", 8);
    },
    RangeError,
    "ERR_OUT_OF_RANGE",
    'The value of "offset" is out of range. It must be >= 0 and <= 7. Received 8',
  );

  checkError(
    "outOfRange(above 2**32)",
    () => {
      throw outOfRange("size", ">= 0 && <= 9007199254740991", 2 ** 32 + 1);
    },
    RangeError,
    "ERR_OUT_OF_RANGE",
    'The value of "size" is out of range. It must be >= 0 && <= 9007199254740991. ' +
      "Received 4_294_967_297",
  );

  checkError(
    "outOfRange(at 2**32)",
    () => {
      throw outOfRange("size", ">= 0", 2 ** 32);
    },
    RangeError,
    "ERR_OUT_OF_RANGE",
    'The value of "size" is out of range. It must be >= 0. Received 4294967296',
  );

  checkError(
    "outOfRange(bigint)",
    () => {
      throw outOfRange("size", ">= 0", 281474976710656n);
    },
    RangeError,
    "ERR_OUT_OF_RANGE",
    'The value of "size" is out of range. It must be >= 0. Received 281_474_976_710_656n',
  );
}

// ---------------------------------------------------------------------------
// unknownEncoding
// ---------------------------------------------------------------------------

{
  checkError(
    "unknownEncoding(string)",
    () => {
      throw unknownEncoding("nope");
    },
    TypeError,
    "ERR_UNKNOWN_ENCODING",
    "Unknown encoding: nope",
  );

  checkError(
    "unknownEncoding(non-string)",
    () => {
      throw unknownEncoding(5);
    },
    TypeError,
    "ERR_UNKNOWN_ENCODING",
    "Unknown encoding: 5",
  );
}

// ---------------------------------------------------------------------------
// abortError
// ---------------------------------------------------------------------------

{
  const plain = capture(() => {
    throw abortError();
  });
  ok("abortError: instanceof Error", plain instanceof Error, true);
  ok("abortError: name", plain && plain.name, "AbortError");
  ok("abortError: code", plain && plain.code, "ABORT_ERR");
  ok("abortError: message", plain && plain.message, "The operation was aborted");
  ok("abortError: no cause when undefined", plain && "cause" in plain, false);

  const reason = new Error("why");
  const caused = capture(() => {
    throw abortError(reason);
  });
  ok("abortError: cause is the reason", caused && caused.cause, reason);
  ok("abortError: cause present", caused && "cause" in caused, true);

  const falsy = capture(() => {
    throw abortError(null);
  });
  ok("abortError: null is a cause", falsy && "cause" in falsy && falsy.cause, null);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`# errors: ${passed} passed, ${failed} failed`);
if (failed !== 0) {
  process.exitCode = 1;
}
