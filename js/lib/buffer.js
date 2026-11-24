"use strict";

// The search primitives run in the host: a byte loop over a megabyte costs 40 ms in JavaScript and
// tens of microseconds natively. Absent under the node oracle, where the loops below still run.
const hostBuffer = (() => {
  const host = globalThis.__ln_host;
  return host === undefined || host === null ? undefined : host.buffer;
})();

// Node-compatible `Buffer`, implemented as a `Uint8Array` subclass in pure JavaScript.
//
// Design (docs/compat.md §4, divergence D7): there is no pool allocator. `Buffer.allocUnsafe`
// and `Buffer.allocUnsafeSlow` therefore return zero-filled memory just like `alloc`; the only
// difference is intent, since an onde embedder cannot expose uninitialised engine memory safely.
//
// Encodings are not delegated to the engine: utf8/utf-8 comes from `textcodec.js` (the WHATWG
// replacement rules and the host fast path), and hex, base64/base64url, latin1/binary, ascii and
// utf16le/ucs2/ucs-2 come from `internal/bytes.js`. What stays here is Buffer's own policy:
// validation, clamping and the label errors.

let textcodec;
try {
  textcodec = require("textcodec");
} catch (_) {
  // Under plain `node` the stdlib sources are loaded by path, not by builtin name.
  textcodec = require("./textcodec.js");
}
const encodeUTF8 = textcodec.encodeUTF8;
const decodeUTF8 = textcodec.decodeUTF8;
// The non-UTF-8 Buffer codecs and the shared alias table live in `internal/bytes.js`.
const bytecodec = require("./internal/bytes.js");

const {
  coded: makeError,
  describeValue: describe,
  invalidArgType,
  invalidArgValue,
  outOfRange,
  unknownEncoding,
} = require("./internal/errors.js");

const MAX_LENGTH = Number.MAX_SAFE_INTEGER;
const TWO_POW_32 = 4294967296;
const TWO_POW_63 = 1n << 63n;
const TWO_POW_64 = 1n << 64n;

// ---------------------------------------------------------------------------------------------
// Errors (Node names, codes and message shapes)
// ---------------------------------------------------------------------------------------------

function bufferOutOfBounds(name) {
  if (name === undefined) {
    return makeError(
      RangeError,
      "ERR_BUFFER_OUT_OF_BOUNDS",
      "Attempt to access memory outside buffer bounds",
    );
  }
  return makeError(RangeError, "ERR_BUFFER_OUT_OF_BOUNDS", `"${name}" is outside of buffer bounds`);
}

function invalidBufferSize(bits) {
  return makeError(
    RangeError,
    "ERR_INVALID_BUFFER_SIZE",
    `Buffer size must be a multiple of ${bits}-bits`,
  );
}

// ---------------------------------------------------------------------------------------------
// Encoding policy
// ---------------------------------------------------------------------------------------------

function getEncoding(encoding) {
  if (encoding === undefined || encoding === null) return "utf8";
  // Node treats a non-string encoding as its default rather than throwing (it is coerced by
  // the native binding); only unknown *strings* are an error. The empty string is one: the
  // shared table maps it to utf8 for `from`/`byteLength`, but `toString("")` throws in Node.
  if (typeof encoding !== "string") return "utf8";
  if (encoding === "") throw unknownEncoding(encoding);
  const normalized = bytecodec.canonicalEncoding(encoding);
  if (normalized === null) throw unknownEncoding(encoding);
  return normalized;
}

// `from`/`byteLength` treat any falsy encoding as utf8 (Node's string fast path).
function getInputEncoding(encoding) {
  if (encoding === "") return "utf8";
  return getEncoding(encoding);
}

// `write` and `fill` treat a non-string encoding slightly differently from `from`/`byteLength`.
function getWriteEncoding(encoding) {
  if (!encoding || encoding === "utf8") return "utf8";
  if (typeof encoding !== "string") throw unknownEncoding(encoding);
  return getEncoding(encoding);
}

function getFillEncoding(encoding) {
  if (encoding === undefined || encoding === null || encoding === "") return "utf8";
  if (typeof encoding !== "string") throw invalidArgType("encoding", "of type string", encoding);
  return getEncoding(encoding);
}

function encodeString(string, encoding) {
  switch (encoding) {
    case "utf8":
      return encodeUTF8(string);
    case "utf16le":
      return bytecodec.encodeUtf16le(string);
    case "latin1":
      return bytecodec.encodeLatin1(string);
    case "ascii":
      return bytecodec.encodeAscii(string);
    case "hex":
      return bytecodec.hexDecode(string);
    case "base64":
    case "base64url":
      return bytecodec.base64Decode(string, encoding === "base64url");
    default:
      throw unknownEncoding(encoding);
  }
}

function bytesToString(bytes, start, end, encoding) {
  switch (encoding) {
    case "utf8":
      return decodeUTF8(bytes.subarray(start, end));
    case "utf16le":
      return bytecodec.decodeUtf16le(bytes, start, end);
    case "latin1":
      return bytecodec.decodeLatin1(bytes, start, end);
    case "ascii":
      return bytecodec.decodeAscii(bytes, start, end);
    case "hex":
      return bytecodec.hexEncode(bytes, start, end);
    case "base64":
      return bytecodec.base64Encode(bytes, start, end, false);
    case "base64url":
      return bytecodec.base64Encode(bytes, start, end, true);
    default:
      throw unknownEncoding(encoding);
  }
}

