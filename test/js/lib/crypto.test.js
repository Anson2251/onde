"use strict";

// Runtime-agnostic self-check for js/lib/crypto.js. Runs under `node` and under
// lite: no `node:` imports, no test framework, only the module under test.
//
// Under plain Node the lite host (`__ln_host.crypto`) is absent, so the file
// prints one skip line and exits 0; the lite run does the asserting.

if (typeof globalThis.__ln_host !== "object") {
  console.log("skip: lite host unavailable");
  process.exit(0);
}

const crypto = require("../../../js/lib/crypto.js");

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

function eq(actual, expected, message) {
  record(actual === expected, `${message} (expected ${String(expected)}, got ${String(actual)})`);
}

function bytesEq(actual, expectedHex, message) {
  // Accepts a Buffer, a plain Uint8Array (hkdf callback results) or an already-hex string.
  const hex = typeof actual === "string" ? actual : Buffer.from(actual).toString("hex");
  eq(hex, expectedHex, message);
}

function throwsCode(fn, code, message) {
  try {
    fn();
    record(false, `${message} (expected a throw)`);
    return undefined;
  } catch (error) {
    record(error !== null && error !== undefined && error.code === code,
      `${message} (code was ${error && error.code})`);
    return error;
  }
}

function throwsMessage(fn, expected, message) {
  try {
    fn();
    record(false, `${message} (expected a throw)`);
    return undefined;
  } catch (error) {
    record(error !== null && error !== undefined && error.message === expected,
      `${message} (message was ${error && error.message})`);
    return error;
  }
}

function inRange(value, min, max) {
  return typeof value === "number" && value >= min && value < max;
}

// ---------------------------------------------------------------------------------------------
// Digest vectors (FIPS 180 / RFC 1321) for "abc"
// ---------------------------------------------------------------------------------------------

bytesEq(crypto.createHash("md5").update("abc").digest("hex"),
  "900150983cd24fb0d6963f7d28e17f72", "md5(abc)");
bytesEq(crypto.createHash("sha1").update("abc").digest("hex"),
  "a9993e364706816aba3e25717850c26c9cd0d89d", "sha1(abc)");
bytesEq(crypto.createHash("sha224").update("abc").digest("hex"),
  "23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7", "sha224(abc)");
bytesEq(crypto.createHash("sha256").update("abc").digest("hex"),
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "sha256(abc)");
bytesEq(crypto.createHash("sha384").update("abc").digest("hex"),
  "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed" +
  "8086072ba1e7cc2358baeca134c825a7", "sha384(abc)");
bytesEq(crypto.createHash("sha512").update("abc").digest("hex"),
  "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a" +
  "2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f", "sha512(abc)");
bytesEq(crypto.createHash("sha512-224").update("abc").digest("hex"),
  "4634270f707b6a54daae7530460842e20e37ed265ceee9a43e8924aa", "sha512-224(abc)");
bytesEq(crypto.createHash("sha512-256").update("abc").digest("hex"),
  "53048e2681941ef99b2e29b76b4c7dabe4c2d0c634fc6d46e0e2f13107e7af23", "sha512-256(abc)");

// ---------------------------------------------------------------------------------------------
// Hash object behaviour
// ---------------------------------------------------------------------------------------------

