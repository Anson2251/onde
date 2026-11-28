"use strict";

// WHATWG `TextEncoder` / `TextDecoder` for onde.
//
// The engine has no encoding APIs, so this module owns the semantics. UTF-8 decoding follows
// the WHATWG decoder exactly: the "maximal subpart" rule means an incomplete or invalid
// sequence is replaced by one U+FFFD per maximal prefix that could still have been valid, and
// streaming keeps only a genuinely pending suffix. `TextDecoder` normalises labels the way
// Node (and the Encoding Standard) does: `latin1`, `iso-8859-1` and even `ascii` all name
// windows-1252, whose 0x80-0x9F block is mapped to Unicode code points.
//
// No host services are needed; this module is pure JavaScript.

const EMPTY = new Uint8Array(0);

// The host does the whole-buffer conversion in Rust. It is absent under the node oracle (the shim
// has no `text`), where the JavaScript paths below stay in use, so both implementations are
// exercised: the oracle checks the JavaScript one against Node, and the corpus checks this one.
const hostText = (() => {
    const host = globalThis.__ln_host;
    return host === undefined || host === null ? undefined : host.text;
})();

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

const { coded: makeError, invalidArgType } = require("./internal/errors.js");

function encodingInvalid(encoding) {
    return makeError(
        TypeError,
        "ERR_ENCODING_INVALID_ENCODED_DATA",
        `The encoded data was not valid for encoding ${encoding}`,
    );
}

function encodingNotSupported(label) {
    return makeError(
        RangeError,
        "ERR_ENCODING_NOT_SUPPORTED",
        `The "${label}" encoding is not supported`,
    );
}

// ---------------------------------------------------------------------------------------------
// UTF-8 encoding
// ---------------------------------------------------------------------------------------------

// Encode a JS string (UTF-16) as UTF-8. Lone surrogates become U+FFFD, as the Encoding
// Standard requires for both `TextEncoder.encode` and `Buffer.from(string, "utf8")`.
function encodeUTF8(input) {
    const str = `${input}`;
    if (hostText !== undefined && hostText !== null) {
        // An unpaired surrogate cannot cross the boundary as UTF-8: the engine encodes it as WTF-8,
        // which is not valid UTF-8 and which the host rejects. `isWellFormed` is a native scan, and
        // `toWellFormed` performs exactly the U+FFFD replacement the loop below does, so the host only
        // ever sees valid text.
        return hostText.encode(str.isWellFormed() ? str : str.toWellFormed());
    }
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
        let codePoint = str.charCodeAt(i);
        if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
            const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
            if (next >= 0xdc00 && next <= 0xdfff) {
                codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00);
                i++;
            } else {
                codePoint = 0xfffd;
            }
        } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
            codePoint = 0xfffd;
        }

        if (codePoint < 0x80) {
            bytes.push(codePoint);
        } else if (codePoint < 0x800) {
            bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
        } else if (codePoint < 0x10000) {
            bytes.push(
                0xe0 | (codePoint >> 12),
                0x80 | ((codePoint >> 6) & 0x3f),
                0x80 | (codePoint & 0x3f),
            );
        } else {
            bytes.push(
                0xf0 | (codePoint >> 18),
                0x80 | ((codePoint >> 12) & 0x3f),
                0x80 | ((codePoint >> 6) & 0x3f),
                0x80 | (codePoint & 0x3f),
            );
        }
    }
    return Uint8Array.from(bytes);
}

function utf8Length(codePoint) {
    if (codePoint < 0x80) return 1;
    if (codePoint < 0x800) return 2;
    if (codePoint < 0x10000) return 3;
    return 4;
}

function writeCodePoint(dest, offset, codePoint) {
    if (codePoint < 0x80) {
        dest[offset] = codePoint;
        return 1;
    }
    if (codePoint < 0x800) {
        dest[offset] = 0xc0 | (codePoint >> 6);
        dest[offset + 1] = 0x80 | (codePoint & 0x3f);
        return 2;
    }
    if (codePoint < 0x10000) {
        dest[offset] = 0xe0 | (codePoint >> 12);
        dest[offset + 1] = 0x80 | ((codePoint >> 6) & 0x3f);
        dest[offset + 2] = 0x80 | (codePoint & 0x3f);
        return 3;
    }
    dest[offset] = 0xf0 | (codePoint >> 18);
    dest[offset + 1] = 0x80 | ((codePoint >> 12) & 0x3f);
    dest[offset + 2] = 0x80 | ((codePoint >> 6) & 0x3f);
    dest[offset + 3] = 0x80 | (codePoint & 0x3f);
    return 4;
}

