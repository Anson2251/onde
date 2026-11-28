"use strict";

// `zlib` — whole-buffer gzip / zlib / raw-deflate and crc32.
//
// The host exposes one synchronous primitive, `__ln_host.zlib`
// (`crates/ln-runtime/src/host/zlib.rs`), which maps an operation name onto
// `ln_zlib`; this file is the Node-shaped surface over it. It never requires
// `node:zlib` and only reads `__ln_host` at call time, so loading it under plain
// Node (the differential oracle) does not crash.
//
// Implemented: `gunzipSync`, `inflateSync`, `inflateRawSync`, `gzipSync`,
// `deflateSync`, `deflateRawSync`, `crc32`, the matching callback forms
// (`gunzip`, `gzip`, ...) and `constants`.
//
// Fidelity notes (tracked in `docs/compat.md`):
//   - The callback forms do their work synchronously on this thread and deliver
//     `(err, result)` through `process.nextTick`, where Node queues the job on
//     the libuv thread pool. The callback contract (asynchronous delivery, no
//     half-built result) is unchanged; only when the CPU time is spent differs.
//     This is a recorded divergence, not a bug.
//   - Inputs must be a `Buffer`, `TypedArray`, `DataView` or `ArrayBuffer`.
//     Unlike Node v26, a string is rejected with `ERR_INVALID_ARG_TYPE` (Node
//     implicitly UTF-8-encodes it for the compression entry points). `crc32`
//     does accept a string, matching Node.
//   - Options: `level` (`-1`..`9`) and `maxOutputLength` (`>= 1`) are honoured.
//     `chunkSize`, `flush`, `finishFlush`, `windowBits` and `dictionary` are
//     accepted and ignored: there is no streaming state to tune yet. In
//     particular `dictionary` cannot be honoured because the host primitive is
//     stateless, so a caller that relies on a preset dictionary sees a decode
//     error (usually `Z_DATA_ERROR`) or the wrong bytes rather than the
//     original payload.
//   - `maxOutputLength` is enforced after compression as well as during
//     decompression, so an oversized output still raises
//     `ERR_BUFFER_TOO_LARGE` like Node.
//   - Deferred until the streaming milestone: `createGzip`/`createGunzip` and
//     the other `zlib` streams (`Zlib`, `Gzip`, `Deflate`, `Inflate`, ...),
//     `brotli*` and `zstd*` are absent. `typeof createGunzip === "undefined"`.
//   - `crc32(data)` ignores a second argument; Node's optional running-seed
//     form (`crc32(data, value)`) is not implemented.

let bufferModule;
try {
    bufferModule = require("buffer");
} catch (_) {
    // Loaded by path (for example by the differential oracle) instead of through
    // the builtin table.
    bufferModule = require("./buffer.js");
}
const Buffer = bufferModule.Buffer || bufferModule;

const Z_NO_COMPRESSION = 0;
const Z_BEST_SPEED = 1;
const Z_BEST_COMPRESSION = 9;
const Z_DEFAULT_COMPRESSION = -1;
const Z_SYNC_FLUSH = 2;
const Z_FULL_FLUSH = 3;
const Z_FINISH = 4;
const Z_OK = 0;
const Z_STREAM_END = 1;
const Z_STREAM_ERROR = -2;
const Z_DATA_ERROR = -3;
const Z_MEM_ERROR = -4;
const Z_BUF_ERROR = -5;

// `level`'s accepted range; everything outside it is Node's ERR_OUT_OF_RANGE.
const MIN_LEVEL = -1;
const MAX_LEVEL = 9;
const MAX_SAFE_INTEGER = 9007199254740991;

const constants = Object.freeze({
    Z_NO_COMPRESSION,
    Z_BEST_SPEED,
    Z_BEST_COMPRESSION,
    Z_DEFAULT_COMPRESSION,
    Z_SYNC_FLUSH,
    Z_FULL_FLUSH,
    Z_FINISH,
    Z_OK,
    Z_STREAM_END,
    Z_STREAM_ERROR,
    Z_DATA_ERROR,
    Z_MEM_ERROR,
    Z_BUF_ERROR,
});

// ---------------------------------------------------------------------------------------------
// Errors
//
// The shared vocabulary lives in `internal/errors.js`; only zlib-specific errors belong here.
// ---------------------------------------------------------------------------------------------

const {
    coded: makeError,
    invalidArgType,
    invalidPropertyType,
    outOfRange,
} = require("./internal/errors.js");

function tooLarge(limit) {
    return makeError(
        Error,
        "ERR_BUFFER_TOO_LARGE",
        `Cannot create a Buffer larger than ${limit} bytes`,
    );
}

// ---------------------------------------------------------------------------------------------
// Host and byte helpers
// ---------------------------------------------------------------------------------------------

// Coercion is shared. `byteView` returns `null` for a non-byte value, but `inputBytes` checks the
// type first, so the non-null path is the only one reached.
const { byteView, isAnyArrayBuffer, isArrayBufferView } = require("./internal/bytes.js");

function hostZlib() {
    const host = globalThis.__ln_host;
    const zlib = host === undefined || host === null ? undefined : host.zlib;
    if (zlib === undefined || zlib === null) {
        // Not a Node error: this only happens when the module runs outside onde without the
        // differential oracle's host shim.
        throw new Error("zlib is unavailable: __ln_host.zlib is not installed");
    }
    return zlib;
}

/**
 * Validate a `buffer` argument and return the view to compress.
 *
 * Strings are deliberately not accepted here: the host primitive takes bytes, and Node's
 * implicit string encoding for the compression entry points is out of scope.
 */
