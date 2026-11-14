"use strict";

// `crypto` — random bytes, hashing, HMAC and HKDF.
//
// The host exposes synchronous, CPU-only primitives as `__ln_host.crypto`
// (`docs/m3-plan.md` §2.3); this file is the Node-shaped surface over them. It
// never requires `node:crypto` and only reads `__ln_host` at call time, so
// loading it under plain Node (the differential oracle) does not crash.
//
// Fidelity notes (tracked in `docs/compat.md`):
//   - `getHashes()` lists the digests onde implements (the SHA-2 family plus MD5/SHA-1),
//     not Node's full OpenSSL catalog: SHA-3, BLAKE2, RIPEMD-160, SM3 and the XOFs are
//     not available without new RustCrypto dependencies.
//   - `hkdf(...)` without a callback is an onde extension: Node's `hkdf` is
//     async-only and its sync form is `hkdfSync`. The optional callback is
//     delivered with `queueMicrotask` (no thread pool) and receives an
//     `ArrayBuffer`, which is what Node's callback form yields.
//   - `Hmac` has no `copy()`: Node has none and the host contract has no
//     `hmacCopy` primitive.
//   - `getRandomValues` is the module-level WebCrypto helper Node also exports;
//     `subtle`, `webcrypto` and the `KeyObject`/`CryptoKey` family stay absent
//     until M7.
//   - `randomFill` completes inside a microtask rather than on the libuv thread
//     pool, so the fill itself is synchronous CPU work; the callback contract
//     (asynchronous delivery, buffer identity) is unchanged.
//   - A second `digest()` throws `ERR_CRYPTO_HASH_FINALIZED` on Hmac too; Node
//     v26 returns an empty buffer there (its own reuse quirk, DEP0206). M3
//     deliberately refuses a finalized object on both surfaces.

let bufferModule;
try {
  bufferModule = require("buffer");
} catch (_) {
  // Loaded by path (for example by the differential oracle) instead of through
  // the builtin table.
  bufferModule = require("./buffer.js");
}
const Buffer = bufferModule.Buffer || bufferModule;

const HASH_NAMES = [
  "md5",
  "sha1",
  "sha224",
  "sha256",
  "sha384",
  "sha512",
  "sha512-224",
  "sha512-256",
];

const DIGEST_SIZES = Object.assign(Object.create(null), {
  md5: 16,
  sha1: 20,
  sha224: 28,
  sha256: 32,
  sha384: 48,
  sha512: 64,
  "sha512-224": 28,
  "sha512-256": 32,
});

// OpenSSL spellings Node accepts on top of the bare names (`createHash("sha-256")`). Node
// accepts exactly these forms: `sha-512-224` and `sha512/224` are *not* aliases.
const ALGORITHM_ALIASES = Object.assign(Object.create(null), {
  "sha-1": "sha1",
  "sha-224": "sha224",
  "sha-256": "sha256",
  "sha-384": "sha384",
  "sha-512": "sha512",
  "sha2-224": "sha224",
  "sha2-256": "sha256",
  "sha2-384": "sha384",
  "sha2-512": "sha512",
  "sha-512/224": "sha512-224",
  "sha-512/256": "sha512-256",
  "sha2-512/224": "sha512-224",
  "sha2-512/256": "sha512-256",
});

const MAX_RANDOM_BYTES = 2147483647; // Node's kMaxPossibleLength for randomBytes/randomFill
const MAX_RANDOM_RANGE = 281474976710655; // 2^48 - 1, Node's RAND_MAX for randomInt
const MAX_SAFE_INTEGER = 9007199254740991;
const MAX_HKDF_INFO_BYTES = 1024;
const MAX_GET_RANDOM_VALUES_BYTES = 65536; // WebCrypto's getRandomValues quota

// Handle state is private so `Object.keys(hash)` stays as empty as Node's.
const kAlgorithm = Symbol("lite.crypto.algorithm");
const kHandle = Symbol("lite.crypto.handle");
const kFinalized = Symbol("lite.crypto.finalized");

// ---------------------------------------------------------------------------------------------
// Errors
//
// The Rust `ln-error` crate is not reachable from JavaScript, so the coded argument errors are
// built here with Node's constructor, code and message text (probed against `node v26.10.0`).
// ---------------------------------------------------------------------------------------------

function makeError(Ctor, code, message) {
  const error = new Ctor(message);
  if (code !== undefined) error.code = code;
  return error;
}

