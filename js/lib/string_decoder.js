"use strict";

// Node-compatible `StringDecoder`.
//
// The decoder's job is to turn a stream of byte chunks into text without splitting a character
// across chunk boundaries. For each encoding it keeps back only the bytes that can still become
// a valid character:
//
//   utf8      1-3 trailing bytes of an incomplete sequence
//   utf16le   a trailing odd byte, or a trailing lead surrogate (2 bytes)
//   base64    1-2 bytes so every emitted group is 3 source bytes (4 base64 characters)
//   hex       nothing: each byte always yields exactly two nibbles
//   latin1    stateless
//   ascii     stateless
//
// `end()` flushes the pending bytes: utf8 emits a single U+FFFD (the maximal-subpart rule),
// utf16le emits a held lead surrogate as-is (matching Node) and drops a lone trailing byte, and
// base64 emits the final group with padding.

let textcodec;
try {
  textcodec = require("textcodec");
} catch (_) {
  textcodec = require("./textcodec.js");
}
const decodeUTF8 = textcodec.decodeUTF8;

const EMPTY = new Uint8Array(0);

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

function makeError(Ctor, code, message) {
  const err = new Ctor(message);
  err.code = code;
  return err;
}

function unknownEncoding(encoding) {
  return makeError(TypeError, "ERR_UNKNOWN_ENCODING", `Unknown encoding: ${String(encoding)}`);
}

function invalidArgType(name, expected, value) {
  let received;
  if (value === null) received = "null";
  else if (typeof value === "string") received = `type string ('${value}')`;
  else if (ArrayBuffer.isView(value)) {
    received = `an instance of ${(value.constructor && value.constructor.name) || "TypedArray"}`;
  } else received = `type ${typeof value} (${String(value)})`;
  return makeError(
    TypeError,
    "ERR_INVALID_ARG_TYPE",
    `The "${name}" argument must be ${expected}. Received ${received}`,
  );
}

function normalizeEncoding(encoding) {
  if (encoding === undefined || encoding === null || encoding === "") return "utf8";
  if (typeof encoding !== "string") return null;
  return ENCODING_ALIASES[encoding.toLowerCase()] || null;
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) {
    return new Uint8Array(value);
  }
  throw invalidArgType("buf", "an instance of Buffer, ArrayBuffer or ArrayBufferView", value);
}

function concatBytes(first, second) {
  if (first.length === 0) return second;
  if (second.length === 0) return first;
  const out = new Uint8Array(first.length + second.length);
  out.set(first, 0);
  out.set(second, first.length);
  return out;
}

const HEX_DIGITS = "0123456789abcdef";
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function hexEncode(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += HEX_DIGITS[bytes[i] >> 4] + HEX_DIGITS[bytes[i] & 0x0f];
  }
  return out;
}

function base64Encode(bytes, url) {
  const alphabet = url ? BASE64URL_ALPHABET : BASE64_ALPHABET;
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      alphabet[n >> 18] +
      alphabet[(n >> 12) & 0x3f] +
      alphabet[(n >> 6) & 0x3f] +
      alphabet[n & 0x3f];
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const n = bytes[i] << 16;
    out += alphabet[n >> 18] + alphabet[(n >> 12) & 0x3f];
    if (!url) out += "==";
  } else if (remaining === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += alphabet[n >> 18] + alphabet[(n >> 12) & 0x3f] + alphabet[(n >> 6) & 0x3f];
    if (!url) out += "=";
  }
  return out;
}

function latin1Text(bytes, mask) {
  let out = "";
  let chunk = [];
  for (let i = 0; i < bytes.length; i++) {
    chunk.push(bytes[i] & mask);
    if (chunk.length === 4096) {
      out += String.fromCharCode.apply(null, chunk);
      chunk = [];
    }
  }
  if (chunk.length) out += String.fromCharCode.apply(null, chunk);
  return out;
}

// Decode one chunk of UTF-8, holding back at most a single incomplete sequence at the end.
//
// Node's StringDecoder holds a lead byte (0xC0-0xF7) plus any continuation bytes, waiting for
// the full sequence length. It only requires the generic continuation range while waiting; the
// stricter E0/ED/F0/F4 second-byte boundaries are applied when the complete sequence is
// decoded. Matching that split point is what makes `lastNeed`/`lastTotal` agree with Node and
// keeps invalid sequences reported as one replacement per maximal subpart.
function utf8SequenceLength(lead) {
  if (lead <= 0xdf) return 2;
  if (lead <= 0xef) return 3;
  return 4;
}

