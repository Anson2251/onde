"use strict";

// The Buffer-vocabulary byte codecs: encoding labels, utf16le/latin1/ascii, hex and base64.
//
// UTF-8 is deliberately not here. `textcodec.js` owns the WHATWG decoder and the host fast path,
// and moving it would put the streaming state machine next to the one-shot decoder for no gain.
// This module is the other seam: everything `Buffer` calls for a non-UTF-8 encoding, plus the
// small coercion helpers (`byteView`, `concatBytes`) that the stdlib shares.
//
// The decoders follow Node's native behaviour, including its asymmetries: `ascii` truncates to
// eight bits when encoding but masks 0x7F when decoding, hex drops an odd trailing digit and
// masks each UTF-16 code unit to a byte, and base64 accepts both alphabets, ignores anything
// outside them, stops at the first `=` and drops a lone trailing character.
//
// Nothing here throws for a bad coercion: `byteView` returns `null` and callers keep their own
// `ERR_INVALID_ARG_TYPE` wording. This file is a leaf, so it can be required from anywhere.
//
// B1 moves `base64Encode`/`base64Decode`/`hexEncode`/`hexDecode` into the host (`host/codec.rs`).
// The loops below are the reference implementation and stay: under the node oracle the shim has no
// `buffer` member, so the JavaScript path is what the oracle checks against Node, and the corpus
// checks the native path against the same literals.

// ---------------------------------------------------------------------------------------------
// Host seam
// ---------------------------------------------------------------------------------------------

// Captured once, like `buffer.js` and `textcodec.js`: `__ln_host` is installed before the stdlib
// loads and never changes afterwards. Absent under plain `node`, which is not an error here.
const hostBuffer = (() => {
    const host = globalThis.__ln_host;
    return host === undefined || host === null ? undefined : host.buffer;
})();

function hostMember(name) {
    return hostBuffer === undefined || typeof hostBuffer[name] !== "function"
        ? null
        : hostBuffer[name];
}

const nativeHexEncode = hostMember("encodeHex");
const nativeHexDecode = hostMember("decodeHex");
const nativeBase64Encode = hostMember("encodeBase64");
const nativeBase64Decode = hostMember("decodeBase64");

// A lone surrogate cannot cross the host boundary: the engine hands the string to Rust as CESU-8,
// which is not UTF-8, so the host would report a conversion error where Node simply masks the code
// unit to a byte. Only well-formed strings take the native path; the loop below is the oracle for
// the rest. `isWellFormed` is ES2024 and the engine provides it.
function hostString(string) {
    return (
        typeof string === "string" &&
        typeof string.isWellFormed === "function" &&
        string.isWellFormed()
    );
}

// ---------------------------------------------------------------------------------------------
// Encoding labels
// ---------------------------------------------------------------------------------------------

const ENCODING_ALIASES = Object.assign(Object.create(null), {
    utf8: "utf8",
    "utf-8": "utf8",
    utf16le: "utf16le",
    "utf-16le": "utf16le",
    ucs2: "utf16le",
    "ucs-2": "utf16le",
    latin1: "latin1",
    binary: "latin1",
    base64: "base64",
    base64url: "base64url",
    ascii: "ascii",
    hex: "hex",
});

// Buffer's label policy without its throwing: the empty label is the default, a non-string is
// "not a label this table knows", and an unknown label is `null` so the caller can choose the
// error. Case-insensitive, like every caller that reaches this table.
function canonicalEncoding(label) {
    if (label === undefined || label === null || label === "") return "utf8";
    if (typeof label !== "string") return null;
    const normalized = ENCODING_ALIASES[label.toLowerCase()];
    return normalized === undefined ? null : normalized;
}

// ---------------------------------------------------------------------------------------------
// Single-byte and UTF-16 codecs
// ---------------------------------------------------------------------------------------------

// One string builder per decode: appending one code unit at a time is quadratic for large
// buffers, so flush through `fromCharCode` in chunks.
const DECODE_CHUNK = 4096;