// ---------------------------------------------------------------------------------------------
// Construction helpers
// ---------------------------------------------------------------------------------------------

function checkSize(size) {
  if (typeof size !== "number") throw invalidArgType("size", "of type number", size);
  if (!(size >= 0 && size <= MAX_LENGTH)) {
    throw outOfRange("size", `>= 0 && <= ${MAX_LENGTH}`, size);
  }
  return Math.trunc(size);
}

function fromBytes(bytes) {
  const buffer = new Buffer(bytes.length);
  buffer.set(bytes);
  return buffer;
}

function fromArrayLike(list) {
  const length = list.length >>> 0;
  const buffer = new Buffer(length);
  for (let i = 0; i < length; i++) {
    const value = list[i];
    if (typeof value !== "number") {
      throw invalidArgType(`array[${i}]`, "of type number", value);
    }
    if (!(value >= 0 && value <= 255)) {
      throw outOfRange("value", ">= 0 and <= 255", value);
    }
    buffer[i] = value;
  }
  return buffer;
}

function isSharedArrayBuffer(value) {
  return typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer;
}

function fromArrayBuffer(arrayBuffer, byteOffset, length) {
  let offset = byteOffset === undefined ? 0 : Number(byteOffset);
  if (Number.isNaN(offset)) offset = 0;
  const maxLength = arrayBuffer.byteLength - offset;
  if (maxLength < 0) throw bufferOutOfBounds("offset");
  if (offset < 0) {
    throw new RangeError(`Start offset ${offset} is outside the bounds of the buffer`);
  }

  let size;
  if (length === undefined) {
    size = maxLength;
  } else {
    size = Number(length);
    if (!(size > 0)) {
      size = 0;
    } else if (size > maxLength) {
      throw bufferOutOfBounds("length");
    }
  }
  return new Buffer(arrayBuffer, offset, size);
}

// ---------------------------------------------------------------------------------------------
// Bounds helpers for the numeric accessors
// ---------------------------------------------------------------------------------------------

function checkOffset(buffer, offset, size) {
  if (buffer.length < size) throw bufferOutOfBounds();
  if (typeof offset !== "number") throw invalidArgType("offset", "of type number", offset);
  if (!Number.isInteger(offset)) throw outOfRange("offset", "an integer", offset);
  const limit = buffer.length - size;
  if (offset < 0 || offset > limit) {
    throw outOfRange("offset", `>= 0 and <= ${limit}`, offset);
  }
}

function checkInteger(value, name, min, max) {
  if (typeof value !== "number") throw invalidArgType(name, "of type number", value);
  if (!Number.isInteger(value)) throw outOfRange(name, "an integer", value);
  if (value < min || value > max) {
    throw outOfRange(name, `>= ${min} and <= ${max}`, value);
  }
}

function checkBigIntRange(value, min, max, rangeText) {
  // Relational comparison is defined across BigInt and Number, so Node validates the range
  // before it complains about the value type.
  if (value < min || value > max) throw outOfRange("value", rangeText, value);
}

function requireBigInt(value) {
  if (typeof value !== "bigint") {
    throw makeError(
      TypeError,
      undefined,
      "Cannot mix BigInt and other types, use explicit conversions",
    );
  }
}

function checkNumber(value, name) {
  if (typeof value !== "number") throw invalidArgType(name, "of type number", value);
}

function validateInteger(value, name, min, max) {
  if (typeof value !== "number") throw invalidArgType(name, "of type number", value);
  if (!Number.isInteger(value)) throw outOfRange(name, "an integer", value);
  if (value < min || value > max) {
    throw outOfRange(name, `>= ${min} && <= ${max}`, value);
  }
}

// ---------------------------------------------------------------------------------------------
// Buffer
// ---------------------------------------------------------------------------------------------

class Buffer extends Uint8Array {
  // -------------------------------------------------------------------------------------------
  // Static API
  // -------------------------------------------------------------------------------------------