/** Node's `determineSpecificType` rendering for `ERR_INVALID_ARG_TYPE`. */
function describeValue(value) {
  if (value === null || value === undefined) return String(value);
  const type = typeof value;
  if (type === "function") return `function ${value.name}`;
  if (type === "object") {
    const name = value.constructor && value.constructor.name;
    return `an instance of ${name || "Object"}`;
  }
  if (type === "bigint") return `type bigint (${value}n)`;
  if (type === "string") return `type string ('${value}')`;
  return `type ${type} (${String(value)})`;
}

function invalidArgType(name, expected, value) {
  return makeError(
    TypeError,
    "ERR_INVALID_ARG_TYPE",
    `The "${name}" argument must be ${expected}. Received ${describeValue(value)}`,
  );
}

/** Node says "property" (not "argument") for a validated option field. */
function invalidPropertyType(name, expected, value) {
  return makeError(
    TypeError,
    "ERR_INVALID_ARG_TYPE",
    `The "${name}" property must be of type ${expected}. Received ${describeValue(value)}`,
  );
}

/**
 * Node's `ERR_OUT_OF_RANGE` rendering: integers above 2^32 get `_` separators
 * (`281_474_976_710_656`), everything else is plain (`2147483648`).
 */
function formatNumber(value) {
  if (typeof value === "number" && Number.isInteger(value) && Math.abs(value) > 2 ** 32) {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, "_");
  }
  return String(value);
}

function outOfRange(name, range, value) {
  return makeError(
    RangeError,
    "ERR_OUT_OF_RANGE",
    `The value of "${name}" is out of range. It must be ${range}. Received ${formatNumber(value)}`,
  );
}

function hashFinalizedError() {
  return makeError(Error, "ERR_CRYPTO_HASH_FINALIZED", "Digest already called");
}

function invalidDigestError(digest) {
  return makeError(TypeError, "ERR_CRYPTO_INVALID_DIGEST", `Invalid digest: ${digest}`);
}

// ---------------------------------------------------------------------------------------------
// Host and byte helpers
// ---------------------------------------------------------------------------------------------

function hostCrypto() {
  const host = globalThis.__ln_host;
  const crypto = host === undefined || host === null ? undefined : host.crypto;
  if (crypto === undefined || crypto === null) {
    // Not a Node error: this only happens when the module runs outside onde without the
    // differential oracle's host shim.
    throw new Error("crypto is unavailable: __ln_host.crypto is not installed");
  }
  return crypto;
}

function isAnyArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return true;
  return typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer;
}

function isArrayBufferView(value) {
  return Buffer.isBuffer(value) || ArrayBuffer.isView(value);
}