function decodeUtf16le(bytes, start, end) {
    let out = "";
    const units = [];
    for (let i = start; i + 1 < end; i += 2) {
        units.push(bytes[i] | (bytes[i + 1] << 8));
        if (units.length === DECODE_CHUNK) {
            out += String.fromCharCode.apply(null, units);
            units.length = 0;
        }
    }
    if (units.length > 0) out += String.fromCharCode.apply(null, units);
    return out;
}

// `mask` is 0xff for latin1 and 0x7f for ascii; the asymmetry lives in the encoder below.
function decodeSingleByte(bytes, start, end, mask) {
    let out = "";
    const units = [];
    for (let i = start; i < end; i++) {
        units.push(bytes[i] & mask);
        if (units.length === DECODE_CHUNK) {
            out += String.fromCharCode.apply(null, units);
            units.length = 0;
        }
    }
    if (units.length > 0) out += String.fromCharCode.apply(null, units);
    return out;
}

function decodeLatin1(bytes, start, end) {
    return decodeSingleByte(bytes, start, end, 0xff);
}

function decodeAscii(bytes, start, end) {
    return decodeSingleByte(bytes, start, end, 0x7f);
}

// Every UTF-16 code unit becomes two little-endian bytes, including both halves of a surrogate
// pair. A trailing odd byte on decode is simply not read.
function encodeUtf16le(string) {
    const out = new Uint8Array(string.length * 2);
    for (let i = 0; i < string.length; i++) {
        const code = string.charCodeAt(i);
        out[i * 2] = code & 0xff;
        out[i * 2 + 1] = code >> 8;
    }
    return out;
}

// Node truncates to the low eight bits when *encoding* latin1/ascii; only decoding ascii masks
// with 0x7f, so "é" encodes as 0xE9 and then decodes as 0x69.
function encodeLatin1(string) {
    const out = new Uint8Array(string.length);
    for (let i = 0; i < string.length; i++) out[i] = string.charCodeAt(i) & 0xff;
    return out;
}

function encodeAscii(string) {
    return encodeLatin1(string);
}

// ---------------------------------------------------------------------------------------------
// Hex
// ---------------------------------------------------------------------------------------------

const HEX_DIGITS = "0123456789abcdef";

const HEX_VALUES = new Int8Array(256).fill(-1);
for (let i = 0; i < 10; i++) HEX_VALUES[0x30 + i] = i;
for (let i = 0; i < 6; i++) {
    HEX_VALUES[0x41 + i] = 10 + i;
    HEX_VALUES[0x61 + i] = 10 + i;
}

function hexEncode(bytes, start, end) {
    if (nativeHexEncode !== null) return nativeHexEncode(bytes, start, end);
    let out = "";
    for (let i = start; i < end; i++) {
        const byte = bytes[i];
        out += HEX_DIGITS[byte >> 4] + HEX_DIGITS[byte & 0x0f];
    }
    return out;
}

function hexDecode(string) {
    if (nativeHexDecode !== null && hostString(string)) return nativeHexDecode(string);
    const out = new Uint8Array((string.length + 1) >> 1);
    let written = 0;
    for (let i = 0; i + 1 < string.length; i += 2) {
        // Node's decoder masks each UTF-16 code unit to one byte before the table lookup, so "š"
        // (U+0161) looks like "a"; any other non-hex pair ends decoding.
        const hi = HEX_VALUES[string.charCodeAt(i) & 0xff];
        const lo = HEX_VALUES[string.charCodeAt(i + 1) & 0xff];
        if (hi < 0 || lo < 0) break;
        out[written++] = (hi << 4) | lo;
    }
    // An odd trailing digit is dropped. `written` can only be short after an invalid pair.
    return written === out.length ? out : out.subarray(0, written);
}

// ---------------------------------------------------------------------------------------------
// Base64
// ---------------------------------------------------------------------------------------------

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const BASE64_LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) BASE64_LOOKUP[BASE64_ALPHABET.charCodeAt(i)] = i;
// base64url shares the first 62 entries and remaps the last two, so one table decodes both.
BASE64_LOOKUP[0x2d] = 62; // '-'
BASE64_LOOKUP[0x5f] = 63; // '_'