  static from(value, encodingOrOffset, length) {
    if (typeof value === "string") {
      return fromBytes(encodeString(value, getInputEncoding(encodingOrOffset)));
    }

    if (value instanceof ArrayBuffer || isSharedArrayBuffer(value)) {
      return fromArrayBuffer(value, encodingOrOffset, length);
    }

    if (ArrayBuffer.isView(value)) {
      // Buffers, typed arrays and DataViews are all copied.
      return fromBytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    }

    if (Array.isArray(value)) return fromArrayLike(value);

    if (value !== null && typeof value === "object") {
      if (typeof value.length === "number") return fromArrayLike(value);
      const iterator = value[Symbol.iterator];
      if (typeof iterator === "function") return fromArrayLike(Array.from(value));
    }

    throw makeError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      "The first argument must be of type string or an instance of Buffer, ArrayBuffer, " +
        `or Array or an Array-like Object. Received ${describe(value)}`,
    );
  }

  static alloc(size, fill, encoding) {
    const length = checkSize(size);
    const buffer = new Buffer(length);
    if (fill !== undefined && length > 0) buffer.fill(fill, 0, length, encoding);
    return buffer;
  }

  // No pool allocator (D7): this is zero-filled, not uninitialised. The name is kept so code
  // written for Node keeps working.
  static allocUnsafe(size) {
    return new Buffer(checkSize(size));
  }

  static allocUnsafeSlow(size) {
    return new Buffer(checkSize(size));
  }

  static concat(list, totalLength) {
    if (!Array.isArray(list)) throw invalidArgType("list", "an instance of Array", list);

    let sum = 0;
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (!(item instanceof Uint8Array)) {
        throw invalidArgType(`list[${i}]`, "an instance of Buffer or Uint8Array", item);
      }
      sum += item.length;
    }

    if (list.length === 0) return Buffer.alloc(0);

    let total = sum;
    if (totalLength !== undefined) {
      validateInteger(totalLength, "length", 0, MAX_LENGTH);
      total = totalLength;
    }

    const buffer = Buffer.alloc(total);
    let offset = 0;
    const writable = Math.min(total, sum);
    for (let i = 0; i < list.length && offset < writable; i++) {
      const item = list[i];
      const count = Math.min(item.length, writable - offset);
      buffer.set(item.subarray(0, count), offset);
      offset += count;
    }
    return buffer;
  }

  static byteLength(string, encoding) {
    if (typeof string !== "string") {
      if (ArrayBuffer.isView(string) || string instanceof ArrayBuffer) return string.byteLength;
      throw makeError(
        TypeError,
        "ERR_INVALID_ARG_TYPE",
        "The \"string\" argument must be of type string or an instance of Buffer or " +
          `ArrayBuffer. Received ${describe(string)}`,
      );
    }
    const normalized = getInputEncoding(encoding);
    switch (normalized) {
      case "utf8":
        return encodeUTF8(string).length;
      case "utf16le":
        return string.length * 2;
      case "latin1":
      case "ascii":
        return string.length;
      case "hex":
        return string.length >>> 1;
      case "base64":
      case "base64url": {
        let chars = string.length;
        // Node only discounts up to two trailing padding characters.
        if (chars > 0 && string.charCodeAt(chars - 1) === 0x3d) chars--;
        if (chars > 0 && string.charCodeAt(chars - 1) === 0x3d) chars--;
        return (chars * 3) >>> 2;
      }
      default:
        throw unknownEncoding(normalized);
    }
  }

  static isBuffer(value) {
    return value instanceof Buffer;
  }

  static isEncoding(encoding) {
    // The empty label means utf8 to `from`, but is not an encoding name; Node says false.
    return (
      typeof encoding === "string" &&
      encoding !== "" &&
      bytecodec.canonicalEncoding(encoding) !== null
    );
  }

  static compare(buf1, buf2) {
    if (!(buf1 instanceof Uint8Array)) {
      throw invalidArgType("buf1", "an instance of Buffer or Uint8Array", buf1);
    }
    if (!(buf2 instanceof Uint8Array)) {
      throw invalidArgType("buf2", "an instance of Buffer or Uint8Array", buf2);
    }
    return compareBytes(buf1, buf2);
  }

  // -------------------------------------------------------------------------------------------
  // Conversion
  // -------------------------------------------------------------------------------------------

  toString(encoding, start, end) {
    if (encoding !== undefined && typeof encoding !== "string") {
      throw unknownEncoding(encoding);
    }
    const normalized = encoding === undefined ? "utf8" : getEncoding(encoding);
    if (this.length === 0) return "";

    let begin = start === undefined ? 0 : Math.trunc(start);
    if (!Number.isFinite(begin) || begin < 0) begin = 0;
    if (begin > this.length) begin = this.length;

    let finish = end === undefined ? this.length : Math.trunc(end);
    if (!Number.isFinite(finish) || finish < 0) finish = 0;
    if (finish > this.length) finish = this.length;
    if (finish <= begin) return "";

    return bytesToString(this, begin, finish, normalized);
  }

  toJSON() {
    return { type: "Buffer", data: Array.from(this) };
  }

  inspect() {
    const max = 50;
    const parts = [];
    const count = Math.min(this.length, max);
    for (let i = 0; i < count; i++) parts.push(bytecodec.hexEncode(this, i, i + 1));
    let out = `<Buffer ${parts.join(" ")}`;
    if (this.length > max) {
      const extra = this.length - max;
      out += ` ... ${extra} more ${extra === 1 ? "byte" : "bytes"}`;
    }
    return out + ">";
  }

  // -------------------------------------------------------------------------------------------
  // Comparison and copying
  // -------------------------------------------------------------------------------------------

  equals(other) {
    if (!(other instanceof Uint8Array)) {
      throw invalidArgType("otherBuffer", "an instance of Buffer or Uint8Array", other);
    }
    return compareBytes(this, other) === 0;
  }

  compare(target, targetStart, targetEnd, sourceStart, sourceEnd) {
    if (!(target instanceof Uint8Array)) {
      throw invalidArgType("target", "an instance of Buffer or Uint8Array", target);
    }

    let tStart = targetStart === undefined ? 0 : targetStart;
    let tEnd = targetEnd === undefined ? target.length : targetEnd;
    let sStart = sourceStart === undefined ? 0 : sourceStart;
    let sEnd = sourceEnd === undefined ? this.length : sourceEnd;

    validateInteger(tStart, "targetStart", 0, MAX_LENGTH);
    validateInteger(tEnd, "targetEnd", 0, target.length);
    validateInteger(sStart, "sourceStart", 0, MAX_LENGTH);
    validateInteger(sEnd, "sourceEnd", 0, this.length);

    if (sStart >= sEnd) return tStart >= tEnd ? 0 : -1;
    if (tStart >= tEnd) return 1;

    return compareRanges(this, sStart, sEnd, target, tStart, tEnd);
  }

  copy(target, targetStart, sourceStart, sourceEnd) {
    if (!(target instanceof Uint8Array)) {
      throw invalidArgType("target", "an instance of Buffer or Uint8Array", target);
    }

    let tStart = targetStart === undefined ? 0 : targetStart;
    if (typeof tStart !== "number") throw invalidArgType("targetStart", "of type number", tStart);
    if (!Number.isInteger(tStart)) throw outOfRange("targetStart", "an integer", tStart);
    if (tStart < 0) throw outOfRange("targetStart", ">= 0", tStart);

    let sStart = sourceStart === undefined ? 0 : sourceStart;
    validateInteger(sStart, "sourceStart", 0, this.length);

    let sEnd = sourceEnd === undefined ? this.length : sourceEnd;
    if (typeof sEnd !== "number") throw invalidArgType("sourceEnd", "of type number", sEnd);
    if (!Number.isInteger(sEnd)) throw outOfRange("sourceEnd", "an integer", sEnd);
    if (sEnd < 0) throw outOfRange("sourceEnd", ">= 0", sEnd);
    if (sEnd > this.length) sEnd = this.length;

    if (sStart > sEnd) return 0;
    const count = Math.min(sEnd - sStart, this.length - sStart, target.length - tStart);
    if (count <= 0) return 0;

    target.set(this.subarray(sStart, sStart + count), tStart);
    return count;
  }

  fill(value, offset, end, encoding) {
    // Node accepts an encoding in the offset or end position: fill(value, encoding) and
    // fill(value, offset, encoding).
    const stringValue = typeof value === "string";
    if (stringValue) {
      if (offset === undefined || typeof offset === "string") {
        encoding = offset;
        offset = 0;
        end = this.length;
      } else if (typeof end === "string") {
        encoding = end;
        end = this.length;
      }
    } else {
      encoding = undefined;
    }

    let pattern;
    if (stringValue) {
      pattern = encodeString(value, getFillEncoding(encoding));
      // Node turns an empty string into a zero fill.
      if (pattern.length === 0) pattern = Uint8Array.of(0);
    } else if (value instanceof Uint8Array) {
      pattern = value;
    } else {
      // Node coerces other values with unary plus and truncates to a byte: fill(null) fills
      // zeroes, fill(true) fills ones, and a BigInt throws a TypeError.
      const numeric = +value;
      pattern = Uint8Array.of((numeric >>> 0) & 0xff);
    }

    let start = offset;
    let finish = end;
    if (start === undefined) {
      start = 0;
      finish = this.length;
    } else {
      validateInteger(start, "offset", 0, MAX_LENGTH);
      if (finish === undefined) finish = this.length;
      else validateInteger(finish, "end", 0, this.length);
      if (start >= finish) return this;
    }

    const count = finish - start;
    if (count <= 0) return this;
    if (pattern.length === 0) {
      // Only reachable for an empty Buffer pattern: Node rejects it when there is a range.
      throw invalidArgValue("value", pattern, "is invalid");
    }

    let position = start;
    let index = 0;
    while (position < finish) {
      this[position++] = pattern[index++];
      if (index === pattern.length) index = 0;
    }
    return this;
  }

  // -------------------------------------------------------------------------------------------
  // String writing and searching
  // -------------------------------------------------------------------------------------------

  write(string, offset, length, encoding) {
    if (typeof string !== "string") {
      throw invalidArgType("string", "of type string", string);
    }

    let start = offset;
    let size = length;
    let enc = encoding;
    if (size === undefined && typeof start === "string") {
      enc = start;
      start = 0;
      size = this.length;
    } else if (typeof size === "string") {
      enc = size;
      size = undefined;
    }

    if (start === undefined) start = 0;
    else {
      if (typeof start !== "number") throw invalidArgType("offset", "of type number", start);
      if (!Number.isInteger(start)) throw outOfRange("offset", "an integer", start);
      if (start < 0 || start > this.length) {
        throw outOfRange("offset", `>= 0 && <= ${this.length}`, start);
      }
    }

    if (size === undefined) size = this.length - start;
    else {
      if (typeof size !== "number") throw invalidArgType("length", "of type number", size);
      if (!Number.isInteger(size)) throw outOfRange("length", "an integer", size);
      if (size < 0 || size > this.length) {
        throw outOfRange("length", `>= 0 && <= ${this.length}`, size);
      }
    }

    const normalized = getWriteEncoding(enc);
    const available = Math.min(size, this.length - start);
    if (available === 0) return 0;

    return writeString(this, string, start, available, normalized);
  }

  indexOf(value, byteOffset, encoding) {
    if (typeof value === "number") {
      return indexOfByte(this, value & 0xff, toIndexOffset(byteOffset, this.length));
    }
    const needle = this._needle(value, encoding);
    return indexOfBytes(this, needle, toIndexOffset(byteOffset, this.length));
  }

  lastIndexOf(value, byteOffset, encoding) {
    if (typeof value === "number") {
      return lastIndexOfByte(this, value & 0xff, toLastIndexOffset(byteOffset, this.length));
    }
    const needle = this._needle(value, encoding);
    return lastIndexOfBytes(this, needle, toLastIndexOffset(byteOffset, this.length));
  }

  includes(value, byteOffset, encoding) {
    return this.indexOf(value, byteOffset, encoding) !== -1;
  }

  _needle(value, encoding) {
    if (typeof value === "string") return encodeString(value, getEncoding(encoding));
    if (value instanceof Uint8Array) return value;
    throw invalidArgType(
      "value",
      "must be one of type number or string or an instance of Buffer or Uint8Array",
      value,
    );
  }

  // -------------------------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------------------------

  slice(start, end) {
    const view = this.subarray(start, end);
    if (view instanceof Buffer) return view;
    return new Buffer(view.buffer, view.byteOffset, view.length);
  }

  // -------------------------------------------------------------------------------------------
  // Numeric reads
  // -------------------------------------------------------------------------------------------

  readUInt8(offset) {
    checkOffset(this, offset === undefined ? 0 : offset, 1);
    return this[offset === undefined ? 0 : offset];
  }

  readInt8(offset) {
    const position = offset === undefined ? 0 : offset;
    checkOffset(this, position, 1);
    return (this[position] << 24) >> 24;
  }

  readUInt16LE(offset) {
    const position = offset === undefined ? 0 : offset;
    checkOffset(this, position, 2);
    return this[position] | (this[position + 1] << 8);
  }

  readUInt16BE(offset) {
    const position = offset === undefined ? 0 : offset;
    checkOffset(this, position, 2);
    return (this[position] << 8) | this[position + 1];
  }

  readInt16LE(offset) {
    return (this.readUInt16LE(offset) << 16) >> 16;
  }

  readInt16BE(offset) {
    return (this.readUInt16BE(offset) << 16) >> 16;
  }

  readUInt32LE(offset) {
    const position = offset === undefined ? 0 : offset;
    checkOffset(this, position, 4);
    return (
      this[position] +
      this[position + 1] * 0x100 +
      this[position + 2] * 0x10000 +
      this[position + 3] * 0x1000000
    );
  }

  readUInt32BE(offset) {
    const position = offset === undefined ? 0 : offset;
    checkOffset(this, position, 4);
    return (
      this[position] * 0x1000000 +
      this[position + 1] * 0x10000 +
      this[position + 2] * 0x100 +
      this[position + 3]
    );
  }

  readInt32LE(offset) {
    const position = offset === undefined ? 0 : offset;
    checkOffset(this, position, 4);
    return (
      this[position] |
      (this[position + 1] << 8) |
      (this[position + 2] << 16) |
      (this[position + 3] << 24)
    );
  }

  readInt32BE(offset) {
    const position = offset === undefined ? 0 : offset;
    checkOffset(this, position, 4);
    return (
      (this[position] << 24) |
      (this[position + 1] << 16) |
      (this[position + 2] << 8) |
      this[position + 3]
    );
  }

  readFloatLE(offset) {
    const position = offset === undefined ? 0 : offset;
    checkOffset(this, position, 4);
    return dataView(this).getFloat32(position, true);
  }

  readFloatBE(offset) {
    const position = offset === undefined ? 0 : offset;
    checkOffset(this, position, 4);
    return dataView(this).getFloat32(position, false);
  }

  readDoubleLE(offset) {
    const position = offset === undefined ? 0 : offset;
    checkOffset(this, position, 8);
    return dataView(this).getFloat64(position, true);
  }

  readDoubleBE(offset) {
    const position = offset === undefined ? 0 : offset;
    checkOffset(this, position, 8);
    return dataView(this).getFloat64(position, false);
  }

  readBigUInt64LE(offset) {
    const position = offset === undefined ? 0 : offset;
    checkOffset(this, position, 8);
    return readBigUInt64(this, position, true);
  }

  readBigUInt64BE(offset) {
    const position = offset === undefined ? 0 : offset;
    checkOffset(this, position, 8);
    return readBigUInt64(this, position, false);
  }

  readBigInt64LE(offset) {
    const position = offset === undefined ? 0 : offset;
    checkOffset(this, position, 8);
    return toSigned64(readBigUInt64(this, position, true));
  }

  readBigInt64BE(offset) {
    const position = offset === undefined ? 0 : offset;
    checkOffset(this, position, 8);
    return toSigned64(readBigUInt64(this, position, false));
  }

  // -------------------------------------------------------------------------------------------
  // Numeric writes
  // -------------------------------------------------------------------------------------------

  writeUInt8(value, offset) {
    const position = offset === undefined ? 0 : offset;
    checkInteger(value, "value", 0, 255);
    checkOffset(this, position, 1);
    this[position] = value;
    return position + 1;
  }

  writeInt8(value, offset) {
    const position = offset === undefined ? 0 : offset;
    checkInteger(value, "value", -128, 127);
    checkOffset(this, position, 1);
    this[position] = value & 0xff;
    return position + 1;
  }

  writeUInt16LE(value, offset) {
    const position = offset === undefined ? 0 : offset;
    checkInteger(value, "value", 0, 0xffff);
    checkOffset(this, position, 2);
    this[position] = value & 0xff;
    this[position + 1] = (value >>> 8) & 0xff;
    return position + 2;
  }

  writeUInt16BE(value, offset) {
    const position = offset === undefined ? 0 : offset;
    checkInteger(value, "value", 0, 0xffff);
    checkOffset(this, position, 2);
    this[position] = (value >>> 8) & 0xff;
    this[position + 1] = value & 0xff;
    return position + 2;
  }

  writeInt16LE(value, offset) {
    const position = offset === undefined ? 0 : offset;
    checkInteger(value, "value", -0x8000, 0x7fff);
    checkOffset(this, position, 2);
    const unsigned = value & 0xffff;
    this[position] = unsigned & 0xff;
    this[position + 1] = (unsigned >>> 8) & 0xff;
    return position + 2;
  }

  writeInt16BE(value, offset) {
    const position = offset === undefined ? 0 : offset;
    checkInteger(value, "value", -0x8000, 0x7fff);
    checkOffset(this, position, 2);
    const unsigned = value & 0xffff;
    this[position] = (unsigned >>> 8) & 0xff;
    this[position + 1] = unsigned & 0xff;
    return position + 2;
  }

  writeUInt32LE(value, offset) {
    const position = offset === undefined ? 0 : offset;
    checkInteger(value, "value", 0, TWO_POW_32 - 1);
    checkOffset(this, position, 4);
    this[position] = value & 0xff;
    this[position + 1] = (value >>> 8) & 0xff;
    this[position + 2] = (value >>> 16) & 0xff;
    this[position + 3] = (value >>> 24) & 0xff;
    return position + 4;
  }

  writeUInt32BE(value, offset) {
    const position = offset === undefined ? 0 : offset;
    checkInteger(value, "value", 0, TWO_POW_32 - 1);
    checkOffset(this, position, 4);
    this[position] = (value >>> 24) & 0xff;
    this[position + 1] = (value >>> 16) & 0xff;
    this[position + 2] = (value >>> 8) & 0xff;
    this[position + 3] = value & 0xff;
    return position + 4;
  }

  writeInt32LE(value, offset) {
    const position = offset === undefined ? 0 : offset;
    checkInteger(value, "value", -0x80000000, 0x7fffffff);
    checkOffset(this, position, 4);
    const unsigned = value >>> 0;
    this[position] = unsigned & 0xff;
    this[position + 1] = (unsigned >>> 8) & 0xff;
    this[position + 2] = (unsigned >>> 16) & 0xff;
    this[position + 3] = (unsigned >>> 24) & 0xff;
    return position + 4;
  }

  writeInt32BE(value, offset) {
    const position = offset === undefined ? 0 : offset;
    checkInteger(value, "value", -0x80000000, 0x7fffffff);
    checkOffset(this, position, 4);
    const unsigned = value >>> 0;
    this[position] = (unsigned >>> 24) & 0xff;
    this[position + 1] = (unsigned >>> 16) & 0xff;
    this[position + 2] = (unsigned >>> 8) & 0xff;
    this[position + 3] = unsigned & 0xff;
    return position + 4;
  }

  writeFloatLE(value, offset) {
    const position = offset === undefined ? 0 : offset;
    checkOffset(this, position, 4);
    checkNumber(value, "value");
    dataView(this).setFloat32(position, value, true);
    return position + 4;
  }

  writeFloatBE(value, offset) {
    const position = offset === undefined ? 0 : offset;
    checkOffset(this, position, 4);
    checkNumber(value, "value");
    dataView(this).setFloat32(position, value, false);
    return position + 4;
  }

  writeDoubleLE(value, offset) {
    const position = offset === undefined ? 0 : offset;
    checkOffset(this, position, 8);
    checkNumber(value, "value");
    dataView(this).setFloat64(position, value, true);
    return position + 8;
  }

  writeDoubleBE(value, offset) {
    const position = offset === undefined ? 0 : offset;
    checkOffset(this, position, 8);
    checkNumber(value, "value");
    dataView(this).setFloat64(position, value, false);
    return position + 8;
  }

  writeBigUInt64LE(value, offset) {
    const position = offset === undefined ? 0 : offset;
    checkBigIntRange(value, 0n, TWO_POW_64 - 1n, ">= 0n and < 2n ** 64n");
    checkOffset(this, position, 8);
    requireBigInt(value);
    writeBigUInt64(this, position, value, true);
    return position + 8;
  }

  writeBigUInt64BE(value, offset) {
    const position = offset === undefined ? 0 : offset;
    checkBigIntRange(value, 0n, TWO_POW_64 - 1n, ">= 0n and < 2n ** 64n");
    checkOffset(this, position, 8);
    requireBigInt(value);
    writeBigUInt64(this, position, value, false);
    return position + 8;
  }

  writeBigInt64LE(value, offset) {
    const position = offset === undefined ? 0 : offset;
    checkBigIntRange(value, -TWO_POW_63, TWO_POW_63 - 1n, ">= -(2n ** 63n) and < 2n ** 63n");
    checkOffset(this, position, 8);
    requireBigInt(value);
    writeBigUInt64(this, position, value < 0n ? value + TWO_POW_64 : value, true);
    return position + 8;
  }

  writeBigInt64BE(value, offset) {
    const position = offset === undefined ? 0 : offset;
    checkBigIntRange(value, -TWO_POW_63, TWO_POW_63 - 1n, ">= -(2n ** 63n) and < 2n ** 63n");
    checkOffset(this, position, 8);
    requireBigInt(value);
    writeBigUInt64(this, position, value < 0n ? value + TWO_POW_64 : value, false);
    return position + 8;
  }

  // -------------------------------------------------------------------------------------------
  // Byte swapping
  // -------------------------------------------------------------------------------------------

  swap16() {
    if (this.length % 2 !== 0) throw invalidBufferSize(16);
    for (let i = 0; i < this.length; i += 2) {
      const first = this[i];
      this[i] = this[i + 1];
      this[i + 1] = first;
    }
    return this;
  }

  swap32() {
    if (this.length % 4 !== 0) throw invalidBufferSize(32);
    for (let i = 0; i < this.length; i += 4) {
      let a = this[i];
      let b = this[i + 1];
      this[i] = this[i + 3];
      this[i + 1] = this[i + 2];
      this[i + 2] = b;
      this[i + 3] = a;
    }
    return this;
  }

  swap64() {
    if (this.length % 8 !== 0) throw invalidBufferSize(64);
    for (let i = 0; i < this.length; i += 8) {
      const a = this[i];
      const b = this[i + 1];
      const c = this[i + 2];
      const d = this[i + 3];
      this[i] = this[i + 7];
      this[i + 1] = this[i + 6];
      this[i + 2] = this[i + 5];
      this[i + 3] = this[i + 4];
      this[i + 4] = d;
      this[i + 5] = c;
      this[i + 6] = b;
      this[i + 7] = a;
    }
    return this;
  }
}

