"use strict";

// onde's `assert` module.
//
// The shapes and the common messages follow Node's assert.  The deep-equality
// decisions are delegated to util.js so that assert.deepStrictEqual and
// util.isDeepStrictEqual can never disagree.  Generated structural diffs are
// simpler than Node's Myers diff (see docs/compat.md); every throw/no-throw
// decision, AssertionError field and the compact messages are covered by
// test/js/lib/assert.oracle.js.

// Relative requires work under Node and under onde's CJS loader.  Keep a bare
// specifier as a fallback for an embedded-stdlib loader that only knows
// builtin names (the runtime resolves "util" to this same file).
let util;
try {
  util = require("./util.js");
} catch (relativeError) {
  try {
    util = require("util");
  } catch {
    throw relativeError;
  }
}

const inspect = util.inspect;
const isDeepStrictEqual = util.isDeepStrictEqual;
const isDeepEqual = util._isDeepEqual;

const NO_EXCEPTION = Symbol("no exception");

const diffInspectOptions = {
  compact: false,
  customInspect: false,
  depth: 1000,
  maxArrayLength: Infinity,
  maxStringLength: Infinity,
  showHidden: false,
  sorted: true,
  getters: true,
};

function inspectValue(value) {
  return inspect(value, diffInspectOptions);
}

function isErrorValue(value) {
  if (!value || typeof value !== "object") return false;
  if (value instanceof Error) return true;
  return Object.prototype.toString.call(value) === "[object Error]";
}

function isRegExpValue(value) {
  return value instanceof RegExp;
}

function invalidArgType(name, expected, actual) {
  const err = new TypeError(
    `The "${name}" argument must be ${expected}. Received ${describeValue(actual)}`,
  );
  err.code = "ERR_INVALID_ARG_TYPE";
  return err;
}

function describeValue(value) {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "object" || type === "function") {
    let name = "Object";
    try {
      if (value.constructor && value.constructor.name) {
        name = value.constructor.name;
      }
    } catch {
      // ignore
    }
    return `an instance of ${name}`;
  }
  if (type === "string") return `type string ('${value}')`;
  return `type ${type} (${String(value)})`;
}

function missingArgs(...names) {
  const quoted = names.map((name) => `"${name}"`);
  const list =
    quoted.length === 1
      ? quoted[0]
      : quoted.slice(0, -1).join(", ") + " and " + quoted[quoted.length - 1];
  const err = new TypeError(`The ${list} argument${names.length > 1 ? "s" : ""} must be specified`);
  err.code = "ERR_MISSING_ARGS";
  return err;
}

function invalidArgValue(name, value, reason) {
  const err = new TypeError(
    `The argument '${name}' ${reason}. Received ${inspectValue(value)}`,
  );
  err.code = "ERR_INVALID_ARG_VALUE";
  return err;
}

function invalidReturnValue(expected, name, actual) {
  const err = new TypeError(
    `The "${name}" argument must be ${expected}. Received ${describeValue(actual)}`,
  );
  err.code = "ERR_INVALID_RETURN_VALUE";
  return err;
}

function promiseReturnError(actual) {
  const err = new TypeError(
    'Expected instance of Promise to be returned from the "promiseFn" ' +
      `function but got ${describeValue(actual)}.`,
  );
  err.code = "ERR_INVALID_RETURN_VALUE";
  return err;
}

function invalidArgTypeOneOf(name, expected, actual) {
  const err = new TypeError(
    `The "${name}" argument must be one of type ${expected}. Received ${describeValue(actual)}`,
  );
  err.code = "ERR_INVALID_ARG_TYPE";
  return err;
}

function invalidInstanceArgType(name, ctorName, actual) {
  const err = new TypeError(
    `The "${name}" argument must be an instance of ${ctorName}. ` +
      `Received ${describeValue(actual)}`,
  );
  err.code = "ERR_INVALID_ARG_TYPE";
  return err;
}