function base64Encode(bytes, start, end, urlSafe) {
    if (nativeBase64Encode !== null) return nativeBase64Encode(bytes, start, end, urlSafe);
    const alphabet = urlSafe ? BASE64URL_ALPHABET : BASE64_ALPHABET;
    let out = "";
    let i = start;
    for (; i + 2 < end; i += 3) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        out +=
            alphabet[n >> 18] +
            alphabet[(n >> 12) & 0x3f] +
            alphabet[(n >> 6) & 0x3f] +
            alphabet[n & 0x3f];
    }
    const remaining = end - i;
    if (remaining === 1) {
        const n = bytes[i] << 16;
        out += alphabet[n >> 18] + alphabet[(n >> 12) & 0x3f];
        if (!urlSafe) out += "==";
    } else if (remaining === 2) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
        out += alphabet[n >> 18] + alphabet[(n >> 12) & 0x3f] + alphabet[(n >> 6) & 0x3f];
        if (!urlSafe) out += "=";
    }
    return out;
}

// Both alphabets decode either way, as Node does; `urlSafe` is accepted for symmetry with the
// encoder but does not change the table. Whitespace and non-alphabet characters are ignored, `=`
// ends the input, and a single trailing character contributes no byte because it cannot fill
// eight bits.
function base64Decode(string, urlSafe) {
    if (nativeBase64Decode !== null && hostString(string))
        return nativeBase64Decode(string, urlSafe);
    const out = new Uint8Array(Math.floor((string.length * 3) / 4));
    let written = 0;
    let accumulator = 0;
    let bits = 0;
    for (let i = 0; i < string.length; i++) {
        // Node masks code units to one byte before its base64 lookup; a surrogate such as U+D83D
        // becomes '=' (0x3D) and therefore terminates decoding.
        const code = string.charCodeAt(i) & 0xff;
        if (code === 0x3d) break; // '='
        const value = code < 128 ? BASE64_LOOKUP[code] : -1;
        if (value < 0) continue;
        accumulator = ((accumulator << 6) | value) & 0xffffff;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[written++] = (accumulator >> bits) & 0xff;
        }
    }
    return written === out.length ? out : out.subarray(0, written);
}

// ---------------------------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------------------------

function isAnyArrayBuffer(value) {
    if (value instanceof ArrayBuffer) return true;
    return typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer;
}

function isArrayBufferView(value) {
    return ArrayBuffer.isView(value);
}

// Raw bytes for any view or buffer, or `null` for "not bytes". The caller owns the message.
function byteView(value) {
    if (value instanceof Uint8Array) return value;
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (isAnyArrayBuffer(value)) return new Uint8Array(value);
    return null;
}

// Two byte sequences, preserving the identity of an empty side (callers rely on that to avoid
// copying a chunk they already own). `internal/fs` also passes `(chunks, total)` for its
// multi-chunk reads/writes; that form exists so the chunk list is not re-walked in two places.
function concatBytes(first, second) {
    if (Array.isArray(first) && typeof second === "number") {
        const out = new Uint8Array(second);
        let offset = 0;
        for (let i = 0; i < first.length; i++) {
            const chunk = first[i];
            out.set(chunk, offset);
            offset += chunk.length;
        }
        return out;
    }
    if (first.length === 0) return second;
    if (second.length === 0) return first;
    const out = new Uint8Array(first.length + second.length);
    out.set(first, 0);
    out.set(second, first.length);
    return out;
}

module.exports = {
    canonicalEncoding,
    decodeUtf16le,
    encodeUtf16le,
    decodeLatin1,
    encodeLatin1,
    decodeAscii,
    encodeAscii,
    hexEncode,
    hexDecode,
    base64Encode,
    base64Decode,
    concatBytes,
    byteView,
    isAnyArrayBuffer,
    isArrayBufferView,
};