// ---------------------------------------------------------------------------------------------
// Shared helpers used by Buffer methods
// ---------------------------------------------------------------------------------------------

function compareBytes(a, b) {
  return compareRanges(a, 0, a.length, b, 0, b.length);
}

// The host compares two borrowed slices, so a range comparison does not allocate a pair of
// subarray views. Argument validation stays with the callers.
function compareRanges(a, aStart, aEnd, b, bStart, bEnd) {
  if (hostBuffer !== undefined) return hostBuffer.compare(a, aStart, aEnd, b, bStart, bEnd);
  const left = a.subarray(aStart, aEnd);
  const right = b.subarray(bStart, bEnd);
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  if (left.length === right.length) return 0;
  return left.length < right.length ? -1 : 1;
}

function writeString(buffer, string, offset, length, encoding) {
  if (encoding === "utf8") {
    let read = 0;
    let written = 0;
    while (read < string.length) {
      let codePoint = string.charCodeAt(read);
      let units = 1;
      if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
        const next = read + 1 < string.length ? string.charCodeAt(read + 1) : 0;
        if (next >= 0xdc00 && next <= 0xdfff) {
          codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00);
          units = 2;
        } else {
          codePoint = 0xfffd;
        }
      } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
        codePoint = 0xfffd;
      }

      const needed =
        codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
      if (written + needed > length) break;

      if (codePoint < 0x80) {
        buffer[offset + written] = codePoint;
      } else if (codePoint < 0x800) {
        buffer[offset + written] = 0xc0 | (codePoint >> 6);
        buffer[offset + written + 1] = 0x80 | (codePoint & 0x3f);
      } else if (codePoint < 0x10000) {
        buffer[offset + written] = 0xe0 | (codePoint >> 12);
        buffer[offset + written + 1] = 0x80 | ((codePoint >> 6) & 0x3f);
        buffer[offset + written + 2] = 0x80 | (codePoint & 0x3f);
      } else {
        buffer[offset + written] = 0xf0 | (codePoint >> 18);
        buffer[offset + written + 1] = 0x80 | ((codePoint >> 12) & 0x3f);
        buffer[offset + written + 2] = 0x80 | ((codePoint >> 6) & 0x3f);
        buffer[offset + written + 3] = 0x80 | (codePoint & 0x3f);
      }
      written += needed;
      read += units;
    }
    return written;
  }

  if (encoding === "utf16le") {
    const codeUnits = Math.min(length >>> 1, string.length);
    for (let i = 0; i < codeUnits; i++) {
      const code = string.charCodeAt(i);
      buffer[offset + i * 2] = code & 0xff;
      buffer[offset + i * 2 + 1] = code >> 8;
    }
    return codeUnits * 2;
  }

  if (encoding === "latin1" || encoding === "ascii") {
    const mask = 0xff;
    const count = Math.min(length, string.length);
    for (let i = 0; i < count; i++) buffer[offset + i] = string.charCodeAt(i) & mask;
    return count;
  }

  const decoded = encodeString(string, encoding);
  const count = Math.min(length, decoded.length);
  buffer.set(decoded.subarray(0, count), offset);
  return count;
}