function ambiguousArgument(name, message) {
  const err = new TypeError(message);
  err.code = "ERR_AMBIGUOUS_ARGUMENT";
  return err;
}

// ---------------------------------------------------------------------------
// AssertionError
// ---------------------------------------------------------------------------

function isObjectValue(value) {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function getMessage(actual, expected, operator) {
  const headerFor = {
    deepStrictEqual: "Expected values to be strictly deep-equal:",
    strictEqual: "Expected values to be strictly equal:",
    strictEqualObject: 'Expected "actual" to be reference-equal to "expected":',
    deepEqual: "Expected values to be loosely deep-equal:",
    notDeepStrictEqual:
      'Expected "actual" not to be strictly deep-equal to:',
    notStrictEqual: 'Expected "actual" to be strictly unequal to:',
    notDeepEqual: 'Expected values not to be loosely deep-equal:',
  };

  switch (operator) {
    case "strictEqual":
    case "strictEqualObject": {
      if (operator === "strictEqual" && typeof actual === "object" &&
          typeof expected === "object") {
        return `${headerFor.strictEqualObject}\n\n${inspectValue(actual)}\n\n!==\n\n${inspectValue(expected)}\n`;
      }
      if (actual === 0 || expected === 0) {
        return `${headerFor.strictEqual}\n+ actual - expected\n\n+ ${inspectValue(
          actual,
        )}\n- ${inspectValue(expected)}\n`;
      }
      return `${headerFor.strictEqual}\n\n${inspectValue(actual)} !== ${inspectValue(expected)}\n`;
    }
    case "==":
      return `${inspectValue(actual)} == ${inspectValue(expected)}`;
    case "!=":
      return `${inspectValue(actual)} != ${inspectValue(expected)}`;
    case "notStrictEqual":
      return `${headerFor.notStrictEqual} ${inspectValue(expected)}`;
    case "deepEqual":
      return `${headerFor.deepEqual}\n\n${inspectValue(actual)}\n\nshould loosely deep-equal\n\n${inspectValue(expected)}`;
    case "notDeepEqual":
      return `${headerFor.notDeepEqual}\n\n${inspectValue(
        actual,
      )}\n\nshould not loosely deep-equal\n\n${inspectValue(expected)}`;
    case "deepStrictEqual": {
      const header = headerFor.deepStrictEqual;
      if (actual !== 0 && expected !== 0) {
        const actualText = inspectValue(actual);
        const expectedText = inspectValue(expected);
        let length = actualText.length + expectedText.length;
        if (typeof actual === "string") length -= 2;
        if (typeof expected === "string") length -= 2;
        if (length <= 12) {
          return `${header}\n\n${actualText} !== ${expectedText}\n`;
        }
      }
      const plus = inspectValue(actual).replace(/\n/g, "\n+ ");
      const minus = inspectValue(expected).replace(/\n/g, "\n- ");
      return `${header}\n+ actual - expected\n\n+ ${plus}\n- ${minus}\n`;
    }
    case "notDeepStrictEqual":
      return `${headerFor.notDeepStrictEqual}\n\n${inspectValue(expected)}\n`;
    case "fail":
      return "Failed";
    default:
      if (operator === undefined) {
        return `${inspectValue(actual)} ${inspectValue(expected)} ${inspectValue(
          undefined,
        )}`;
      }
      return `${inspectValue(actual)} ${operator} ${inspectValue(expected)}`;
  }
}

class AssertionError extends Error {
  constructor(options) {
    if (options === null || typeof options !== "object") {
      throw invalidArgType("options", "of type object", options);
    }
    let message = options.message;
    let generatedMessage;
    if (message === undefined || message === null) {
      message = getMessage(
        options.actual,
        options.expected,
        options.operator,
      );
      generatedMessage = true;
    } else {
      message = String(message);
      generatedMessage = options.generatedMessage === undefined
        ? false
        : Boolean(options.generatedMessage);
    }
    super(message);
    this.name = "AssertionError";
    this.code = "ERR_ASSERTION";
    this.actual = options.actual;
    this.expected = options.expected;
    this.operator = options.operator;
    this.generatedMessage = generatedMessage;
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, options.stackStartFn || AssertionError);
    }
  }
}