function codePointsToString(codePoints) {
    let out = "";
    const chunk = [];
    for (let i = 0; i < codePoints.length; i++) {
        const codePoint = codePoints[i];
        if (codePoint <= 0xffff) {
            chunk.push(codePoint);
        } else {
            const value = codePoint - 0x10000;
            chunk.push(0xd800 + (value >> 10), 0xdc00 + (value & 0x3ff));
        }
        if (chunk.length >= 4096) {
            out += String.fromCharCode.apply(null, chunk);
            chunk.length = 0;
        }
    }
    if (chunk.length) out += String.fromCharCode.apply(null, chunk);
    return out;
}

// ---------------------------------------------------------------------------------------------
// UTF-8 decoding state machine (shared by the streaming TextDecoder and the one-shot helper)
// ---------------------------------------------------------------------------------------------

function newUtf8State() {
    return { codePoint: 0, bytesNeeded: 0, bytesSeen: 0, lower: 0x80, upper: 0xbf };
}

function resetUtf8State(state) {
    state.codePoint = 0;
    state.bytesNeeded = 0;
    state.bytesSeen = 0;
    state.lower = 0x80;
    state.upper = 0xbf;
}

// Decode as many bytes as possible. `state` is mutated and may hold a partial sequence when
// `stream` is true; the returned array contains code points.
function decodeUtf8Into(state, bytes, stream, encoding, fatal) {
    const codePoints = [];
    let i = 0;
    while (i < bytes.length) {
        const byte = bytes[i];

        if (state.bytesNeeded === 0) {
            if (byte <= 0x7f) {
                codePoints.push(byte);
                i++;
                continue;
            }
            if (byte >= 0xc2 && byte <= 0xdf) {
                state.bytesNeeded = 1;
                state.codePoint = byte & 0x1f;
                i++;
                continue;
            }
            if (byte >= 0xe0 && byte <= 0xef) {
                if (byte === 0xe0) state.lower = 0xa0;
                if (byte === 0xed) state.upper = 0x9f;
                state.bytesNeeded = 2;
                state.codePoint = byte & 0x0f;
                i++;
                continue;
            }
            if (byte >= 0xf0 && byte <= 0xf4) {
                if (byte === 0xf0) state.lower = 0x90;
                if (byte === 0xf4) state.upper = 0x8f;
                state.bytesNeeded = 3;
                state.codePoint = byte & 0x07;
                i++;
                continue;
            }
            // Invalid start byte: 0x80-0xC1, 0xF5-0xFF (including 5/6-byte leads).
            if (fatal) throw encodingInvalid(encoding);
            codePoints.push(0xfffd);
            i++;
            continue;
        }

        if (byte < state.lower || byte > state.upper) {
            // Invalid continuation. Emit one replacement for the maximal subpart seen so far and
            // reprocess this byte from scratch (it is not consumed).
            resetUtf8State(state);
            if (fatal) throw encodingInvalid(encoding);
            codePoints.push(0xfffd);
            continue;
        }

        state.lower = 0x80;
        state.upper = 0xbf;
        state.codePoint = (state.codePoint << 6) | (byte & 0x3f);
        state.bytesSeen++;
        i++;

        if (state.bytesSeen === state.bytesNeeded) {
            codePoints.push(state.codePoint);
            resetUtf8State(state);
        }
    }

    if (!stream && state.bytesNeeded !== 0) {
        resetUtf8State(state);
        if (fatal) throw encodingInvalid(encoding);
        codePoints.push(0xfffd);
    }

    return codePoints;
}

function decodeUTF8(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (hostText !== undefined && hostText !== null) return hostText.decode(bytes, false);
    return codePointsToString(decodeUtf8Into(newUtf8State(), bytes, false, "utf-8", false));
}

// ---------------------------------------------------------------------------------------------
// Single-byte encodings
// ---------------------------------------------------------------------------------------------

