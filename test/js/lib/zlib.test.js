"use strict";

// Runtime-agnostic self-check for js/lib/zlib.js. Runs under `node` and under
// lite: no `node:` imports, no test framework, only the module under test.
//
// Under plain Node the lite host (`__ln_host.zlib`) is absent, so the file
// prints one skip line and exits 0; the lite run does the asserting.

if (typeof globalThis.__ln_host !== "object") {
  console.log("skip: lite host unavailable");
  process.exit(0);
}

const zlib = require("../../../js/lib/zlib.js");

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

function bytesEq(actual, expected, message) {
  const hex = typeof actual === "string" ? actual : Buffer.from(actual).toString("hex");
  eq(hex, Buffer.from(expected).toString("hex"), message);
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

// ---------------------------------------------------------------------------------------------
// Round trips: all three wrappers, every representative level.
// ---------------------------------------------------------------------------------------------

const PAYLOAD = Buffer.from(
  "onde zlib: the quick brown fox jumps over the lazy dog ".repeat(8),
);

const FORMATS = [
  ["gzipSync", "gunzipSync", "gzip/gunzip"],
  ["deflateSync", "inflateSync", "deflate/inflate"],
  ["deflateRawSync", "inflateRawSync", "deflateRaw/inflateRaw"],
];

for (const level of [-1, 0, 1, 9]) {
  for (const [compress, decompress, label] of FORMATS) {
    const packed = zlib[compress](PAYLOAD, { level });
    record(Buffer.isBuffer(packed), `${label} level ${level} yields a Buffer`);
    bytesEq(zlib[decompress](packed), PAYLOAD, `${label} round trip at level ${level}`);
  }
}

// Empty input is a valid stream too.
for (const [compress, decompress, label] of FORMATS) {
  bytesEq(zlib[decompress](zlib[compress](Buffer.alloc(0))), Buffer.alloc(0),
    `${label} round trips an empty buffer`);
}

// Every accepted input flavour produces the same bytes.
const packedForViews = zlib.gzipSync(PAYLOAD);
bytesEq(zlib.gunzipSync(new Uint8Array(packedForViews)), PAYLOAD, "Uint8Array input");
bytesEq(zlib.gunzipSync(new DataView(packedForViews.buffer,
  packedForViews.byteOffset, packedForViews.byteLength)), PAYLOAD, "DataView input");
bytesEq(zlib.gunzipSync(packedForViews.buffer.slice(
  packedForViews.byteOffset, packedForViews.byteOffset + packedForViews.byteLength)),
PAYLOAD, "ArrayBuffer input");

// ---------------------------------------------------------------------------------------------
// Concatenated gzip members: Node's gunzip reads the whole sequence.
// ---------------------------------------------------------------------------------------------

const memberA = zlib.gzipSync(Buffer.from("first member; "));
const memberB = zlib.gzipSync(Buffer.from("second member"));
bytesEq(zlib.gunzipSync(Buffer.concat([memberA, memberB])),
  Buffer.from("first member; second member"),
  "concatenated gzip members decompress to both payloads");

// ---------------------------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------------------------

const corrupt = throwsCode(() => zlib.gunzipSync(Buffer.from("not gzip at all")),
  "Z_DATA_ERROR", "corrupt gzip input is Z_DATA_ERROR");
record(corrupt instanceof Error, "corrupt input raises an Error instance");

throwsCode(() => zlib.gunzipSync(zlib.gzipSync(PAYLOAD), { maxOutputLength: 8 }),
  "ERR_BUFFER_TOO_LARGE", "a too-small maxOutputLength is ERR_BUFFER_TOO_LARGE");

const exactLimit = zlib.gunzipSync(zlib.gzipSync(PAYLOAD), {
  maxOutputLength: PAYLOAD.length,
});
bytesEq(exactLimit, PAYLOAD, "a maxOutputLength equal to the payload is accepted");

const levelError = throwsCode(() => zlib.gzipSync(PAYLOAD, { level: 42 }),
  "ERR_OUT_OF_RANGE", "level 42 is ERR_OUT_OF_RANGE");
eq(levelError.message,
  'The value of "options.level" is out of range. It must be >= -1 and <= 9. Received 42',
  "level 42 message matches Node");

throwsCode(() => zlib.gzipSync(PAYLOAD, { level: -2 }),
  "ERR_OUT_OF_RANGE", "level -2 is ERR_OUT_OF_RANGE");
throwsCode(() => zlib.gzipSync(PAYLOAD, { level: "1" }),
  "ERR_INVALID_ARG_TYPE", "a non-number level is ERR_INVALID_ARG_TYPE");
throwsCode(() => zlib.gzipSync(PAYLOAD, { maxOutputLength: 0 }),
  "ERR_OUT_OF_RANGE", "maxOutputLength 0 is ERR_OUT_OF_RANGE");

const stringError = throwsCode(() => zlib.gzipSync("hello"),
  "ERR_INVALID_ARG_TYPE", "a string input is ERR_INVALID_ARG_TYPE");
eq(stringError.name, "TypeError", "string input error is a TypeError");

throwsCode(() => zlib.inflateSync(null), "ERR_INVALID_ARG_TYPE", "null input");
record(Buffer.isBuffer(zlib.deflateSync(Buffer.alloc(1), 5)),
  "a non-object options argument is ignored, as in Node");

// ---------------------------------------------------------------------------------------------
// crc32
// ---------------------------------------------------------------------------------------------

eq(zlib.crc32("123456789"), 0xCBF43926, "crc32(123456789) is the IEEE vector");
eq(zlib.crc32(""), 0, "crc32(empty string) is 0");
eq(zlib.crc32(Buffer.from("123456789")), 0xCBF43926, "crc32 accepts a Buffer");
eq(zlib.crc32(new Uint8Array([49, 50, 51, 52, 53, 54, 55, 56, 57])), 0xCBF43926,
  "crc32 accepts a Uint8Array");
throwsCode(() => zlib.crc32(5), "ERR_INVALID_ARG_TYPE", "crc32 rejects a number");

// ---------------------------------------------------------------------------------------------
// constants: the subset onde exposes, with Node's numeric values.
// ---------------------------------------------------------------------------------------------

eq(zlib.constants.Z_NO_COMPRESSION, 0, "Z_NO_COMPRESSION");
eq(zlib.constants.Z_BEST_SPEED, 1, "Z_BEST_SPEED");
eq(zlib.constants.Z_BEST_COMPRESSION, 9, "Z_BEST_COMPRESSION");
eq(zlib.constants.Z_DEFAULT_COMPRESSION, -1, "Z_DEFAULT_COMPRESSION");
eq(zlib.constants.Z_SYNC_FLUSH, 2, "Z_SYNC_FLUSH");
eq(zlib.constants.Z_FULL_FLUSH, 3, "Z_FULL_FLUSH");
eq(zlib.constants.Z_FINISH, 4, "Z_FINISH");
eq(zlib.constants.Z_OK, 0, "Z_OK");
eq(zlib.constants.Z_STREAM_END, 1, "Z_STREAM_END");
eq(zlib.constants.Z_STREAM_ERROR, -2, "Z_STREAM_ERROR");
eq(zlib.constants.Z_DATA_ERROR, -3, "Z_DATA_ERROR");
eq(zlib.constants.Z_MEM_ERROR, -4, "Z_MEM_ERROR");
eq(zlib.constants.Z_BUF_ERROR, -5, "Z_BUF_ERROR");

// ---------------------------------------------------------------------------------------------
// Deferred stream surface: absent on purpose (see the header of js/lib/zlib.js).
// ---------------------------------------------------------------------------------------------

eq(typeof zlib.createGunzip, "undefined", "createGunzip is deferred");
eq(typeof zlib.createGzip, "undefined", "createGzip is deferred");
eq(typeof zlib.brotliCompressSync, "undefined", "brotli is deferred");
eq(typeof zlib.zstdCompressSync, "undefined", "zstd is deferred");

// ---------------------------------------------------------------------------------------------
// Callback forms: asynchronous delivery, (err, result), same bytes as the sync form.
// ---------------------------------------------------------------------------------------------

const callbackOrder = [];
let gzipResult = null;
let corruptResult = null;

record(zlib.gzip(PAYLOAD, { level: 6 }, (error, result) => {
  callbackOrder.push("gzip");
  gzipResult = { error, result };
}) === undefined, "gzip callback form returns undefined");

zlib.gunzip(Buffer.from("not gzip at all"), (error, result) => {
  callbackOrder.push("gunzip");
  corruptResult = { error, result };
});

callbackOrder.push("sync");
record(gzipResult === null && corruptResult === null,
  "callback forms do not call back synchronously");

// The callbacks above were queued before this one, so they have run by the time it fires.
process.nextTick(() => {
  eq(callbackOrder.join(","), "sync,gzip,gunzip", "callbacks run after the current turn");

  record(gzipResult !== null && gzipResult.error === null,
    "gzip callback receives no error");
  record(Buffer.isBuffer(gzipResult.result), "gzip callback result is a Buffer");
  bytesEq(gzipResult.result, zlib.gzipSync(PAYLOAD, { level: 6 }),
    "gzip callback result matches the sync form");

  record(corruptResult !== null && corruptResult.error !== null,
    "gunzip callback receives an error for corrupt input");
  eq(corruptResult.error && corruptResult.error.code, "Z_DATA_ERROR",
    "gunzip callback error code is Z_DATA_ERROR");

  throwsCode(() => zlib.gzip(PAYLOAD), "ERR_INVALID_ARG_TYPE",
    "a missing callback is ERR_INVALID_ARG_TYPE");
  throwsCode(() => zlib.gzip(PAYLOAD, {}, "nope"), "ERR_INVALID_ARG_TYPE",
    "a non-function callback is ERR_INVALID_ARG_TYPE");

  if (failures.length > 0) {
    for (let i = 0; i < failures.length; i += 1) console.log(`not ok - ${failures[i]}`);
  }
  console.log(`zlib.test.js: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
});