// ---------------------------------------------------------------------------
// inner helpers
// ---------------------------------------------------------------------------

function innerFail(obj) {
  let message = obj.message;
  if (Array.isArray(message)) {
    if (message.length === 0) {
      message = undefined;
    } else if (typeof message[0] === "string") {
      message = message.length > 1 ? util.format(...message) : message[0];
    } else if (isErrorValue(message[0])) {
      throw message[0];
    } else if (typeof message[0] === "function") {
      let produced;
      try {
        produced = message[0](obj.actual, obj.expected);
      } catch {
        produced = undefined;
      }
      message = typeof produced === "string" ? produced : undefined;
    } else {
      throw invalidArgTypeOneOf("message", "string or function", message[0]);
    }
  } else if (isErrorValue(message)) {
    throw message;
  } else if (message !== undefined && typeof message !== "string") {
    throw invalidArgTypeOneOf("message", "string or function", message);
  }

  let generatedMessage;
  if (message === undefined) {
    message = getMessage(obj.actual, obj.expected, obj.operator);
    generatedMessage = true;
  } else {
    generatedMessage = obj.generatedMessage === undefined
      ? false
      : Boolean(obj.generatedMessage);
    if (
      (obj.operator === "deepStrictEqual" || obj.operator === "strictEqual") &&
      !isObjectValue(obj.actual) &&
      !isObjectValue(obj.expected) &&
      !Object.is(obj.actual, obj.expected) &&
      !(Number.isNaN(obj.actual) && Number.isNaN(obj.expected))
    ) {
      message += `\n\n${inspectValue(obj.actual)} !== ${inspectValue(obj.expected)}\n`;
    }
  }

  const error = new AssertionError({
    actual: obj.actual,
    expected: obj.expected,
    operator: obj.operator,
    message,
    generatedMessage,
    stackStartFn: obj.stackStartFn,
  });
  throw error;
}

function getFalsyMessage(fn) {
  const name = fn && fn.name ? fn.name : "assert";
  return `The expression evaluated to a falsy value:\n\n  ${name}(...)\n`;
}

function innerOk(fn, args) {
  if (args[0]) return;
  let generatedMessage = false;
  let messageArgs;
  if (args.length === 0) {
    generatedMessage = true;
    messageArgs = ["No value argument passed to `assert.ok()`"];
  } else if (args.length === 1 || args[1] === null || args[1] === undefined) {
    generatedMessage = true;
    messageArgs = [getFalsyMessage(fn)];
  } else {
    messageArgs = args.slice(1);
  }
  innerFail({
    actual: args[0],
    expected: true,
    operator: "==",
    message: messageArgs,
    stackStartFn: fn,
    generatedMessage,
  });
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

const assert = function assert(...args) {
  innerOk(assert, args);
};

function ok(...args) {
  innerOk(ok, args);
}

function equal(actual, expected, ...message) {
  if (arguments.length < 2) throw missingArgs("actual", "expected");
  if (
    actual != expected &&
    !(Number.isNaN(actual) && Number.isNaN(expected))
  ) {
    innerFail({
      actual,
      expected,
      message,
      operator: "==",
      stackStartFn: equal,
    });
  }
}

function notEqual(actual, expected, ...message) {
  if (arguments.length < 2) throw missingArgs("actual", "expected");
  if (actual == expected || (Number.isNaN(actual) && Number.isNaN(expected))) {
    innerFail({
      actual,
      expected,
      message,
      operator: "!=",
      stackStartFn: notEqual,
    });
  }
}

function strictEqual(actual, expected, ...message) {
  if (arguments.length < 2) throw missingArgs("actual", "expected");
  if (!Object.is(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: "strictEqual",
      stackStartFn: strictEqual,
    });
  }
}