class StringDecoder {
  constructor(encoding, options) {
    const normalized = normalizeEncoding(encoding);
    if (normalized === null) throw unknownEncoding(encoding);
    this.encoding = normalized;
    this.lastNeed = 0;
    this.lastTotal = 0;
    this._pending = EMPTY;
    this._pendingByte = -1;
    this._leadSurrogate = -1;
    this._options = options === undefined || options === null ? {} : Object(options);
  }

  write(buffer) {
    // Legacy Node behaviour: strings pass through untouched.
    if (typeof buffer === "string") return buffer;
    const bytes = toBytes(buffer);
    if (bytes.length === 0) return "";

    let text;
    switch (this.encoding) {
      case "utf8":
        text = this._writeUtf8(bytes);
        break;
      case "utf16le":
        text = this._writeUtf16le(bytes);
        break;
      case "base64":
      case "base64url":
        text = this._writeBase64(bytes);
        break;
      case "hex":
        text = hexEncode(bytes);
        this.lastNeed = 0;
        this.lastTotal = 0;
        break;
      case "latin1":
        text = latin1Text(bytes, 0xff);
        this.lastNeed = 0;
        this.lastTotal = 0;
        break;
      case "ascii":
        text = latin1Text(bytes, 0x7f);
        this.lastNeed = 0;
        this.lastTotal = 0;
        break;
      default:
        throw unknownEncoding(this.encoding);
    }

    return text;
  }

  // Legacy Node method: discard buffered bytes, then decode the rest of `buf`.
  text(buf, offset) {
    this._pending = EMPTY;
    this._pendingByte = -1;
    this._leadSurrogate = -1;
    this.lastNeed = 0;
    this.lastTotal = 0;
    return this.write(offset === undefined ? buf : buf.slice(offset));
  }

  end(buffer) {
    let text = "";
    if (buffer !== undefined) text = this.write(buffer);

    switch (this.encoding) {
      case "utf8":
        if (this._pending.length > 0) {
          text += decodeUTF8(this._pending);
          this._pending = EMPTY;
        }
        break;
      case "utf16le":
        if (this._leadSurrogate >= 0) {
          text += String.fromCharCode(this._leadSurrogate);
          this._leadSurrogate = -1;
        }
        // A lone trailing byte is dropped, matching Node's utf16le decoder.
        this._pendingByte = -1;
        break;
      case "base64":
      case "base64url":
        if (this._pending.length > 0) {
          text += base64Encode(this._pending, this.encoding === "base64url");
          this._pending = EMPTY;
        }
        break;
      default:
        break;
    }

    this.lastNeed = 0;
    this.lastTotal = 0;
    return text;
  }

  _writeUtf8(bytes) {
    const combined = concatBytes(this._pending, bytes);
    let out = "";
    let i = 0;
    let pending = EMPTY;
    const sequence = [];

    while (i < combined.length) {
      const byte = combined[i];

      if (sequence.length === 0) {
        if (byte < 0x80) {
          out += String.fromCharCode(byte);
          i++;
          continue;
        }
        if (byte >= 0xc0 && byte <= 0xf7) {
          sequence.push(byte);
          i++;
          continue;
        }
        // A bare continuation byte or an invalid start (0x80-0xBF, 0xF8-0xFF).
        out += "\ufffd";
        i++;
        continue;
      }

      if (byte >= 0x80 && byte <= 0xbf) {
        sequence.push(byte);
        i++;
        if (sequence.length === utf8SequenceLength(sequence[0])) {
          out += decodeUTF8(Uint8Array.from(sequence));
          sequence.length = 0;
        }
        continue;
      }

      // The sequence was interrupted by a non-continuation byte: flush it as an incomplete
      // maximal subpart and reprocess this byte from scratch.
      out += decodeUTF8(Uint8Array.from(sequence));
      sequence.length = 0;
    }

    if (sequence.length > 0) pending = Uint8Array.from(sequence);

    this._pending = pending;
    if (pending.length > 0) {
      this.lastNeed = utf8SequenceLength(pending[0]) - pending.length;
      this.lastTotal = utf8SequenceLength(pending[0]);
    } else {
      this.lastNeed = 0;
      this.lastTotal = 0;
    }
    return out;
  }

