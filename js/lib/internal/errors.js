"use strict";

// The single JavaScript copy of Node's coded-error vocabulary.
//
// Node's `lib/internal/errors.js` is the reference for every message built here; the Rust
// `ln-error` crate (`crates/ln-error/src/lib.rs`) is the counterpart that native code uses.
// The two must agree: an invalid call from JavaScript and one that crosses a host boundary
// should read the same.
//
// This module is deliberately a leaf — it requires nothing at all — so every stdlib module can
// depend on it regardless of load order, including `<lite:...>` modules that are resolved
// through the virtual registry.

/**
 * Construct `Ctor` with `message`, attaching `code` when one is given.
 *
 * `code` is optional for errors that only need a constructor and a message.
 */
function coded(Ctor, code, message) {
  const error = new Ctor(message);
  if (code !== undefined) error.code = code;
  return error;
}

/**
 * Node's `determineSpecificType` rendering, used by `ERR_INVALID_ARG_TYPE`.
 *
 * This is not `util.inspect`: it names the value's kind in the message ("type number (1)",
 * "an instance of Buffer") so the reader sees what arrived without an inline dump.
 */
function describeValue(value) {
  if (value === null || value === undefined) return String(value);
  const type = typeof value;
  if (type === "function") return value.name ? `function ${value.name}` : "function";
  if (type === "object") {
    let name = "Object";
    try {
      if (value.constructor && value.constructor.name) name = value.constructor.name;
    } catch {
      // A Proxy may throw from the `constructor` getter; the generic name is enough.
    }
    return `an instance of ${name}`;
  }
  if (type === "bigint") return `type bigint (${value}n)`;
  if (type === "string") return `type string ('${value}')`;
  if (type === "symbol") return `type symbol (${String(value)})`;
  return `type ${type} (${String(value)})`;
}

/**
 * Build the `ERR_INVALID_ARG_TYPE` TypeError.
 *
 * `expected` may be a bare type (`"string"`), a clause (`"of type string"`,
 * `"an instance of Buffer or Uint8Array"`), or a complete `must ...` phrase. It is normalised
 * the way `ln-error::invalid_arg_type` does it, so a dotted `name` is a property and a leading
 * `of type ` is not doubled.
 */
function invalidArgType(name, expected, actual) {
  return buildInvalidArgType(name, expected, actual, false);
}

/**
 * `ERR_INVALID_ARG_TYPE` for a validated option field.
 *
 * Same formatter as {@link invalidArgType}; the wording is forced to "property" even when the
 * caller's name has no dot (`options.signal` already contains one, but a passed-down field name
 * may not).
 */
function invalidPropertyType(name, expected, actual) {
  return buildInvalidArgType(name, expected, actual, true);
}

function buildInvalidArgType(name, expected, actual, forceProperty) {
  if (Array.isArray(expected)) expected = expected.join(" or ");
  const kind = forceProperty || name.includes(".") ? "property" : "argument";
  if (expected.startsWith("of type ")) expected = expected.slice("of type ".length);

  let clause;
  if (expected.startsWith("must ")) {
    clause = expected;
  } else if (
    expected.startsWith("an instance of ") ||
    expected.startsWith("one of ") ||
    expected.startsWith("an ")
  ) {
    clause = `must be ${expected}`;
  } else if (expected === "Object") {
    clause = "must be an instance of Object";
  } else {
    clause = `must be of type ${expected}`;
  }

  const message = name.endsWith(" argument")
    ? // Node special-cases names like `last argument`: no quotes and no extra noun.
      `The ${name} ${clause}. Received ${describeValue(actual)}`
    : `The "${name}" ${kind} ${clause}. Received ${describeValue(actual)}`;
  return coded(TypeError, "ERR_INVALID_ARG_TYPE", message);
}

/**
 * Render a value for `ERR_INVALID_ARG_VALUE` without pulling in `util.inspect`.
 *
 * Node uses its inspector there; the local shape is the subset the stdlib needs: quoted
 * strings, suffixed bigints, Buffer's `<Buffer ...>` form and a compact JSON fallback for
 * plain objects and arrays.
 */
function inspectArg(value) {
  const type = typeof value;
  if (type === "string") return `'${value}'`;
  if (type === "bigint") return `${value}n`;
  if (
    value instanceof Uint8Array &&
    value.constructor &&
    value.constructor.name === "Buffer"
  ) {
    if (value.length === 0) return "<Buffer >";
    let hex = "";
    for (let i = 0; i < value.length; i++) hex += value[i].toString(16).padStart(2, "0");
    return `<Buffer ${hex}>`;
  }
  if (value !== null && type === "object") {
    try {
      const json = JSON.stringify(value);
      if (json !== undefined) return json;
    } catch {
      // Circular or otherwise unstringifiable; fall through to String().
    }
  }
  return String(value);
}

/** Build the `ERR_INVALID_ARG_VALUE` TypeError, truncating the inspected value like Node. */
function invalidArgValue(name, value, reason) {
  const rendered = inspectArg(value);
  const inspected = rendered.length > 128 ? `${rendered.slice(0, 128)}...` : rendered;
  return coded(
    TypeError,
    "ERR_INVALID_ARG_VALUE",
    `The argument '${name}' ${reason}. Received ${inspected}`,
  );
}

/** Build the `ERR_MISSING_ARGS` TypeError for one or more required names. */
function missingArgs(...names) {
  const quoted = names.map((name) => `"${name}"`);
  const list =
    quoted.length === 1
      ? quoted[0]
      : `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
  return coded(
    TypeError,
    "ERR_MISSING_ARGS",
    `The ${list} argument${names.length > 1 ? "s" : ""} must be specified`,
  );
}

/**
 * Node's `ERR_OUT_OF_RANGE` number rendering: integers whose magnitude exceeds 2^32 get `_`
 * separators (`281_474_976_710_656`), bigints get separators too and keep their `n`.
 */
function formatNumber(value) {
  if (typeof value === "bigint") {
    return `${String(value).replace(/\B(?=(\d{3})+(?!\d))/g, "_")}n`;
  }
  if (typeof value === "number" && Number.isInteger(value) && Math.abs(value) > 2 ** 32) {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, "_");
  }
  return String(value);
}

/** Build the `ERR_OUT_OF_RANGE` RangeError. */
function outOfRange(name, range, value) {
  return coded(
    RangeError,
    "ERR_OUT_OF_RANGE",
    `The value of "${name}" is out of range. It must be ${range}. Received ${formatNumber(value)}`,
  );
}

/** Build the `ERR_UNKNOWN_ENCODING` TypeError. */
function unknownEncoding(label) {
  return coded(TypeError, "ERR_UNKNOWN_ENCODING", `Unknown encoding: ${String(label)}`);
}

/**
 * Build Node's `AbortError`.
 *
 * `cause` is set only when the caller has a reason; an aborted signal with no reason keeps the
 * error shape Node produces for `AbortController.abort()` called with no argument.
 */
function abortError(reason) {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  if (reason !== undefined) error.cause = reason;
  return error;
}

module.exports = {
  coded,
  describeValue,
  invalidArgType,
  invalidArgValue,
  invalidPropertyType,
  missingArgs,
  outOfRange,
  unknownEncoding,
  abortError,
};