/** The exact bytes Node would hash/compare: raw view bytes, or a whole ArrayBuffer. */
function byteView(value) {
  if (isAnyArrayBuffer(value)) return new Uint8Array(value, 0, value.byteLength);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function lookupAlgorithm(name) {
  // Node's OpenSSL lookup lowercases but does not trim: `" sha256 "` is an unknown digest.
  let key = name.toLowerCase();
  const alias = ALGORITHM_ALIASES[key];
  if (alias !== undefined) key = alias;
  return HASH_NAMES.indexOf(key) === -1 ? null : key;
}

/** `update(string, encoding)`: unknown encodings fall back to utf8, as Node's native hash does. */
function inputEncoding(data, encoding) {
  if (typeof encoding !== "string" || encoding.length === 0) return "utf8";
  const lower = encoding.toLowerCase();
  if (lower === "hex" && data.length % 2 !== 0) {
    throw makeError(
      TypeError,
      "ERR_INVALID_ARG_VALUE",
      `The argument 'encoding' is invalid for data of length ${data.length}. Received '${encoding}'`,
    );
  }
  return Buffer.isEncoding(encoding) ? encoding : "utf8";
}

/** Hash/Hmac `update` accepts a string or any ArrayBufferView, but not a raw ArrayBuffer. */
function hashInput(data, encoding) {
  if (typeof data === "string") return Buffer.from(data, inputEncoding(data, encoding));
  if (isArrayBufferView(data)) return byteView(data);
  throw invalidArgType(
    "data",
    "of type string or an instance of Buffer, TypedArray, or DataView",
    data,
  );
}

/** `digest([encoding])`: a known Buffer encoding becomes a string, anything else stays a Buffer. */
function encodeDigest(bytes, encoding) {
  const buffer = Buffer.from(bytes);
  if (!encoding) return buffer;
  const name = `${encoding}`;
  if (name === "buffer" || name.length === 0 || !Buffer.isEncoding(name)) return buffer;
  return buffer.toString(name);
}

// ---------------------------------------------------------------------------------------------
// Hash
// ---------------------------------------------------------------------------------------------

class Hash {
  constructor(algorithm, handle) {
    this[kAlgorithm] = algorithm;
    this[kHandle] = handle;
    this[kFinalized] = false;
  }

  update(data, inputEncoding) {
    if (this[kFinalized]) throw hashFinalizedError();
    // Validate/convert before touching the host so a bad argument cannot consume the state.
    const bytes = hashInput(data, inputEncoding);
    hostCrypto().hashUpdate(this[kHandle], bytes);
    return this;
  }

  digest(encoding) {
    if (this[kFinalized]) throw hashFinalizedError();
    const bytes = hostCrypto().hashDigest(this[kHandle]);
    this[kFinalized] = true;
    this[kHandle] = undefined;
    return encodeDigest(bytes, encoding);
  }

  copy() {
    if (this[kFinalized]) throw hashFinalizedError();
    return new Hash(this[kAlgorithm], hostCrypto().hashCopy(this[kHandle]));
  }
}

// ---------------------------------------------------------------------------------------------
// Hmac
// ---------------------------------------------------------------------------------------------

function hmacKeyBytes(key) {
  if (typeof key === "string") return Buffer.from(key, "utf8");
  if (isAnyArrayBuffer(key) || isArrayBufferView(key)) return byteView(key);
  throw invalidArgType(
    "key",
    "of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey",
    key,
  );
}

class Hmac {
  constructor(algorithm, handle) {
    this[kAlgorithm] = algorithm;
    this[kHandle] = handle;
    this[kFinalized] = false;
  }

  update(data, inputEncoding) {
    if (this[kFinalized]) throw hashFinalizedError();
    const bytes = hashInput(data, inputEncoding);
    hostCrypto().hmacUpdate(this[kHandle], bytes);
    return this;
  }

  digest(encoding) {
    if (this[kFinalized]) throw hashFinalizedError();
    const bytes = hostCrypto().hmacDigest(this[kHandle]);
    this[kFinalized] = true;
    this[kHandle] = undefined;
    return encodeDigest(bytes, encoding);
  }
}

// ---------------------------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------------------------

function createHash(algorithm) {
  if (typeof algorithm !== "string") {
    throw invalidArgType("algorithm", "of type string", algorithm);
  }
  const name = lookupAlgorithm(algorithm);
  if (name === null) {
    // Node's native binding raises a plain Error without a code for an unknown digest.
    throw new Error("Digest method not supported");
  }
  return new Hash(name, hostCrypto().hashNew(name));
}

function createHmac(algorithm, key) {
  if (typeof algorithm !== "string") {
    throw invalidArgType("hmac", "of type string", algorithm);
  }
  // Node prepares the key before the algorithm reaches the native init, so a bad key wins over
  // an unknown digest.
  const keyBytes = hmacKeyBytes(key);
  const name = lookupAlgorithm(algorithm);
  if (name === null) throw invalidDigestError(algorithm);
  return new Hmac(name, hostCrypto().hmacNew(name, keyBytes));
}

function getHashes() {
  return HASH_NAMES.slice();
}

// ---------------------------------------------------------------------------------------------
// Random
// ---------------------------------------------------------------------------------------------

function randomBytes(size, callback) {
  if (typeof size !== "number") {
    throw invalidArgType("size", "of type number", size);
  }
  if (Number.isNaN(size) || size < 0 || size > MAX_RANDOM_BYTES) {
    throw outOfRange("size", `>= 0 && <= ${MAX_RANDOM_BYTES}`, size);
  }
  if (callback !== undefined && typeof callback !== "function") {
    throw invalidArgType("callback", "of type function", callback);
  }

  const length = Math.trunc(size) || 0;
  const bytes = Buffer.from(hostCrypto().randomBytes(length));
  if (callback === undefined) return bytes;
  queueMicrotask(() => callback(null, bytes));
  return undefined;
}

function randomInt(min, max, callback) {
  // Node's optional-min syntax: randomInt(max) and randomInt(max, callback).
  const minNotSpecified = max === undefined || typeof max === "function";
  if (minNotSpecified) {
    callback = max;
    max = min;
    min = 0;
  }

  const isSync = callback === undefined;
  if (!isSync && typeof callback !== "function") {
    throw invalidArgType("callback", "of type function", callback);
  }
  if (!Number.isSafeInteger(min)) {
    throw invalidArgType("min", "a safe integer", min);
  }
  if (!Number.isSafeInteger(max)) {
    throw invalidArgType("max", "a safe integer", max);
  }
  if (max <= min) {
    throw outOfRange("max", `greater than the value of "min" (${min})`, max);
  }
  const range = max - min;
  if (!(range <= MAX_RANDOM_RANGE)) {
    throw outOfRange(
      minNotSpecified ? "max" : "max - min",
      `<= ${MAX_RANDOM_RANGE}`,
      range,
    );
  }

  const value = hostCrypto().randomInt(min, max);
  if (isSync) return value;
  queueMicrotask(() => callback(null, value));
  return undefined;
}

function randomUUID(options) {
  if (options !== undefined && (typeof options !== "object" || options === null)) {
    throw invalidArgType("options", "of type object", options);
  }
  return hostCrypto().randomUUID();
}

function formatUuid(bytes) {
  const hex = [];
  for (let index = 0; index < 16; index += 1) {
    hex.push((bytes[index] < 16 ? "0" : "") + bytes[index].toString(16));
  }
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-` +
    `${joined.slice(16, 20)}-${joined.slice(20)}`;
}

// RFC 9562 version 7 (Unix-ms timestamp + random tail), the shape Node's `randomUUIDv7` emits.
// The entropy cache Node keeps internally is an implementation detail; the observable format
// and the absence of an intra-millisecond ordering guarantee are the same.
function randomUUIDv7(options) {
  if (options !== undefined) {
    if (typeof options !== "object" || options === null) {
      throw invalidArgType("options", "of type object", options);
    }
    const disableEntropyCache = options.disableEntropyCache;
    if (disableEntropyCache !== undefined && typeof disableEntropyCache !== "boolean") {
      throw invalidPropertyType("options.disableEntropyCache", "boolean", disableEntropyCache);
    }
  }

  const bytes = new Uint8Array(hostCrypto().randomBytes(16));
  const now = Date.now();
  // 48-bit big-endian millisecond timestamp; JS bitwise operators stop at 32 bits, so shift
  // with division.
  bytes[0] = Math.floor(now / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(now / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(now / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(now / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
}

// `randomFillSync(buf[, offset][, size])` and `randomFill(buf[, offset][, size], callback)`
// share this validation; it returns the bytes to write and where to write them.

function fillPlan(buf, offset, size) {
  if (!isAnyArrayBuffer(buf) && !isArrayBufferView(buf)) {
    throw invalidArgType("buf", "an instance of ArrayBuffer or ArrayBufferView", buf);
  }
  const byteLength = buf.byteLength;
  if (offset === undefined) offset = 0;
  else if (typeof offset !== "number") throw invalidArgType("offset", "of type number", offset);
  // Node compares the raw value, so NaN and a fractional out-of-range offset both fail here.
  if (!(offset >= 0 && offset <= byteLength)) {
    throw outOfRange("offset", `>= 0 && <= ${byteLength}`, offset);
  }

  if (size === undefined) size = byteLength - offset;
  else if (typeof size !== "number") throw invalidArgType("size", "of type number", size);
  if (!(size >= 0 && size <= MAX_RANDOM_BYTES)) {
    throw outOfRange("size", `>= 0 && <= ${MAX_RANDOM_BYTES}`, size);
  }
  if (!(offset + size <= byteLength)) {
    throw outOfRange("size + offset", `<= ${byteLength}`, offset + size);
  }

  // A fractional offset/size inside the range is truncated when written, as in Node's native
  // fill; the range checks above still use the untruncated values.
  const target = isAnyArrayBuffer(buf)
    ? new Uint8Array(buf, 0, byteLength)
    : new Uint8Array(buf.buffer, buf.byteOffset, byteLength);
  return {
    target,
    offset: Math.trunc(offset),
    length: Math.trunc(size),
  };
}

function writeRandom(plan) {
  if (plan.length === 0) return;
  plan.target.set(new Uint8Array(hostCrypto().randomBytes(plan.length)), plan.offset);
}

function randomFillSync(buf, offset, size) {
  const plan = fillPlan(buf, offset, size);
  writeRandom(plan);
  return buf;
}

function randomFill(buf, offset, size, callback) {
  if (typeof offset === "function") {
    callback = offset;
    offset = 0;
    size = undefined;
  } else if (typeof size === "function") {
    callback = size;
    size = undefined;
  }
  if (typeof callback !== "function") {
    throw invalidArgType("callback", "of type function", callback);
  }
  // Validate synchronously (Node throws here), then fill inside the deferred callback so a
  // caller cannot observe a half-written buffer before the callback runs.
  const plan = fillPlan(buf, offset, size);
  queueMicrotask(() => {
    writeRandom(plan);
    callback(null, buf);
  });
  return undefined;
}

// WebCrypto's `getRandomValues`, which Node also exposes on the `crypto` module. Only
// integer-backed typed arrays are accepted, by prototype (so `Buffer` and subclasses of
// `Uint8Array` work, exactly as in Node); `DataView` and the float arrays are not.
function isIntegerTypedArray(value) {
  if (
    value instanceof Int8Array ||
    value instanceof Uint8Array ||
    value instanceof Uint8ClampedArray ||
    value instanceof Int16Array ||
    value instanceof Uint16Array ||
    value instanceof Int32Array ||
    value instanceof Uint32Array
  ) {
    return true;
  }
  return (
    (typeof BigInt64Array !== "undefined" && value instanceof BigInt64Array) ||
    (typeof BigUint64Array !== "undefined" && value instanceof BigUint64Array)
  );
}

function getRandomValues(typedArray) {
  if (!isIntegerTypedArray(typedArray)) {
    throw new DOMException(
      "The data argument must be an integer-type TypedArray",
      "TypeMismatchError",
    );
  }
  if (typedArray.byteLength > MAX_GET_RANDOM_VALUES_BYTES) {
    throw new DOMException(
      `The requested length exceeds ${String(MAX_GET_RANDOM_VALUES_BYTES).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} bytes`,
      "QuotaExceededError",
    );
  }
  if (typedArray.byteLength > 0) {
    const view = new Uint8Array(
      typedArray.buffer,
      typedArray.byteOffset,
      typedArray.byteLength,
    );
    view.set(new Uint8Array(hostCrypto().randomBytes(typedArray.byteLength)));
  }
  return typedArray;
}

// `hash(algorithm, data[, outputEncoding])`: the one-shot form Node added in v20.12. It differs
// from `createHash(...).digest(encoding)` in three ways: the default output is hex (not a
// Buffer), `"buffer"` asks for a Buffer, and the encoding is validated up front.
function hash(algorithm, input, outputEncoding) {
  if (typeof algorithm !== "string") {
    throw invalidArgType("algorithm", "of type string", algorithm);
  }
  if (typeof input !== "string" && !isArrayBufferView(input)) {
    throw invalidArgType(
      "input",
      "of type string or an instance of Buffer, TypedArray, or DataView",
      input,
    );
  }

  let encoding = "hex";
  if (typeof outputEncoding === "string") {
    encoding = outputEncoding;
  } else if (outputEncoding !== undefined) {
    if (outputEncoding === null || typeof outputEncoding !== "object") {
      throw invalidArgType("options", "of type object", outputEncoding);
    }
    const requested = outputEncoding.outputEncoding;
    if (requested !== undefined) {
      if (typeof requested !== "string") {
        throw invalidArgType("outputEncoding", "of type string", requested);
      }
      encoding = requested;
    }
  }
  if (encoding === "") encoding = "utf8";
  if (encoding !== "buffer" && !Buffer.isEncoding(encoding)) {
    throw makeError(
      TypeError,
      "ERR_INVALID_ARG_VALUE",
      `The argument 'outputEncoding' is invalid. Received '${encoding}'`,
    );
  }

  const name = lookupAlgorithm(algorithm);
  if (name === null) {
    // The one-shot form includes the name in the message; `createHash` does not.
    throw new Error(`Digest method ${algorithm} is not supported`);
  }
  const digest = createHash(name).update(input).digest();
  return encoding === "buffer" ? digest : digest.toString(encoding);
}

// ---------------------------------------------------------------------------------------------
// timingSafeEqual
// ---------------------------------------------------------------------------------------------

function compareInput(value, name) {
  if (isAnyArrayBuffer(value) || isArrayBufferView(value)) return byteView(value);
  // Node's native binding builds this message without a "Received ..." suffix.
  throw makeError(
    TypeError,
    "ERR_INVALID_ARG_TYPE",
    `The "${name}" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.`,
  );
}

function timingSafeEqual(buf1, buf2) {
  const left = compareInput(buf1, "buf1");
  const right = compareInput(buf2, "buf2");
  if (left.byteLength !== right.byteLength) {
    throw makeError(
      RangeError,
      "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH",
      "Input buffers must have the same byte length",
    );
  }
  return hostCrypto().timingSafeEqual(left, right);
}

// ---------------------------------------------------------------------------------------------
// HKDF
// ---------------------------------------------------------------------------------------------

function hkdfKeyBytes(value) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (isAnyArrayBuffer(value) || isArrayBufferView(value)) return byteView(value);
  throw invalidArgType(
    "ikm",
    "of type string or an instance of SecretKeyObject, ArrayBuffer, TypedArray, DataView, or Buffer",
    value,
  );
}

function hkdfByteSource(value, name) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (isAnyArrayBuffer(value) || isArrayBufferView(value)) return byteView(value);
  throw invalidArgType(
    name,
    "of type string or an instance of ArrayBuffer, TypedArray, DataView, or Buffer",
    value,
  );
}

// Node validates the parameters before the digest name or the callback, in this order.
function hkdfParams(digest, ikm, salt, info, keylen) {
  if (typeof digest !== "string") {
    throw invalidArgType("digest", "of type string", digest);
  }
  const ikmBytes = hkdfKeyBytes(ikm);
  const saltBytes = hkdfByteSource(salt, "salt");
  const infoBytes = hkdfByteSource(info, "info");

  if (typeof keylen !== "number") {
    throw invalidArgType("length", "of type number", keylen);
  }
  if (!Number.isInteger(keylen)) {
    throw outOfRange("length", "an integer", keylen);
  }
  if (keylen < 0 || keylen > MAX_SAFE_INTEGER) {
    throw outOfRange("length", `>= 0 && <= ${MAX_SAFE_INTEGER}`, keylen);
  }
  if (infoBytes.byteLength > MAX_HKDF_INFO_BYTES) {
    // Node's wording really does repeat "must" here; keep it for message parity.
    throw outOfRange("info", "must not contain more than 1024 bytes", infoBytes.byteLength);
  }
  return { digest, ikmBytes, saltBytes, infoBytes, keylen };
}

function hkdfBytes({ digest, ikmBytes, saltBytes, infoBytes, keylen }) {
  const algorithm = lookupAlgorithm(digest);
  if (algorithm === null) throw invalidDigestError(digest);
  const maxLength = 255 * DIGEST_SIZES[algorithm];
  if (keylen > maxLength) {
    throw makeError(RangeError, "ERR_CRYPTO_INVALID_KEYLEN", "Invalid key length");
  }
  return Buffer.from(
    hostCrypto().hkdf(algorithm, ikmBytes, saltBytes, infoBytes, keylen),
  );
}

function hkdf(digest, ikm, salt, info, keylen, callback) {
  const params = hkdfParams(digest, ikm, salt, info, keylen);
  if (callback !== undefined && typeof callback !== "function") {
    throw invalidArgType("callback", "of type function", callback);
  }
  const result = hkdfBytes(params);
  if (callback === undefined) return result;
  // Node's callback form hands back an ArrayBuffer; onde's sync `hkdf` stays a Buffer.
  const arrayBuffer = result.buffer.slice(
    result.byteOffset,
    result.byteOffset + result.byteLength,
  );
  queueMicrotask(() => callback(null, arrayBuffer));
  return undefined;
}

/** Node's synchronous HKDF: same parameters as `hkdf`, but it always returns an ArrayBuffer. */
function hkdfSync(digest, ikm, salt, info, keylen) {
  const result = hkdfBytes(hkdfParams(digest, ikm, salt, info, keylen));
  return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
}

module.exports = {
  createHash,
  createHmac,
  getHashes,
  getRandomValues,
  hash,
  hkdf,
  hkdfSync,
  randomBytes,
  randomFill,
  randomFillSync,
  randomInt,
  randomUUID,
  randomUUIDv7,
  timingSafeEqual,
};