function notStrictEqual(actual, expected, ...message) {
  if (arguments.length < 2) throw missingArgs("actual", "expected");
  if (Object.is(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: "notStrictEqual",
      stackStartFn: notStrictEqual,
    });
  }
}

function deepEqual(actual, expected, ...message) {
  if (arguments.length < 2) throw missingArgs("actual", "expected");
  if (!isDeepEqual(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: "deepEqual",
      stackStartFn: deepEqual,
    });
  }
}

function notDeepEqual(actual, expected, ...message) {
  if (arguments.length < 2) throw missingArgs("actual", "expected");
  if (isDeepEqual(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: "notDeepEqual",
      stackStartFn: notDeepEqual,
    });
  }
}

function deepStrictEqual(actual, expected, ...message) {
  if (arguments.length < 2) throw missingArgs("actual", "expected");
  if (!isDeepStrictEqual(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: "deepStrictEqual",
      stackStartFn: deepStrictEqual,
    });
  }
}

function notDeepStrictEqual(actual, expected, ...message) {
  if (arguments.length < 2) throw missingArgs("actual", "expected");
  if (isDeepStrictEqual(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: "notDeepStrictEqual",
      stackStartFn: notDeepStrictEqual,
    });
  }
}

function fail(message) {
  if (isErrorValue(message)) throw message;
  let generatedMessage = false;
  if (message === undefined) {
    message = "Failed";
    generatedMessage = true;
  }
  throw new AssertionError({
    operator: "fail",
    message,
    generatedMessage,
    stackStartFn: fail,
  });
}

function ifError(err) {
  if (err === null || err === undefined) return;
  let message = "ifError got unwanted exception: ";
  if (typeof err === "object" && typeof err.message === "string") {
    if (err.message.length === 0 && err.constructor) {
      message += err.constructor.name;
    } else {
      message += err.message;
    }
  } else {
    message += inspectValue(err);
  }
  throw new AssertionError({
    actual: err,
    expected: null,
    operator: "ifError",
    message,
    generatedMessage: false,
    stackStartFn: ifError,
  });
}

function internalMatch(string, regexp, messageArgs, fn) {
  if (!isRegExpValue(regexp)) {
    throw invalidInstanceArgType("regexp", "RegExp", regexp);
  }
  const wantMatch = fn === match;
  const matched = regexp.exec(string) !== null;
  if (typeof string !== "string" || matched !== wantMatch) {
    const generatedMessage = messageArgs.length === 0;
    messageArgs = messageArgs.slice();
    if (messageArgs.length === 0) {
      messageArgs[0] =
        (typeof string !== "string"
          ? `The "string" argument must be of type string. Received type ${typeof string} (${inspectValue(
              string,
            )})`
          : (wantMatch
              ? "The input did not match the regular expression "
              : "The input was expected to not match the regular expression ") +
            `${inspectValue(regexp)}. Input:\n\n${inspectValue(string)}\n`);
    }
    innerFail({
      actual: string,
      expected: regexp,
      message: messageArgs,
      operator: fn.name,
      stackStartFn: fn,
      generatedMessage,
    });
  }
}

function match(string, regexp, ...message) {
  internalMatch(string, regexp, message, match);
}

function doesNotMatch(string, regexp, ...message) {
  internalMatch(string, regexp, message, doesNotMatch);
}

// ---------------------------------------------------------------------------
// throws / doesNotThrow / rejects / doesNotReject
// ---------------------------------------------------------------------------

function getActual(fn) {
  if (typeof fn !== "function") {
    throw invalidArgType("fn", "of type function", fn);
  }
  try {
    fn();
  } catch (error) {
    return error;
  }
  return NO_EXCEPTION;
}

function isPromiseLike(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.then === "function" &&
    typeof value.catch === "function"
  );
}