// windows-1252 for 0x80-0x9F; every other byte maps to the same code point.
const WINDOWS_1252 = [
    0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
    0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
    0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

// ---------------------------------------------------------------------------------------------
// Label normalisation
// ---------------------------------------------------------------------------------------------

const LABELS = Object.create(null);
function addLabel(label, encoding) {
    LABELS[label] = encoding;
}

["utf-8", "utf8", "unicode-1-1-utf-8", "unicode11utf8", "unicode20utf8", "x-unicode20utf8"].forEach(
    (label) => addLabel(label, "utf-8"),
);
["utf-16le", "utf-16", "ucs-2", "ucs2", "unicodefffe"].forEach((label) =>
    addLabel(label, "utf-16le"),
);
[
    "windows-1252",
    "cp1252",
    "x-cp1252",
    "latin1",
    "iso-8859-1",
    "iso8859-1",
    "iso88591",
    "iso_8859-1",
    "iso_8859-1:1987",
    "l1",
    "ascii",
    "us-ascii",
    "ansi_x3.4-1968",
    "iso-ir-100",
    "cp819",
    "ibm819",
    "csisolatin1",
].forEach((label) => addLabel(label, "windows-1252"));

function normalizeLabel(label) {
    // Labels are ASCII-whitespace-trimmed and lower-cased by the Encoding Standard.
    const key = `${label}`.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "").toLowerCase();
    return LABELS[key] || null;
}

function isSingleByte(encoding) {
    return encoding === "windows-1252";
}

// ---------------------------------------------------------------------------------------------
// Input coercion
// ---------------------------------------------------------------------------------------------

function toBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) {
        return new Uint8Array(value);
    }
    throw invalidArgType(
        "list",
        "an instance of SharedArrayBuffer, ArrayBuffer or ArrayBufferView",
        value,
    );
}

// ---------------------------------------------------------------------------------------------
// TextEncoder
// ---------------------------------------------------------------------------------------------

class TextEncoder {
    get encoding() {
        return "utf-8";
    }

    encode(input) {
        return encodeUTF8(input === undefined ? "" : input);
    }

    encodeInto(source, destination) {
        const str = `${source === undefined ? "" : source}`;
        if (!(destination instanceof Uint8Array)) {
            throw invalidArgType("dest", "an instance of Uint8Array", destination);
        }

        let read = 0;
        let written = 0;
        while (read < str.length) {
            let codePoint = str.charCodeAt(read);
            let units = 1;

            if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
                const next = read + 1 < str.length ? str.charCodeAt(read + 1) : 0;
                if (next >= 0xdc00 && next <= 0xdfff) {
                    codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00);
                    units = 2;
                } else {
                    codePoint = 0xfffd;
                }
            } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
                codePoint = 0xfffd;
            }

            const needed = utf8Length(codePoint);
            // Never write a partial code point: a surrogate pair that does not fit is not consumed.
            if (written + needed > destination.length) break;
            writeCodePoint(destination, written, codePoint);
            read += units;
            written += needed;
        }

        return { read, written };
    }
}

// ---------------------------------------------------------------------------------------------
// TextDecoder
// ---------------------------------------------------------------------------------------------

class TextDecoder {
    constructor(encoding, options) {
        const label = encoding === undefined ? "utf-8" : encoding;
        const normalized = normalizeLabel(label);
        if (normalized === null) throw encodingNotSupported(label);

        const opts = options === undefined || options === null ? {} : Object(options);

        this._encoding = normalized;
        this._fatal = Boolean(opts.fatal);
        this._ignoreBOM = Boolean(opts.ignoreBOM);
        this._reset();
    }

    get encoding() {
        return this._encoding;
    }

    get fatal() {
        return this._fatal;
    }

    get ignoreBOM() {
        return this._ignoreBOM;
    }

    _reset() {
        this._bomSeen = this._ignoreBOM || isSingleByte(this._encoding);
        if (this._encoding === "utf-8") {
            this._state = newUtf8State();
        } else if (this._encoding === "utf-16le") {
            this._state = { pendingByte: -1, leadSurrogate: -1 };
        } else {
            this._state = null;
        }
    }