  _writeUtf16le(bytes) {
    let out = "";

    // `lead` is a held high surrogate; `_pendingByte` is a byte waiting for its pair. Node's
    // native UTF-16 decoder decodes a unit completed from a carried-over byte in isolation, so
    // such a unit is emitted raw (no surrogate pairing).
    if (this._leadSurrogate >= 0) {
      let unit = -1;
      let consumed = 0;
      if (this._pendingByte >= 0) {
        unit = this._pendingByte | (bytes[0] << 8);
        consumed = 1;
      } else if (bytes.length >= 2) {
        unit = bytes[0] | (bytes[1] << 8);
        consumed = 2;
      }

      if (unit < 0) {
        // Still waiting for the low surrogate: remember the partial byte, if any.
        if (bytes.length === 1) this._pendingByte = bytes[0];
        this._setUtf16Counts(this._leadSurrogate, this._pendingByte);
        return out;
      }

      this._pendingByte = -1;
      if (unit >= 0xdc00 && unit <= 0xdfff) {
        out += String.fromCharCode(this._leadSurrogate, unit);
        this._leadSurrogate = -1;
        return out + this._utf16Rest(bytes.subarray(consumed), -1);
      }

      out += String.fromCharCode(this._leadSurrogate);
      this._leadSurrogate = -1;
      const nextLead = unit >= 0xd800 && unit <= 0xdbff ? unit : -1;
      if (nextLead < 0) out += String.fromCharCode(unit);
      return out + this._utf16Rest(bytes.subarray(consumed), nextLead);
    }

    if (this._pendingByte >= 0) {
      // A standalone odd byte completed by the first byte of this chunk: emitted raw.
      const unit = this._pendingByte | (bytes[0] << 8);
      this._pendingByte = -1;
      out += String.fromCharCode(unit);
      return out + this._utf16Rest(bytes.subarray(1), -1);
    }

    return out + this._utf16Rest(bytes, -1);
  }

  _utf16Rest(bytes, initialLead) {
    let out = "";
    let lead = initialLead;
    let position = 0;

    for (; position + 1 < bytes.length; position += 2) {
      const unit = bytes[position] | (bytes[position + 1] << 8);
      if (lead >= 0) {
        if (unit >= 0xdc00 && unit <= 0xdfff) {
          out += String.fromCharCode(lead, unit);
          lead = -1;
          continue;
        }
        out += String.fromCharCode(lead);
        lead = -1;
      }
      if (unit >= 0xd800 && unit <= 0xdbff) {
        lead = unit;
        continue;
      }
      out += String.fromCharCode(unit);
    }

    if (position < bytes.length) {
      this._pendingByte = bytes[position];
      // A trailing odd byte means a prior high surrogate can no longer pair: emit it raw.
      if (lead >= 0) {
        out += String.fromCharCode(lead);
        lead = -1;
      }
    }

    this._leadSurrogate = lead;
    this._setUtf16Counts(lead, this._pendingByte);
    return out;
  }

  _setUtf16Counts(lead, pending) {
    if (lead >= 0) {
      this.lastNeed = pending >= 0 ? 1 : 2;
      this.lastTotal = 4;
    } else if (pending >= 0) {
      this.lastNeed = 1;
      this.lastTotal = 2;
    } else {
      this.lastNeed = 0;
      this.lastTotal = 0;
    }
  }

  _writeBase64(bytes) {
    const combined = concatBytes(this._pending, bytes);
    const complete = combined.length - (combined.length % 3);
    const text = base64Encode(
      complete === combined.length ? combined : combined.subarray(0, complete),
      this.encoding === "base64url",
    );
    this._pending = complete === combined.length ? EMPTY : combined.slice(complete);
    if (this._pending.length > 0) {
      this.lastNeed = 3 - this._pending.length;
      this.lastTotal = 3;
    } else {
      this.lastNeed = 0;
      this.lastTotal = 0;
    }
    return text;
  }
}

module.exports = { StringDecoder };