async function waitForActual(promiseFn) {
  let result;
  if (typeof promiseFn === "function") {
    result = promiseFn();
    if (!isPromiseLike(result)) {
      throw promiseReturnError(result);
    }
  } else if (isPromiseLike(promiseFn)) {
    result = promiseFn;
  } else {
    throw invalidArgType("promiseFn", "of type function or an instance of Promise", promiseFn);
  }
  try {
    await result;
  } catch (error) {
    return error;
  }
  return NO_EXCEPTION;
}

function isErrorConstructor(value) {
  if (value === Error) return true;
  try {
    return typeof value === "function" && value.prototype instanceof Error;
  } catch {
    return false;
  }
}

function expectedException(actual, expected, message, fn) {
  let generatedMessage = false;
  let failed = false;

  if (typeof expected !== "function") {
    if (isRegExpValue(expected)) {
      const str = String(actual);
      if (expected.test(str)) return;
      if (!message) {
        generatedMessage = true;
        message =
          "The input did not match the regular expression " +
          `${inspectValue(expected)}. Input:\n\n${inspectValue(str)}\n`;
      }
      failed = true;
    } else if (typeof actual !== "object" || actual === null) {
      const error = new AssertionError({
        actual,
        expected,
        message,
        operator: "deepStrictEqual",
        stackStartFn: fn,
      });
      error.operator = fn.name;
      throw error;
    } else {
      const keys = Object.keys(expected);
      if (isErrorValue(expected)) {
        keys.push("name", "message");
      } else if (keys.length === 0) {
        throw invalidArgValue("error", expected, "may not be an empty object");
      }
      for (const key of keys) {
        if (
          typeof actual[key] === "string" &&
          isRegExpValue(expected[key]) &&
          expected[key].test(actual[key])
        ) {
          continue;
        }
        if (!(key in actual) || !isDeepStrictEqual(actual[key], expected[key])) {
          if (!message) {
            const validationError = new AssertionError({
              actual,
              expected,
              operator: "deepStrictEqual",
              stackStartFn: fn,
            });
            validationError.operator = fn.name;
            throw validationError;
          }
          innerFail({
            actual,
            expected,
            message: [message],
            operator: fn.name,
            stackStartFn: fn,
          });
        }
      }
      return;
    }
  } else if (
    expected.prototype !== undefined &&
    actual instanceof expected
  ) {
    return;
  } else if (isErrorConstructor(expected)) {
    if (!message) {
      generatedMessage = true;
      message =
        'The error is expected to be an instance of ' +
        `"${expected.name}". Received `;
      if (isErrorValue(actual)) {
        const name =
          (actual.constructor && actual.constructor.name) || actual.name;
        if (expected.name === name) {
          message += "an error with identical name but a different prototype.";
        } else {
          message += `"${name}"`;
        }
        if (actual.message) {
          message += `\n\nError message:\n\n${actual.message}`;
        }
      } else {
        message += `"${inspect(actual, { depth: -1 })}"`;
      }
    }
    failed = true;
  } else {
    const res = expected.call({}, actual);
    if (res !== true) {
      if (!message) {
        generatedMessage = true;
        const name = expected.name ? `"${expected.name}" ` : "";
        message =
          `The ${name}validation function is expected to return` +
          ` "true". Received ${inspectValue(res)}`;
        if (isErrorValue(actual)) {
          message += `\n\nCaught error:\n\n${actual}`;
        }
      }
      failed = true;
    }
  }

  if (failed) {
    const error = new AssertionError({
      actual,
      expected,
      message,
      operator: fn.name,
      stackStartFn: fn,
      generatedMessage,
    });
    error.generatedMessage = generatedMessage;
    throw error;
  }
}