{
  const hash = crypto.createHash("sha256");
  record(hash.update("a") === hash, "update() returns this");
  hash.update("b").update("c");
  bytesEq(hash.digest(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    "chained updates hash abc");
}

{
  // Strings, Buffers, TypedArrays and DataViews are all accepted.
  const fromBuffer = crypto.createHash("sha256").update(Buffer.from("abc")).digest("hex");
  const fromTypedArray = crypto.createHash("sha256").update(new Uint8Array([97, 98, 99])).digest("hex");
  const view = new Uint8Array([0, 97, 98, 99, 0, 0]).subarray(1, 4);
  const fromView = crypto.createHash("sha256").update(view).digest("hex");
  const dataView = new Uint8Array([97, 98, 99]).buffer;
  const fromDataView = crypto.createHash("sha256").update(new DataView(dataView)).digest("hex");
  const expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  bytesEq(fromBuffer, expected, "update(Buffer)");
  bytesEq(fromTypedArray, expected, "update(TypedArray)");
  bytesEq(fromView, expected, "update(TypedArray view)");
  bytesEq(fromDataView, expected, "update(DataView)");
}

bytesEq(crypto.createHash("sha256").update("616263", "hex").digest("hex"),
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "update(string, hex)");

{
  const digest = crypto.createHash("sha256").update("abc");
  const buffer = digest.digest();
  record(Buffer.isBuffer(buffer), "digest() returns a Buffer");
  eq(buffer.length, 32, "digest() length");
}

{
  const hash = crypto.createHash("sha256").update("abc");
  const base = hash.copy();
  hash.update("def");
  bytesEq(base.digest("hex"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    "copy() keeps the state at copy time");
  bytesEq(hash.digest("hex"),
    "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721",
    "original keeps updating independently of copy()");
}

{
  bytesEq(crypto.createHash("sha256").update("abc").digest("base64"),
    "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=", "digest(base64)");
  bytesEq(crypto.createHash("sha256").update("abc").digest("base64url"),
    "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0", "digest(base64url)");
  record(typeof crypto.createHash("sha256").update("abc").digest("utf8") === "string",
    "digest(utf8) is a string");
  record(Buffer.isBuffer(crypto.createHash("sha256").update("abc").digest("nope")),
    "digest(unknown encoding) returns a Buffer");
  record(Buffer.isBuffer(crypto.createHash("sha256").update("abc").digest(5)),
    "digest(non-string encoding) returns a Buffer");
}

// Case-insensitive and OpenSSL-style spellings Node accepts.
bytesEq(crypto.createHash("SHA256").update("abc").digest("hex"),
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "algorithm is case-insensitive");
bytesEq(crypto.createHash("sha-256").update("abc").digest("hex"),
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "sha-256 alias");
bytesEq(crypto.createHash("sha2-224").update("abc").digest("hex"),
  "23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7", "sha2-224 alias");
bytesEq(crypto.createHash("sha-512/224").update("abc").digest("hex"),
  "4634270f707b6a54daae7530460842e20e37ed265ceee9a43e8924aa", "sha-512/224 alias");
bytesEq(crypto.createHash("sha2-512/256").update("abc").digest("hex"),
  "53048e2681941ef99b2e29b76b4c7dabe4c2d0c634fc6d46e0e2f13107e7af23", "sha2-512/256 alias");
// Node does not accept these spellings; neither do we.
throwsMessage(() => crypto.createHash("sha512/224"), "Digest method not supported",
  "sha512/224 is not an alias");
throwsMessage(() => crypto.createHash("sha-512-224"), "Digest method not supported",
  "sha-512-224 is not an alias");
throwsMessage(() => crypto.createHash(" sha256 "), "Digest method not supported",
  "whitespace-padded algorithm is not trimmed");

// Finalized objects refuse further work.
{
  const hash = crypto.createHash("sha256").update("abc");
  hash.digest();
  throwsCode(() => hash.update("x"), "ERR_CRYPTO_HASH_FINALIZED", "update after digest");
  throwsCode(() => hash.digest(), "ERR_CRYPTO_HASH_FINALIZED", "digest twice");
  throwsCode(() => hash.copy(), "ERR_CRYPTO_HASH_FINALIZED", "copy after digest");
}

// Argument errors.
{
  const unknown = throwsMessage(() => crypto.createHash("nope"), "Digest method not supported",
    "unknown digest message");
  record(unknown instanceof Error && unknown.code === undefined,
    "unknown digest is a plain Error without a code");
  eq(throwsCode(() => crypto.createHash(5), "ERR_INVALID_ARG_TYPE", "createHash(5)").name,
    "TypeError", "createHash(5) is a TypeError");
  throwsCode(() => crypto.createHash(), "ERR_INVALID_ARG_TYPE", "createHash()");
  throwsCode(() => crypto.createHash("sha256").update("abc", "hex"), "ERR_INVALID_ARG_VALUE",
    "odd-length hex input encoding");
  throwsCode(() => crypto.createHash("sha256").update(5), "ERR_INVALID_ARG_TYPE",
    "update(number)");
  throwsCode(() => crypto.createHash("sha256").update(null), "ERR_INVALID_ARG_TYPE",
    "update(null)");
}

// ---------------------------------------------------------------------------------------------
// HMAC (RFC 4231 case 2)
// ---------------------------------------------------------------------------------------------

{
  const hmac = crypto.createHmac("sha256", "Jefe");
  record(hmac.update("what do ya want for nothing?") === hmac, "hmac update() returns this");
  bytesEq(hmac.digest("hex"),
    "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843", "hmac-sha256 RFC 4231 #2");
}

// The SHA-2 truncations work through the same surface.
bytesEq(crypto.createHmac("sha224", "key")
  .update("The quick brown fox jumps over the lazy dog").digest("hex"),
  "88ff8b54675d39b8f72322e65ff945c52d96379988ada25639747e69", "hmac-sha224");
bytesEq(crypto.createHmac("sha512-224", "key")
  .update("The quick brown fox jumps over the lazy dog").digest("hex"),
  "a1afb4f708cb63570639195121785ada3dc615989cc3c73f38e306a3", "hmac-sha512-224");
bytesEq(crypto.createHmac("sha512-256", "key")
  .update("The quick brown fox jumps over the lazy dog").digest("hex"),
  "7fb65e03577da9151a1016e9c2e514d4d48842857f13927f348588173dca6d89", "hmac-sha512-256");

{
  const fromBuffer = crypto.createHmac("sha256", Buffer.from("Jefe"))
    .update("what do ya want for nothing?").digest("hex");
  const exactArrayBuffer = new Uint8Array([0x4a, 0x65, 0x66, 0x65]).buffer;
  const fromArrayBuffer = crypto.createHmac("sha256", exactArrayBuffer)
    .update("what do ya want for nothing?").digest("hex");
  eq(fromBuffer, "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    "hmac Buffer key");
  eq(fromArrayBuffer, "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    "hmac ArrayBuffer key");
}

{
  const hmac = crypto.createHmac("sha256", "k").update("x");
  hmac.digest();
  throwsCode(() => hmac.update("y"), "ERR_CRYPTO_HASH_FINALIZED", "hmac update after digest");
  throwsCode(() => hmac.digest(), "ERR_CRYPTO_HASH_FINALIZED", "hmac digest twice");
}

{
  eq(throwsCode(() => crypto.createHmac("nope", "k"), "ERR_CRYPTO_INVALID_DIGEST",
    "hmac unknown digest").name, "TypeError", "hmac unknown digest is a TypeError");
  throwsCode(() => crypto.createHmac("sha256", 5), "ERR_INVALID_ARG_TYPE", "hmac number key");
  throwsCode(() => crypto.createHmac("sha256"), "ERR_INVALID_ARG_TYPE", "hmac missing key");
  eq(throwsCode(() => crypto.createHmac(5, "k"), "ERR_INVALID_ARG_TYPE", "hmac non-string digest").message,
    'The "hmac" argument must be of type string. Received type number (5)',
    "hmac non-string digest message");
}

// ---------------------------------------------------------------------------------------------
// HKDF (RFC 5869 test case 1)
// ---------------------------------------------------------------------------------------------

const HKDF_IKM = Buffer.from("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b", "hex");
const HKDF_SALT = Buffer.from("000102030405060708090a0b0c", "hex");
const HKDF_INFO = Buffer.from("f0f1f2f3f4f5f6f7f8f9", "hex");
const HKDF_EXPECTED =
  "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865";

{
  const output = crypto.hkdf("sha256", HKDF_IKM, HKDF_SALT, HKDF_INFO, 42);
  record(Buffer.isBuffer(output), "hkdf() returns a Buffer");
  bytesEq(output, HKDF_EXPECTED, "hkdf-sha256 RFC 5869 #1");
}

// The SHA-2 truncations are valid HKDF PRFs (same extract-and-expand, different HashLen).
bytesEq(crypto.hkdf("sha224", HKDF_IKM, HKDF_SALT, HKDF_INFO, 42),
  "2f21cd7cbc818ca5c561b933728e2e08e154a87e1432399a820dee13aa222d0cee6152fa539ab70f8e80",
  "hkdf-sha224");
bytesEq(crypto.hkdf("sha512-224", HKDF_IKM, HKDF_SALT, HKDF_INFO, 42),
  "f8d956e152b0fba831bac400f1a5af54982b91db3d96ae21a75655eff1725f928e491c63f3aedb408296",
  "hkdf-sha512-224");
bytesEq(crypto.hkdf("sha512-256", HKDF_IKM, HKDF_SALT, HKDF_INFO, 42),
  "789a93e567a1861de449342b2d674c0df737fd8adce2a8e1843237c1938ac413044b496ce267a198ebe3",
  "hkdf-sha512-256");

{
  // hkdfSync is Node's synchronous form; unlike lite's `hkdf` extension it returns an ArrayBuffer.
  const out = crypto.hkdfSync("sha256", HKDF_IKM, HKDF_SALT, HKDF_INFO, 42);
  record(out instanceof ArrayBuffer, "hkdfSync returns an ArrayBuffer");
  bytesEq(new Uint8Array(out), HKDF_EXPECTED, "hkdfSync RFC 5869 #1");
  throwsCode(() => crypto.hkdfSync("sha256", HKDF_IKM, HKDF_SALT, HKDF_INFO, 8161),
    "ERR_CRYPTO_INVALID_KEYLEN", "hkdfSync key length above 255 * hashlen");
  throwsCode(() => crypto.hkdfSync("nope", HKDF_IKM, HKDF_SALT, HKDF_INFO, 16),
    "ERR_CRYPTO_INVALID_DIGEST", "hkdfSync unknown digest");
}

{
  // Node's hkdf accepts strings for ikm/salt/info, encoded as utf8.
  const output = crypto.hkdf("sha256", "ikm", "salt", "info", 16);
  eq(output.length, 16, "hkdf accepts string byte sources");
}

throwsCode(() => crypto.hkdf("sha256", HKDF_IKM, HKDF_SALT, HKDF_INFO, 8161),
  "ERR_CRYPTO_INVALID_KEYLEN", "hkdf key length above 255 * hashlen");
throwsCode(() => crypto.hkdf("sha256", HKDF_IKM, HKDF_SALT, HKDF_INFO, -1),
  "ERR_OUT_OF_RANGE", "hkdf negative key length");
throwsCode(() => crypto.hkdf("sha256", HKDF_IKM, HKDF_SALT, HKDF_INFO, 1.5),
  "ERR_OUT_OF_RANGE", "hkdf fractional key length");
throwsCode(() => crypto.hkdf("nope", HKDF_IKM, HKDF_SALT, HKDF_INFO, 16),
  "ERR_CRYPTO_INVALID_DIGEST", "hkdf unknown digest");
{
  const tooMuchInfo = Buffer.alloc(1025);
  throwsCode(() => crypto.hkdf("sha256", HKDF_IKM, HKDF_SALT, tooMuchInfo, 16),
    "ERR_OUT_OF_RANGE", "hkdf info longer than 1024 bytes");
  eq(crypto.hkdf("sha256", HKDF_IKM, HKDF_SALT, Buffer.alloc(1024), 16).length, 16,
    "hkdf info of exactly 1024 bytes");
}
throwsCode(() => crypto.hkdf("sha256", 5, HKDF_SALT, HKDF_INFO, 16), "ERR_INVALID_ARG_TYPE",
  "hkdf bad ikm");
throwsCode(() => crypto.hkdf("sha256", HKDF_IKM, null, HKDF_INFO, 16), "ERR_INVALID_ARG_TYPE",
  "hkdf null salt");

// ---------------------------------------------------------------------------------------------
// Random
// ---------------------------------------------------------------------------------------------

{
  const bytes = crypto.randomBytes(16);
  record(Buffer.isBuffer(bytes), "randomBytes returns a Buffer");
  eq(bytes.length, 16, "randomBytes length");
  eq(crypto.randomBytes(0).length, 0, "randomBytes(0) is empty");
  record(Buffer.compare(crypto.randomBytes(16), crypto.randomBytes(16)) !== 0,
    "two random draws differ");
}

throwsCode(() => crypto.randomBytes(-1), "ERR_OUT_OF_RANGE", "randomBytes(-1)");
throwsCode(() => crypto.randomBytes(2147483648), "ERR_OUT_OF_RANGE", "randomBytes too large");
throwsCode(() => crypto.randomBytes("4"), "ERR_INVALID_ARG_TYPE", "randomBytes(string)");
throwsCode(() => crypto.randomBytes(4, 5), "ERR_INVALID_ARG_TYPE", "randomBytes bad callback");

{
  let ok = true;
  for (let i = 0; i < 200; i += 1) {
    if (!inRange(crypto.randomInt(10), 0, 10)) ok = false;
    if (!inRange(crypto.randomInt(-5, 5), -5, 5)) ok = false;
  }
  record(ok, "randomInt stays inside its bounds");
  eq(crypto.randomInt(1, 2), 1, "randomInt(1, 2) is always 1");
}

throwsCode(() => crypto.randomInt(5, 5), "ERR_OUT_OF_RANGE", "randomInt empty range");
{
  const error = throwsCode(() => crypto.randomInt(0, 281474976710656), "ERR_OUT_OF_RANGE",
    "randomInt range above 2^48 - 1");
  record(error.message.indexOf('"max - min"') !== -1, "randomInt range error names max - min");
  record(error.name === "RangeError", "randomInt range error is a RangeError");
}
throwsCode(() => crypto.randomInt(1.5, 3), "ERR_INVALID_ARG_TYPE", "randomInt fractional min");
throwsCode(() => crypto.randomInt(0, 1.5), "ERR_INVALID_ARG_TYPE", "randomInt fractional max");
throwsCode(() => crypto.randomInt(2, 5, 7), "ERR_INVALID_ARG_TYPE", "randomInt bad callback");

{
  const seen = new Set();
  let shaped = true;
  for (let i = 0; i < 100; i += 1) {
    const uuid = crypto.randomUUID();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid)) {
      shaped = false;
    }
    seen.add(uuid);
  }
  record(shaped, "randomUUID is a lowercase v4 UUID");
  eq(seen.size, 100, "randomUUID values are unique");
}
throwsCode(() => crypto.randomUUID(5), "ERR_INVALID_ARG_TYPE", "randomUUID(number)");

// RFC 9562 version 7: timestamp prefix + random tail.
{
  const before = Date.now();
  const uuid = crypto.randomUUIDv7();
  const after = Date.now();
  record(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid),
    "randomUUIDv7 is a lowercase v7 UUID");
  const milliseconds = Number.parseInt(uuid.slice(0, 8) + uuid.slice(9, 13), 16);
  record(milliseconds >= before - 1 && milliseconds <= after + 1,
    "randomUUIDv7 encodes the current time in its 48-bit prefix");
  record(crypto.randomUUIDv7() !== uuid, "randomUUIDv7 values differ");
  record(/^[0-9a-f-]{36}$/.test(crypto.randomUUIDv7({ disableEntropyCache: true })),
    "randomUUIDv7 accepts disableEntropyCache");
  throwsCode(() => crypto.randomUUIDv7(5), "ERR_INVALID_ARG_TYPE", "randomUUIDv7(number)");
  throwsCode(() => crypto.randomUUIDv7({ disableEntropyCache: 5 }), "ERR_INVALID_ARG_TYPE",
    "randomUUIDv7 bad disableEntropyCache");
}

// ---------------------------------------------------------------------------------------------
// timingSafeEqual
// ---------------------------------------------------------------------------------------------

eq(crypto.timingSafeEqual(Buffer.from("abc"), Buffer.from("abc")), true, "timingSafeEqual equal");
eq(crypto.timingSafeEqual(Buffer.from("abc"), Buffer.from("abd")), false, "timingSafeEqual differs");
eq(crypto.timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true,
  "timingSafeEqual TypedArray");
{
  const lengthError = throwsCode(
    () => crypto.timingSafeEqual(Buffer.from("ab"), Buffer.from("abc")),
    "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH", "timingSafeEqual length mismatch");
  eq(lengthError.name, "RangeError", "timingSafeEqual length mismatch is a RangeError");
  eq(lengthError.message, "Input buffers must have the same byte length",
    "timingSafeEqual length message");
}
{
  const typeError = throwsCode(() => crypto.timingSafeEqual("ab", "ab"), "ERR_INVALID_ARG_TYPE",
    "timingSafeEqual string input");
  eq(typeError.message,
    'The "buf1" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.',
    "timingSafeEqual type message");
}

// ---------------------------------------------------------------------------------------------
// getHashes
// ---------------------------------------------------------------------------------------------

{
  const hashes = crypto.getHashes();
  record(Array.isArray(hashes), "getHashes returns an array");
  eq(hashes.join(","),
    "md5,sha1,sha224,sha256,sha384,sha512,sha512-224,sha512-256",
    "getHashes lists the supported digests");
  record(crypto.getHashes() !== hashes, "getHashes returns a fresh array");
}

// ---------------------------------------------------------------------------------------------
// One-shot hash (Node's crypto.hash)
// ---------------------------------------------------------------------------------------------

eq(crypto.hash("sha256", "abc"),
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "hash() defaults to hex");
eq(crypto.hash("sha224", "abc"),
  "23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7", "hash(sha224)");
eq(crypto.hash("sha512-256", Buffer.from("abc"), "base64"),
  "UwSOJoGUHvmbLim3a0x9q+TC0MY0/G1G4OLxMQfnryM=", "hash(Buffer, base64)");
record(Buffer.isBuffer(crypto.hash("sha256", "abc", "buffer")), "hash(..., buffer) returns a Buffer");
eq(crypto.hash("sha256", "abc", { outputEncoding: "base64" }),
  "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=", "hash(..., { outputEncoding })");
eq(crypto.hash("sha256", new Uint8Array([97, 98, 99])),
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "hash(TypedArray)");

{
  const unknown = throwsMessage(() => crypto.hash("nope", "abc"), "Digest method nope is not supported",
    "hash unknown digest message");
  record(unknown.code === undefined, "hash unknown digest has no code");
  eq(throwsCode(() => crypto.hash(5, "abc"), "ERR_INVALID_ARG_TYPE", "hash non-string digest").name,
    "TypeError", "hash non-string digest is a TypeError");
  throwsCode(() => crypto.hash("sha256", 5), "ERR_INVALID_ARG_TYPE", "hash bad input");
  throwsCode(() => crypto.hash("sha256"), "ERR_INVALID_ARG_TYPE", "hash missing input");
  throwsCode(() => crypto.hash("sha256", "abc", "nope"), "ERR_INVALID_ARG_VALUE",
    "hash bad output encoding");
  throwsCode(() => crypto.hash("sha256", "abc", 5), "ERR_INVALID_ARG_TYPE", "hash bad options");
}

// ---------------------------------------------------------------------------------------------
// randomFill / randomFillSync
// ---------------------------------------------------------------------------------------------

{
  const buffer = Buffer.alloc(4, 0xaa);
  record(crypto.randomFillSync(buffer) === buffer, "randomFillSync returns its argument");
  record(crypto.randomFillSync(new Uint8Array(3)) instanceof Uint8Array,
    "randomFillSync accepts a TypedArray");
  const arrayBuffer = new ArrayBuffer(4);
  record(crypto.randomFillSync(arrayBuffer) === arrayBuffer, "randomFillSync accepts an ArrayBuffer");
  const dataView = new DataView(new ArrayBuffer(4));
  record(crypto.randomFillSync(dataView) === dataView, "randomFillSync accepts a DataView");

  // Only the requested window is touched.
  const window = Buffer.alloc(8, 0x11);
  crypto.randomFillSync(window, 2, 3);
  eq(window[0], 0x11, "randomFillSync leaves bytes before the window alone");
  eq(window[1], 0x11, "randomFillSync leaves the byte before the window alone");
  eq(window[7], 0x11, "randomFillSync leaves bytes after the window alone");
  eq(crypto.randomFillSync(Buffer.alloc(0)).length, 0, "randomFillSync accepts an empty buffer");
}

{
  const offset = throwsCode(() => crypto.randomFillSync(Buffer.alloc(4), 5), "ERR_OUT_OF_RANGE",
    "randomFillSync offset out of range");
  eq(offset.name, "RangeError", "randomFillSync offset error is a RangeError");
  eq(offset.message,
    'The value of "offset" is out of range. It must be >= 0 && <= 4. Received 5',
    "randomFillSync offset message");
  throwsCode(() => crypto.randomFillSync(Buffer.alloc(4), 0, 5), "ERR_OUT_OF_RANGE",
    "randomFillSync size out of range");
  throwsCode(() => crypto.randomFillSync(Buffer.alloc(4), 0, -1), "ERR_OUT_OF_RANGE",
    "randomFillSync negative size");
  throwsCode(() => crypto.randomFillSync(), "ERR_INVALID_ARG_TYPE", "randomFillSync missing buffer");
  throwsCode(() => crypto.randomFillSync("abcd"), "ERR_INVALID_ARG_TYPE",
    "randomFillSync string buffer");
  throwsCode(() => crypto.randomFillSync(Buffer.alloc(4), "1"), "ERR_INVALID_ARG_TYPE",
    "randomFillSync string offset");
  throwsCode(() => crypto.randomFillSync(Buffer.alloc(4), 0, "1"), "ERR_INVALID_ARG_TYPE",
    "randomFillSync string size");
}

{
  throwsCode(() => crypto.randomFill(Buffer.alloc(4)), "ERR_INVALID_ARG_TYPE",
    "randomFill requires a callback");
  throwsCode(() => crypto.randomFill(Buffer.alloc(4), 5), "ERR_INVALID_ARG_TYPE",
    "randomFill rejects a non-function callback");
  throwsCode(() => crypto.randomFill("x", () => {}), "ERR_INVALID_ARG_TYPE",
    "randomFill string buffer");
  throwsCode(() => crypto.randomFill(Buffer.alloc(4), 9, () => {}), "ERR_OUT_OF_RANGE",
    "randomFill offset out of range");
}

// ---------------------------------------------------------------------------------------------
// getRandomValues (module-level WebCrypto helper)
// ---------------------------------------------------------------------------------------------

{
  const bytes = new Uint8Array(4);
  record(crypto.getRandomValues(bytes) === bytes, "getRandomValues returns its argument");
  const words = new Uint16Array(2);
  record(crypto.getRandomValues(words) === words, "getRandomValues accepts a Uint16Array");
  const bufferView = Buffer.alloc(4);
  record(crypto.getRandomValues(bufferView) === bufferView,
    "getRandomValues accepts a Buffer (Uint8Array subclass)");
  record(crypto.getRandomValues(new Uint8Array(65536)).length === 65536,
    "getRandomValues accepts exactly 65,536 bytes");

  const typeError = throwsCode(() => crypto.getRandomValues(new Float64Array(1)), 17,
    "getRandomValues float array");
  eq(typeError.name, "TypeMismatchError", "getRandomValues float array is a TypeMismatchError");
  eq(typeError.message, "The data argument must be an integer-type TypedArray",
    "getRandomValues float array message");
  throwsCode(() => crypto.getRandomValues(new DataView(new ArrayBuffer(4))), 17,
    "getRandomValues DataView");
  // Not a view at all: the WebIDL conversion rejects it before the algorithm runs.
  const nonView = throwsCode(() => crypto.getRandomValues(5), "ERR_INVALID_ARG_TYPE",
    "getRandomValues non-view");
  eq(nonView.name, "TypeError", "getRandomValues non-view is a TypeError");
  eq(nonView.message,
    "Failed to execute 'getRandomValues' on 'Crypto': 1st argument is not an ArrayBufferView.",
    "getRandomValues non-view message");

  const quota = throwsCode(() => crypto.getRandomValues(new Uint8Array(65537)), 22,
    "getRandomValues quota");
  eq(quota.name, "QuotaExceededError", "getRandomValues quota is a QuotaExceededError");
  eq(quota.message, "The requested length exceeds 65,536 bytes", "getRandomValues quota message");
}

// ---------------------------------------------------------------------------------------------
// Callback forms

// All three must be delivered asynchronously, in call order, with (err, result).
// ---------------------------------------------------------------------------------------------

const callbackOrder = [];
let randomBytesResult = null;
let randomIntResult = null;
let hkdfResult = null;
let randomFillResult = null;
const fillTarget = Buffer.alloc(4, 0x33);

crypto.randomBytes(4, (error, bytes) => {
  callbackOrder.push("randomBytes");
  randomBytesResult = { error, bytes };
});
crypto.randomInt(1, 5, (error, value) => {
  callbackOrder.push("randomInt");
  randomIntResult = { error, value };
});
crypto.hkdf("sha256", HKDF_IKM, HKDF_SALT, HKDF_INFO, 16, (error, output) => {
  callbackOrder.push("hkdf");
  hkdfResult = { error, output };
});
crypto.randomFill(fillTarget, 1, 2, (error, filled) => {
  callbackOrder.push("randomFill");
  randomFillResult = {
    error,
    same: filled === fillTarget,
    before: fillTarget[0],
    after: fillTarget[3],
  };
});
callbackOrder.push("sync");

record(randomBytesResult === null && randomIntResult === null && hkdfResult === null,
  "callback forms do not call back synchronously");
record(randomFillResult === null, "randomFill does not call back synchronously");

queueMicrotask(() => {
  eq(callbackOrder.join(","), "sync,randomBytes,randomInt,hkdf,randomFill",
    "callbacks run in registration order after the current turn");

  record(randomFillResult !== null && randomFillResult.error === null,
    "randomFill callback receives no error");
  record(randomFillResult.same, "randomFill callback receives its buffer");
  eq(randomFillResult.before, 0x33, "randomFill leaves bytes before the window alone");
  eq(randomFillResult.after, 0x33, "randomFill leaves bytes after the window alone");

  record(randomBytesResult !== null && randomBytesResult.error === null,
    "randomBytes callback receives no error");
  record(Buffer.isBuffer(randomBytesResult.bytes) && randomBytesResult.bytes.length === 4,
    "randomBytes callback receives a 4-byte Buffer");

  record(randomIntResult !== null && randomIntResult.error === null,
    "randomInt callback receives no error");
  record(inRange(randomIntResult.value, 1, 5), "randomInt callback value is in range");

  record(hkdfResult !== null && hkdfResult.error === null,
    "hkdf callback receives no error");
  record(hkdfResult.output instanceof ArrayBuffer,
    "hkdf callback receives an ArrayBuffer like Node");
  eq(hkdfResult.output.byteLength, 16, "hkdf callback byteLength");
  bytesEq(new Uint8Array(hkdfResult.output), "3cb25f25faacd57a90434f64d0362f2a",
    "hkdf callback output matches RFC 5869 case 1 (L = 16)");

  if (failures.length > 0) {
    for (let i = 0; i < failures.length; i += 1) console.log(`not ok - ${failures[i]}`);
  }
  console.log(`crypto.test.js: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
});