function inputBytes(value, name) {
    if (isArrayBufferView(value) || isAnyArrayBuffer(value)) return byteView(value);
    throw invalidArgType(
        name,
        "an instance of Buffer, TypedArray, DataView, or ArrayBuffer",
        value,
    );
}

/** Wrap the host's fresh `Uint8Array` in a Buffer without copying its bytes. */
function toBuffer(bytes) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

// `maxOutputLength: 0` is the host's "no explicit limit" sentinel; the caller-visible default
// is therefore the absence of the property, not the literal 0. Node rejects a literal 0.
function normalizeOptions(options) {
    let level = Z_DEFAULT_COMPRESSION;
    let maxOutputLength = 0;

    // Node accepts a missing, null, or non-object `options` and treats it as "defaults"; arrays
    // behave the same way (no `level` property).
    if (options === undefined || options === null || typeof options !== "object") {
        return { level, maxOutputLength };
    }

    if (options.level !== undefined) {
        if (typeof options.level !== "number") {
            throw invalidPropertyType("options.level", "number", options.level);
        }
        level = options.level;
        if (!(level >= MIN_LEVEL && level <= MAX_LEVEL)) {
            throw outOfRange("options.level", `>= ${MIN_LEVEL} and <= ${MAX_LEVEL}`, level);
        }
    }

    if (options.maxOutputLength !== undefined) {
        if (typeof options.maxOutputLength !== "number") {
            throw invalidPropertyType("options.maxOutputLength", "number", options.maxOutputLength);
        }
        if (!(options.maxOutputLength >= 1 && options.maxOutputLength <= MAX_SAFE_INTEGER)) {
            throw outOfRange(
                "options.maxOutputLength",
                `>= 1 and <= ${MAX_SAFE_INTEGER}`,
                options.maxOutputLength,
            );
        }
        maxOutputLength = options.maxOutputLength;
    }

    return { level, maxOutputLength };
}

// ---------------------------------------------------------------------------------------------
// Synchronous entry points
// ---------------------------------------------------------------------------------------------

function runSync(mode, buffer, options) {
    const bytes = inputBytes(buffer, "buffer");
    const { level, maxOutputLength } = normalizeOptions(options);
    const result = toBuffer(hostZlib().run(mode, bytes, level, maxOutputLength));
    // The host ignores `maxOutput` for compression (there is no streaming bound to enforce on the
    // encode side), so the limit is applied to the finished buffer here.
    if (maxOutputLength !== 0 && result.byteLength > maxOutputLength) {
        throw tooLarge(maxOutputLength);
    }
    return result;
}

function gzipSync(buffer, options) {
    return runSync("gzip", buffer, options);
}

function gunzipSync(buffer, options) {
    return runSync("gunzip", buffer, options);
}

function deflateSync(buffer, options) {
    return runSync("deflate", buffer, options);
}

function inflateSync(buffer, options) {
    return runSync("inflate", buffer, options);
}

function deflateRawSync(buffer, options) {
    return runSync("deflateRaw", buffer, options);
}

function inflateRawSync(buffer, options) {
    return runSync("inflateRaw", buffer, options);
}

/**
 * `crc32(data)`: IEEE 802.3 CRC-32 as an unsigned 32-bit Number, like Node.
 *
 * Unlike the compression entry points, Node's crc32 accepts a string; it is encoded as UTF-8.
 */
function crc32(data) {
    if (typeof data === "string") return hostZlib().crc32(Buffer.from(data, "utf8"));
    return hostZlib().crc32(inputBytes(data, "data"));
}

// ---------------------------------------------------------------------------------------------
// Callback entry points
//
// Validation throws synchronously (as in Node); the work itself is synchronous today and the
// result is delivered on the next tick. See the fidelity note at the top of this file.
// ---------------------------------------------------------------------------------------------

function runAsync(mode, buffer, options, callback) {
    if (typeof options === "function") {
        callback = options;
        options = undefined;
    }
    const bytes = inputBytes(buffer, "buffer");
    const { level, maxOutputLength } = normalizeOptions(options);
    if (typeof callback !== "function") {
        throw invalidArgType("callback", "of type function", callback);
    }

    let result;
    let error = null;
    try {
        result = toBuffer(hostZlib().run(mode, bytes, level, maxOutputLength));
        if (maxOutputLength !== 0 && result.byteLength > maxOutputLength) {
            throw tooLarge(maxOutputLength);
        }
    } catch (caught) {
        error = caught;
    }
    process.nextTick(() => callback(error, result));
    return undefined;
}

function gzip(buffer, options, callback) {
    return runAsync("gzip", buffer, options, callback);
}

function gunzip(buffer, options, callback) {
    return runAsync("gunzip", buffer, options, callback);
}

function deflate(buffer, options, callback) {
    return runAsync("deflate", buffer, options, callback);
}

function inflate(buffer, options, callback) {
    return runAsync("inflate", buffer, options, callback);
}

function deflateRaw(buffer, options, callback) {
    return runAsync("deflateRaw", buffer, options, callback);
}

function inflateRaw(buffer, options, callback) {
    return runAsync("inflateRaw", buffer, options, callback);
}

module.exports = {
    crc32,
    constants,
    deflate,
    deflateRaw,
    deflateRawSync,
    deflateSync,
    gzip,
    gzipSync,
    gunzip,
    gunzipSync,
    inflate,
    inflateRaw,
    inflateRawSync,
    inflateSync,
};