function expectsError(fn, actual, args) {
  let error = args[0];
  let message = args[1];

  if (typeof error === "string") {
    if (args.length > 1) {
      throw invalidArgType(
        "error",
        "of type function or an instance of Error, RegExp, or Object",
        error,
      );
    }
    if (typeof actual === "object" && actual !== null) {
      if (actual.message === error) {
        throw ambiguousArgument(
          "error/message",
          `The "error/message" argument is ambiguous. The error message "${actual.message}" is identical to the message.`,
        );
      }
    } else if (actual === error) {
      throw ambiguousArgument(
        "error/message",
        `The "error/message" argument is ambiguous. The error "${actual}" is identical to the message.`,
      );
    }
    message = error;
    error = undefined;
  } else if (
    error !== null &&
    error !== undefined &&
    typeof error !== "object" &&
    typeof error !== "function"
  ) {
    throw invalidArgType(
      "error",
      "of type function or an instance of Error, RegExp, or Object",
      error,
    );
  }

  if (actual === NO_EXCEPTION) {
    let details = "";
    if (error && error.name) details += ` (${error.name})`;
    details += message ? `: ${message}` : ".";
    const type = fn === rejects ? "rejection" : "exception";
    innerFail({
      actual: undefined,
      expected: error,
      operator: fn.name,
      message: [`Missing expected ${type}${details}`],
      stackStartFn: fn,
      generatedMessage: false,
    });
  }

  if (!error) return;
  expectedException(actual, error, message, fn);
}

function throws(fn, ...args) {
  expectsError(throws, getActual(fn), args);
}

async function rejects(promiseFn, ...args) {
  expectsError(rejects, await waitForActual(promiseFn), args);
}

function hasMatchingError(actual, expected) {
  if (typeof expected !== "function") {
    if (isRegExpValue(expected)) {
      return expected.test(String(actual));
    }
    throw invalidArgType("expected", "of type function or an instance of RegExp", expected);
  }
  if (expected.prototype !== undefined && actual instanceof expected) {
    return true;
  }
  if (isErrorConstructor(expected)) return false;
  return expected.call({}, actual);
}

function expectsNoError(fn, actual, args) {
  if (actual === NO_EXCEPTION) return;
  let error = args[0];
  let message = args[1];
  if (typeof error === "string") {
    message = error;
    error = undefined;
  }
  if (!error || hasMatchingError(actual, error)) {
    const details = message ? `: ${message}` : ".";
    const type = fn === doesNotReject ? "rejection" : "exception";
    innerFail({
      actual,
      expected: error,
      operator: fn.name,
      message: [
        `Got unwanted ${type}${details}\n` +
          `Actual message: "${actual && actual.message}"`,
      ],
      stackStartFn: fn,
      generatedMessage: false,
    });
  }
  throw actual;
}

function doesNotThrow(fn, ...args) {
  expectsNoError(doesNotThrow, getActual(fn), args);
}

async function doesNotReject(fn, ...args) {
  expectsNoError(doesNotReject, await waitForActual(fn), args);
}

// ---------------------------------------------------------------------------
// Module wiring
// ---------------------------------------------------------------------------

assert.ok = ok;
assert.equal = equal;
assert.notEqual = notEqual;
assert.strictEqual = strictEqual;
assert.notStrictEqual = notStrictEqual;
assert.deepEqual = deepEqual;
assert.notDeepEqual = notDeepEqual;
assert.deepStrictEqual = deepStrictEqual;
assert.notDeepStrictEqual = notDeepStrictEqual;
assert.fail = fail;
assert.ifError = ifError;
assert.match = match;
assert.doesNotMatch = doesNotMatch;
assert.throws = throws;
assert.rejects = rejects;
assert.doesNotThrow = doesNotThrow;
assert.doesNotReject = doesNotReject;
assert.AssertionError = AssertionError;

function strict(...args) {
  innerOk(strict, args);
}

Object.assign(strict, assert, {
  equal: strictEqual,
  notEqual: notStrictEqual,
  deepEqual: deepStrictEqual,
  notDeepEqual: notDeepStrictEqual,
});
strict.strict = strict;
strict.AssertionError = AssertionError;

assert.strict = strict;

module.exports = assert;