function dataView(buffer) {
  return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function readBigUInt64(buffer, offset, littleEndian) {
  let value = 0n;
  if (littleEndian) {
    for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(buffer[offset + i]);
  } else {
    for (let i = 0; i < 8; i++) value = (value << 8n) | BigInt(buffer[offset + i]);
  }
  return value;
}

function writeBigUInt64(buffer, offset, value, littleEndian) {
  if (littleEndian) {
    for (let i = 0; i < 8; i++) {
      buffer[offset + i] = Number(value & 0xffn);
      value >>= 8n;
    }
  } else {
    for (let i = 7; i >= 0; i--) {
      buffer[offset + i] = Number(value & 0xffn);
      value >>= 8n;
    }
  }
}

function toSigned64(value) {
  return value >= TWO_POW_63 ? value - TWO_POW_64 : value;
}

function toIndexOffset(byteOffset, length) {
  if (byteOffset === undefined) return 0;
  let offset = Math.trunc(Number(byteOffset));
  if (!Number.isFinite(offset)) offset = 0;
  if (offset < 0) offset = Math.max(length + offset, 0);
  return offset;
}

function toLastIndexOffset(byteOffset, length) {
  if (byteOffset === undefined) return length;
  let offset = Math.trunc(Number(byteOffset));
  if (!Number.isFinite(offset)) return length;
  if (offset < 0) offset = length + offset;
  if (offset > length) offset = length;
  if (offset < 0) offset = 0;
  return offset;
}

function indexOfByte(buffer, value, offset) {
  const start = Math.max(offset, 0);
  if (start >= buffer.length) return -1;
  if (hostBuffer !== undefined) return hostBuffer.indexOf(buffer, value, start);
  for (let i = start; i < buffer.length; i++) {
    if (buffer[i] === value) return i;
  }
  return -1;
}

function indexOfBytes(buffer, needle, offset) {
  const length = buffer.length;
  if (needle.length === 0) return Math.min(Math.max(offset, 0), length);
  if (offset > length - needle.length) return -1;
  const start = Math.max(offset, 0);
  if (hostBuffer !== undefined) return hostBuffer.indexOf(buffer, needle, start);
  outer: for (let i = start; i <= length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (buffer[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function lastIndexOfByte(buffer, value, offset) {
  const start = Math.min(offset, buffer.length - 1);
  if (start < 0) return -1;
  if (hostBuffer !== undefined) return hostBuffer.lastIndexOf(buffer, value, start);
  for (let i = start; i >= 0; i--) {
    if (buffer[i] === value) return i;
  }
  return -1;
}

function lastIndexOfBytes(buffer, needle, offset) {
  const length = buffer.length;
  if (needle.length === 0) return Math.min(Math.max(offset, 0), length);
  let start = Math.min(offset, length - needle.length);
  if (start < 0) return -1;
  if (hostBuffer !== undefined) return hostBuffer.lastIndexOf(buffer, needle, start);
  for (let i = start; i >= 0; i--) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (buffer[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

// Lower-case aliases kept by Node for the `readUint*`/`writeUint*` spellings.
Buffer.prototype.readUint8 = Buffer.prototype.readUInt8;
Buffer.prototype.readUint16LE = Buffer.prototype.readUInt16LE;
Buffer.prototype.readUint16BE = Buffer.prototype.readUInt16BE;
Buffer.prototype.readUint32LE = Buffer.prototype.readUInt32LE;
Buffer.prototype.readUint32BE = Buffer.prototype.readUInt32BE;
Buffer.prototype.writeUint8 = Buffer.prototype.writeUInt8;
Buffer.prototype.writeUint16LE = Buffer.prototype.writeUInt16LE;
Buffer.prototype.writeUint16BE = Buffer.prototype.writeUInt16BE;
Buffer.prototype.writeUint32LE = Buffer.prototype.writeUInt32LE;
Buffer.prototype.writeUint32BE = Buffer.prototype.writeUInt32BE;

// The `buffer` module is commonly loaded as `require("buffer")` and then destructured as
// `{ Buffer }`, but bootstrap may also want the constructor directly. Support both.
Buffer.Buffer = Buffer;
Buffer.kMaxLength = MAX_LENGTH;
Buffer.constants = Object.freeze({ MAX_LENGTH, MAX_STRING_LENGTH: MAX_LENGTH });
Buffer.poolSize = 65536;

module.exports = Buffer;