    decode(input, options) {
        const stream = options !== undefined && options !== null && Boolean(options.stream);
        let bytes;
        if (input === undefined) {
            bytes = EMPTY;
        } else {
            bytes = toBytes(input);
        }

        try {
            let text = this._decode(bytes, stream);

            if (!this._bomSeen && text.length > 0) {
                this._bomSeen = true;
                if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
            }

            return text;
        } catch (err) {
            this._reset();
            throw err;
        } finally {
            if (!stream) this._reset();
        }
    }

    _decode(bytes, stream) {
        const encoding = this._encoding;
        if (encoding === "utf-8") {
            // A flush (`stream: false` with no new bytes) still has to report the partial sequence left
            // by the previous streaming call, so the host path is only safe when no state is pending.
            const noPendingBytes = this._state.bytesNeeded === 0;
            if (!stream && noPendingBytes && hostText !== undefined && hostText !== null) {
                const decoded = hostText.decode(bytes, this._fatal);
                // `null` means the bytes were not valid UTF-8 and `fatal` was set.
                if (decoded === null) throw encodingInvalid(encoding);
                return decoded;
            }
            return codePointsToString(
                decodeUtf8Into(this._state, bytes, stream, encoding, this._fatal),
            );
        }
        if (encoding === "utf-16le") return this._decodeUtf16le(bytes, stream);
        // windows-1252: stateless, one code point per byte.
        return this._decodeWindows1252(bytes);
    }

    _decodeWindows1252(bytes) {
        let out = "";
        let chunk = [];
        for (let i = 0; i < bytes.length; i++) {
            const byte = bytes[i];
            chunk.push(byte >= 0x80 && byte <= 0x9f ? WINDOWS_1252[byte - 0x80] : byte);
            if (chunk.length === 4096) {
                out += String.fromCharCode.apply(null, chunk);
                chunk = [];
            }
        }
        if (chunk.length) out += String.fromCharCode.apply(null, chunk);
        return out;
    }

    _decodeUtf16le(bytes, stream) {
        const state = this._state;
        const codeUnits = [];

        let i = 0;
        // A byte held from the previous call completes the first code unit.
        if (state.pendingByte >= 0) {
            if (bytes.length === 0) return this._finishUtf16le(codeUnits, stream);
            codeUnits.push(state.pendingByte | (bytes[0] << 8));
            state.pendingByte = -1;
            i = 1;
        }

        for (; i + 1 < bytes.length; i += 2) {
            codeUnits.push(bytes[i] | (bytes[i + 1] << 8));
        }
        if (i < bytes.length) state.pendingByte = bytes[i];

        return this._finishUtf16le(codeUnits, stream);
    }

    _finishUtf16le(codeUnits, stream) {
        const state = this._state;
        const output = [];
        let lead = state.leadSurrogate;

        for (let i = 0; i < codeUnits.length; i++) {
            const unit = codeUnits[i];
            if (lead >= 0) {
                if (unit >= 0xdc00 && unit <= 0xdfff) {
                    output.push(0x10000 + ((lead - 0xd800) << 10) + (unit - 0xdc00));
                    lead = -1;
                    continue;
                }
                // The lead surrogate was not followed by a trail surrogate.
                if (this._fatal) throw encodingInvalid(this._encoding);
                output.push(0xfffd);
                lead = -1;
            }

            if (unit >= 0xd800 && unit <= 0xdbff) {
                lead = unit;
                continue;
            }
            if (unit >= 0xdc00 && unit <= 0xdfff) {
                if (this._fatal) throw encodingInvalid(this._encoding);
                output.push(0xfffd);
                continue;
            }
            output.push(unit);
        }

        state.leadSurrogate = lead;

        if (!stream) {
            if (state.leadSurrogate >= 0) {
                // A trailing lead surrogate and a trailing odd byte at EOF are reported as a single
                // replacement (Node/ICU behaviour), not one each.
                state.leadSurrogate = -1;
                state.pendingByte = -1;
                if (this._fatal) throw encodingInvalid(this._encoding);
                output.push(0xfffd);
            } else if (state.pendingByte >= 0) {
                state.pendingByte = -1;
                if (this._fatal) throw encodingInvalid(this._encoding);
                output.push(0xfffd);
            }
        }

        return codePointsToString(output);
    }
}

module.exports = { TextEncoder, TextDecoder, encodeUTF8, decodeUTF8 };
