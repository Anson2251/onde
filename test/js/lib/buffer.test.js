"use strict";

// Runtime-agnostic self-test for js/lib/buffer.js.
//
// Run under `node` (and `onde`): node test/js/lib/buffer.test.js
// Prints one `ok <label>` line per passing check and exits 1 on any failure.

const Buffer = require("../../../js/lib/buffer.js");

let failures = 0;

function fmt(value) {
  if (value instanceof Uint8Array) return "<" + Array.from(value).join(",") + ">";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

function ok(label) {
  console.log("ok " + label);
}

function fail(label, detail) {
  failures++;
  console.error("not ok " + label + (detail ? " - " + detail : ""));
}

function is(actual, expected, label) {
  if (actual === expected) {
    ok(label);
  } else {
    fail(label, "expected " + fmt(expected) + ", got " + fmt(actual));
  }
}

function bytesOf(buffer) {
  return Array.from(buffer).join(",");
}

function isBytes(buffer, expected, label) {
  const actual = bytesOf(buffer);
  const wanted = expected.join(",");
  if (actual === wanted) {
    ok(label);
  } else {
    fail(label, "expected [" + wanted + "], got [" + actual + "]");
  }
}

function throwsWith(fn, name, code, label) {
  try {
    fn();
    fail(label, "expected a " + name + " to be thrown");
  } catch (err) {
    if (err && err.name === name && err.code === code) {
      ok(label);
    } else {
      fail(
        label,
        "expected " + name + " " + code + ", got " + (err && err.name) + " " + (err && err.code),
      );
    }
  }
}

function throwsMessage(fn, message, label) {
  try {
    fn();
    fail(label, "expected an error to be thrown");
  } catch (err) {
    if (err && err.message === message) {
      ok(label);
    } else {
      fail(label, "expected message " + JSON.stringify(message) + ", got " + JSON.stringify(err && err.message));
    }
  }
}

// -------------------------------------------------------------------------------------------
// Construction and identity
// -------------------------------------------------------------------------------------------

{
  const buffer = Buffer.from([0x61, 0x62, 0x63]);
  is(buffer instanceof Buffer, true, "Buffer.from returns a Buffer");
  is(buffer instanceof Uint8Array, true, "Buffer is a Uint8Array subclass");
  is(Buffer.isBuffer(buffer), true, "Buffer.isBuffer accepts a Buffer");
  is(Buffer.isBuffer(new Uint8Array(1)), false, "Buffer.isBuffer rejects a plain Uint8Array");
  is(Buffer.isBuffer(null), false, "Buffer.isBuffer rejects null");
  is(buffer.constructor, Buffer, "instance constructor is Buffer");
  is(buffer.length, 3, "instance length");

  const copy = new Uint8Array(buffer);
  is(copy.buffer === buffer.buffer, false, "new Uint8Array(buffer) copies");
  isBytes(copy, [0x61, 0x62, 0x63], "new Uint8Array(buffer) preserves bytes");
  is(buffer.buffer instanceof ArrayBuffer, true, "Buffer exposes its ArrayBuffer");
}

// -------------------------------------------------------------------------------------------
// from(string, encoding)
// -------------------------------------------------------------------------------------------

isBytes(Buffer.from("abc"), [0x61, 0x62, 0x63], "from(string) defaults to utf8");
isBytes(Buffer.from("é"), [0xc3, 0xa9], "from(string) utf8 two-byte");
isBytes(Buffer.from("💩"), [0xf0, 0x9f, 0x92, 0xa9], "from(string) utf8 surrogate pair");
isBytes(Buffer.from("\uD800"), [0xef, 0xbf, 0xbd], "from(string) utf8 lone surrogate replacement");
isBytes(Buffer.from("00ff10", "hex"), [0x00, 0xff, 0x10], "from(hex)");
isBytes(Buffer.from("0A0b", "hex"), [0x0a, 0x0b], "from(hex) is case-insensitive");
isBytes(Buffer.from("00zz11", "hex"), [0x00], "from(hex) stops at the first bad pair");
isBytes(Buffer.from("0", "hex"), [], "from(hex) drops an odd trailing nibble");
isBytes(Buffer.from("aGVsbG8=", "base64"), [0x68, 0x65, 0x6c, 0x6c, 0x6f], "from(base64)");
isBytes(Buffer.from("aGVs bG8=", "base64"), [0x68, 0x65, 0x6c, 0x6c, 0x6f], "from(base64) ignores whitespace");
isBytes(Buffer.from("___-", "base64url"), [0xff, 0xff, 0xfe], "from(base64url)");
isBytes(Buffer.from("-_8", "base64url"), [0xfb, 0xff], "from(base64url) round-trip");
isBytes(Buffer.from("\u0080\u00ff", "latin1"), [0x80, 0xff], "from(latin1)");
isBytes(Buffer.from("ab", "binary"), [0x61, 0x62], "from(binary) alias");
isBytes(Buffer.from("é", "ascii"), [0xe9], "from(ascii) truncates to eight bits");
isBytes(Buffer.from("a💩b", "utf16le"), [0x61, 0x00, 0x3d, 0xd8, 0xa9, 0xdc, 0x62, 0x00], "from(utf16le)");
isBytes(Buffer.from("a", "ucs2"), [0x61, 0x00], "from(ucs2) alias");
isBytes(Buffer.from("a", "UCS-2"), [0x61, 0x00], "encoding aliases are case-insensitive");
is(Buffer.from("").length, 0, "from(empty string) has length 0");

throwsWith(
  () => Buffer.from("abc", "bogus"),
  "TypeError",
  "ERR_UNKNOWN_ENCODING",
  "from(string) rejects an unknown encoding",
);

// -------------------------------------------------------------------------------------------
// from(other inputs)
// -------------------------------------------------------------------------------------------

{
  const original = Buffer.from([1, 2, 3]);
  const copy = Buffer.from(original);
  original[0] = 9;
  isBytes(copy, [1, 2, 3], "from(Buffer) copies");
  is(copy === original, false, "from(Buffer) returns a new object");

  const typed = new Uint8Array([4, 5, 6]);
  const fromTyped = Buffer.from(typed);
  typed[0] = 0;
  isBytes(fromTyped, [4, 5, 6], "from(Uint8Array) copies");
}

{
  const arrayBuffer = new ArrayBuffer(6);
  const all = Buffer.from(arrayBuffer);
  const view = Buffer.from(arrayBuffer, 1, 3);
  is(view.length, 3, "from(ArrayBuffer, offset, length) length");
  is(view.buffer, arrayBuffer, "from(ArrayBuffer) shares the ArrayBuffer");
  is(view.byteOffset, 1, "from(ArrayBuffer, offset) byteOffset");
  view[0] = 7;
  is(new Uint8Array(arrayBuffer)[1], 7, "from(ArrayBuffer) view writes through");
  is(all.length, 6, "from(ArrayBuffer) covers the whole buffer");

  throwsWith(
    () => Buffer.from(arrayBuffer, 99),
    "RangeError",
    "ERR_BUFFER_OUT_OF_BOUNDS",
    "from(ArrayBuffer) rejects an out-of-range offset",
  );
  throwsWith(
    () => Buffer.from(arrayBuffer, 2, 99),
    "RangeError",
    "ERR_BUFFER_OUT_OF_BOUNDS",
    "from(ArrayBuffer) rejects an out-of-range length",
  );
  is(Buffer.from(arrayBuffer, 2, -1).length, 0, "from(ArrayBuffer) clamps a negative length to zero");
}

{
  const dataView = new DataView(new Uint8Array([1, 2, 3, 4]).buffer, 1, 2);
  isBytes(Buffer.from(dataView), [2, 3], "from(DataView) copies the viewed bytes");
}

isBytes(Buffer.from([0, 255, 128]), [0, 255, 128], "from(array)");
isBytes(Buffer.from({ length: 2, 0: 7, 1: 8 }), [7, 8], "from(array-like)");
isBytes(Buffer.from(new Set([9, 10])), [9, 10], "from(iterable)");

throwsWith(
  () => Buffer.from([256]),
  "RangeError",
  "ERR_OUT_OF_RANGE",
  "from(array) rejects values above 255",
);
throwsWith(
  () => Buffer.from([-1]),
  "RangeError",
  "ERR_OUT_OF_RANGE",
  "from(array) rejects negative values",
);
throwsWith(
  () => Buffer.from(["1"]),
  "TypeError",
  "ERR_INVALID_ARG_TYPE",
  "from(array) rejects non-number values",
);
throwsWith(
  () => Buffer.from(123),
  "TypeError",
  "ERR_INVALID_ARG_TYPE",
  "from(number) throws",
);
throwsWith(
  () => Buffer.from(null),
  "TypeError",
  "ERR_INVALID_ARG_TYPE",
  "from(null) throws",
);

// -------------------------------------------------------------------------------------------
// alloc / allocUnsafe / concat / byteLength
// -------------------------------------------------------------------------------------------

isBytes(Buffer.alloc(3), [0, 0, 0], "alloc zero-fills");
is(Buffer.alloc(0).length, 0, "alloc(0)");
isBytes(Buffer.alloc(4, 0x61), [0x61, 0x61, 0x61, 0x61], "alloc with a byte fill");
isBytes(Buffer.alloc(5, "ab"), [0x61, 0x62, 0x61, 0x62, 0x61], "alloc with a string fill cycles");
isBytes(Buffer.alloc(4, "ff", "hex"), [0xff, 0xff, 0xff, 0xff], "alloc with a hex fill");
isBytes(Buffer.alloc(3, 0), [0, 0, 0], "alloc with an explicit zero fill");
throwsWith(
  () => Buffer.alloc("3"),
  "TypeError",
  "ERR_INVALID_ARG_TYPE",
  "alloc rejects a non-number size",
);
throwsWith(
  () => Buffer.alloc(-1),
  "RangeError",
  "ERR_OUT_OF_RANGE",
  "alloc rejects a negative size",
);

is(Buffer.allocUnsafe(4).length, 4, "allocUnsafe length");
is(Buffer.allocUnsafeSlow(4).length, 4, "allocUnsafeSlow length");
isBytes(Buffer.allocUnsafe(4), [0, 0, 0, 0], "allocUnsafe is zero-filled in onde (no pool allocator)");

is(Buffer.concat([Buffer.from("ab"), Buffer.from("cd")]).toString(), "abcd", "concat");
is(Buffer.concat([]).length, 0, "concat empty list");
is(
  bytesOf(Buffer.concat([Buffer.from([1, 2])], 4)),
  "1,2,0,0",
  "concat pads to a larger totalLength",
);
is(bytesOf(Buffer.concat([Buffer.from([1, 2])], 1)), "1", "concat truncates to a smaller totalLength");
is(
  Buffer.concat([new Uint8Array([1]), new Uint8Array([2])]).length,
  2,
  "concat accepts plain Uint8Arrays",
);
throwsWith(
  () => Buffer.concat("ab"),
  "TypeError",
  "ERR_INVALID_ARG_TYPE",
  "concat rejects a non-array list",
);
throwsWith(
  () => Buffer.concat([Buffer.from([1]), "x"]),
  "TypeError",
  "ERR_INVALID_ARG_TYPE",
  "concat rejects a non-Buffer item",
);

is(Buffer.byteLength("abc"), 3, "byteLength utf8 ascii");
is(Buffer.byteLength("é"), 2, "byteLength utf8 two-byte");
is(Buffer.byteLength("💩"), 4, "byteLength utf8 surrogate pair");
is(Buffer.byteLength("\uD800"), 3, "byteLength utf8 lone surrogate");
is(Buffer.byteLength("00ff", "hex"), 2, "byteLength hex");
is(Buffer.byteLength("abc", "hex"), 1, "byteLength hex rounds down");
is(Buffer.byteLength("aGVsbG8=", "base64"), 5, "byteLength base64 ignores padding");
is(Buffer.byteLength("abc", "base64"), 2, "byteLength base64");
is(Buffer.byteLength("abc", "utf16le"), 6, "byteLength utf16le");
is(Buffer.byteLength("abc", "latin1"), 3, "byteLength latin1");
is(Buffer.byteLength("abc", "ascii"), 3, "byteLength ascii");
is(Buffer.byteLength(Buffer.from("abc")), 3, "byteLength accepts a Buffer");
is(Buffer.byteLength(new Uint8Array(2)), 2, "byteLength accepts a typed array");
throwsWith(
  () => Buffer.byteLength("abc", "bogus"),
  "TypeError",
  "ERR_UNKNOWN_ENCODING",
  "byteLength rejects an unknown encoding",
);

is(Buffer.isEncoding("utf8"), true, "isEncoding utf8");
is(Buffer.isEncoding("UTF-8"), true, "isEncoding is case-insensitive");
is(Buffer.isEncoding("base64url"), true, "isEncoding base64url");
is(Buffer.isEncoding("ucs2"), true, "isEncoding ucs2");
is(Buffer.isEncoding("bogus"), false, "isEncoding rejects an unknown encoding");
is(Buffer.isEncoding(123), false, "isEncoding rejects a non-string");
is(typeof Buffer.poolSize, "number", "poolSize is a number");

// -------------------------------------------------------------------------------------------
// toString / toJSON / inspect
// -------------------------------------------------------------------------------------------

{
  const buffer = Buffer.from("héllo");
  is(buffer.toString(), "héllo", "toString defaults to utf8");
  is(buffer.toString("utf8"), "héllo", "toString(utf8)");
  is(Buffer.from([0x41, 0x80, 0xff]).toString("latin1"), "A\u0080\u00ff", "toString(latin1)");
  is(Buffer.from([0x41, 0x80, 0xff]).toString("binary"), "A\u0080\u00ff", "toString(binary)");
  is(Buffer.from([0x41, 0x80]).toString("ascii"), "A\u0000", "toString(ascii) masks 0x7F");
  is(Buffer.from([0x61, 0x62]).toString("hex"), "6162", "toString(hex)");
  is(Buffer.from([0xfb, 0xff]).toString("base64"), "+/8=", "toString(base64) pads");
  is(Buffer.from([0xfb, 0xff]).toString("base64url"), "-_8", "toString(base64url) does not pad");
  is(Buffer.from("a💩b", "utf16le").toString("utf16le"), "a💩b", "toString(utf16le) round-trip");
  is(Buffer.from("a", "ucs2").toString("ucs2"), "a", "toString(ucs2) alias");
  is(Buffer.from([0x41, 0x42]).toString("hex", 1, 2), "42", "toString(hex, start, end)");
  is(Buffer.from("abcdef").toString("utf8", 1, 3), "bc", "toString(utf8, start, end)");
  is(Buffer.from("abcdef").toString("utf8", -3), "abcdef", "toString clamps a negative start to 0");
  is(Buffer.from("abcdef").toString("utf8", 0, -1), "", "toString clamps a negative end to 0");
  is(Buffer.from("abcdef").toString("utf8", 4, 2), "", "toString with end before start");
  is(Buffer.from("abcdef").toString("utf8", 100), "", "toString with start past the end");
  is(Buffer.from([0x41]).toString("base64", 8, 9), "", "toString slice outside the buffer");
  throwsWith(
    () => Buffer.from("abc").toString("bogus"),
    "TypeError",
    "ERR_UNKNOWN_ENCODING",
    "toString rejects an unknown encoding",
  );
}

{
  const json = Buffer.from([1, 2]).toJSON();
  is(json.type, "Buffer", "toJSON type");
  is(JSON.stringify(json.data), "[1,2]", "toJSON data");
}

is(Buffer.from([0x61, 0x62]).inspect(), "<Buffer 61 62>", "inspect hex pair format");
is(Buffer.alloc(0).inspect(), "<Buffer >", "inspect empty buffer");
is(
  Buffer.alloc(60).inspect(),
  "<Buffer " + Array(50).fill("00").join(" ") + " ... 10 more bytes>",
  "inspect truncates after 50 bytes",
);
is(Buffer.alloc(51).inspect().endsWith("... 1 more byte>"), true, "inspect singular trailing byte");

// -------------------------------------------------------------------------------------------
// equals / compare / copy
// -------------------------------------------------------------------------------------------

is(Buffer.from("abc").equals(Buffer.from("abc")), true, "equals identical");
is(Buffer.from("abc").equals(Buffer.from("abd")), false, "equals different content");
is(Buffer.from("abc").equals(Buffer.from("ab")), false, "equals different length");
throwsWith(
  () => Buffer.from("abc").equals("abc"),
  "TypeError",
  "ERR_INVALID_ARG_TYPE",
  "equals rejects a string",
);

is(Buffer.compare(Buffer.from("a"), Buffer.from("b")), -1, "Buffer.compare less");
is(Buffer.compare(Buffer.from("b"), Buffer.from("a")), 1, "Buffer.compare greater");
is(Buffer.compare(Buffer.from("a"), Buffer.from("a")), 0, "Buffer.compare equal");
is(Buffer.compare(Buffer.from("ab"), Buffer.from("a")), 1, "Buffer.compare longer prefix");
is(Buffer.from("abc").compare(Buffer.from("abd")), -1, "instance compare");
is(
  Buffer.from("abc").compare(Buffer.from("abd"), 0, 2, 0, 2),
  0,
  "instance compare with equal ranges",
);

{
  const target = Buffer.alloc(5);
  const copied = Buffer.from("abc").copy(target, 2, 1, 3);
  is(copied, 2, "copy returns the number of bytes copied");
  isBytes(target, [0, 0, 0x62, 0x63, 0], "copy places bytes at targetStart");
  is(Buffer.from("abc").copy(Buffer.alloc(2), 5), 0, "copy past the target writes nothing");
  is(Buffer.from("abc").copy(Buffer.alloc(5), 0, 2, 2), 0, "copy empty source range");
  throwsWith(
    () => Buffer.from("abc").copy("nope"),
    "TypeError",
    "ERR_INVALID_ARG_TYPE",
    "copy rejects a non-Uint8Array target",
  );
}

// -------------------------------------------------------------------------------------------
// fill
// -------------------------------------------------------------------------------------------

{
  const buffer = Buffer.alloc(6);
  is(buffer.fill(0x61), buffer, "fill returns this");
  isBytes(buffer, [0x61, 0x61, 0x61, 0x61, 0x61, 0x61], "fill with a number");
  buffer.fill("ab", 1, 4);
  isBytes(buffer, [0x61, 0x61, 0x62, 0x61, 0x61, 0x61], "fill with a string cycle");

  const pattern = Buffer.alloc(5);
  pattern.fill(Buffer.from([1, 2, 3]));
  isBytes(pattern, [1, 2, 3, 1, 2], "fill with a Buffer pattern cycles");

  const zeros = Buffer.alloc(3, 0xaa);
  zeros.fill("");
  isBytes(zeros, [0, 0, 0], "fill with an empty string writes zeroes");

  isBytes(Buffer.alloc(2).fill(-1), [0xff, 0xff], "fill masks a negative number");
  isBytes(Buffer.alloc(2).fill(256), [0, 0], "fill masks 256");
  isBytes(Buffer.alloc(2).fill(1.9), [1, 1], "fill truncates a fractional number");
  isBytes(Buffer.alloc(2).fill(null), [0, 0], "fill coerces null to zero");
  isBytes(Buffer.alloc(2).fill(true), [1, 1], "fill coerces true to one");
  throwsWith(
    () => Buffer.alloc(4).fill(0x61, -2),
    "RangeError",
    "ERR_OUT_OF_RANGE",
    "fill rejects a negative offset",
  );

  throwsWith(
    () => Buffer.alloc(2).fill(Buffer.alloc(0)),
    "TypeError",
    "ERR_INVALID_ARG_VALUE",
    "fill rejects an empty Buffer pattern",
  );
  throwsWith(
    () => Buffer.alloc(2).fill(1, 0, 9),
    "RangeError",
    "ERR_OUT_OF_RANGE",
    "fill rejects an out-of-range end",
  );
}

// -------------------------------------------------------------------------------------------
// write
// -------------------------------------------------------------------------------------------

{
  const buffer = Buffer.alloc(6);
  is(buffer.write("abc"), 3, "write returns the byte count");
  is(buffer.toString(), "abc\u0000\u0000\u0000", "write at offset 0");

  const offset = Buffer.alloc(4);
  is(offset.write("ab", 1), 2, "write with an offset");
  isBytes(offset, [0, 0x61, 0x62, 0], "write places bytes at the offset");

  const partial = Buffer.alloc(1);
  is(partial.write("💩"), 0, "write never writes a partial UTF-8 code point");
  isBytes(partial, [0], "write leaves the buffer untouched when no code point fits");

  const partial2 = Buffer.alloc(3);
  is(partial2.write("💩"), 0, "write refuses a four-byte code point in three bytes");
  is(Buffer.alloc(4).write("💩"), 4, "write accepts a four-byte code point in four bytes");

  is(Buffer.alloc(2).write("616263", "hex"), 2, "write supports the legacy encoding argument");
  is(
    Buffer.alloc(3).write("abc", 0, 3, "utf8"),
    3,
    "write accepts offset, length and encoding",
  );
  is(Buffer.alloc(2).write("abc", 0, 1), 1, "write truncates to the requested length");
  throwsWith(
    () => Buffer.alloc(2).write("abc", 3),
    "RangeError",
    "ERR_OUT_OF_RANGE",
    "write rejects an out-of-range offset",
  );
  throwsWith(
    () => Buffer.alloc(2).write("abc", 0, 5),
    "RangeError",
    "ERR_OUT_OF_RANGE",
    "write rejects an out-of-range length",
  );
  throwsWith(
    () => Buffer.alloc(2).write("abc", 0, 1, "bogus"),
    "TypeError",
    "ERR_UNKNOWN_ENCODING",
    "write rejects an unknown encoding",
  );
}

// -------------------------------------------------------------------------------------------
// slice / subarray
// -------------------------------------------------------------------------------------------

{
  const buffer = Buffer.from([1, 2, 3, 4]);
  const sliced = buffer.slice(1, 3);
  isBytes(sliced, [2, 3], "slice contents");
  is(sliced.buffer, buffer.buffer, "slice is a view over the same ArrayBuffer");
  sliced[0] = 9;
  is(buffer[1], 9, "writing through a slice affects the original");
  isBytes(buffer.slice(-2), [3, 4], "slice with a negative start");
  is(buffer.slice(3, 1).length, 0, "slice with end before start");
  is(buffer.subarray(1, 3).buffer, buffer.buffer, "subarray is a view");
  is(sliced.constructor, Buffer, "slice returns a Buffer");
}

// -------------------------------------------------------------------------------------------
// indexOf / lastIndexOf / includes
// -------------------------------------------------------------------------------------------

{
  const buffer = Buffer.from("abcdef");
  is(buffer.indexOf("cd"), 2, "indexOf string");
  is(buffer.indexOf("cd", 3), -1, "indexOf string with offset");
  is(buffer.indexOf(Buffer.from("cd")), 2, "indexOf Buffer");
  is(buffer.indexOf(0x63), 2, "indexOf number");
  is(buffer.indexOf(0x163), 2, "indexOf masks a number to one byte");
  is(buffer.indexOf(""), 0, "indexOf empty string");
  is(buffer.indexOf("", 10), 6, "indexOf empty string clamps the offset");
  is(buffer.indexOf("", -10), 0, "indexOf empty string clamps a negative offset");
  is(buffer.indexOf("cd", -4), 2, "indexOf resolves a negative offset from the end");
  is(buffer.includes("bc"), true, "includes string");
  is(buffer.includes("bc", 3), false, "includes with offset");
  is(buffer.includes(0x61), true, "includes number");

  is(buffer.lastIndexOf("a"), 0, "lastIndexOf finds the only match");
  is(buffer.lastIndexOf("a", -1), 0, "lastIndexOf with a negative offset");
  is(buffer.lastIndexOf("a", 0), 0, "lastIndexOf at offset 0");
  is(buffer.lastIndexOf(""), 6, "lastIndexOf empty string");
  is(buffer.lastIndexOf("", 2), 2, "lastIndexOf empty string at an offset");
  is(Buffer.from("abcabc").lastIndexOf("ab", 4), 3, "lastIndexOf searches backwards");
  is(buffer.lastIndexOf(0x61), 0, "lastIndexOf number");
}

// -------------------------------------------------------------------------------------------
// Numeric reads and writes
// -------------------------------------------------------------------------------------------

{
  const buffer = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
  is(buffer.readUInt8(0), 1, "readUInt8");
  is(buffer.readInt8(0), 1, "readInt8");
  is(buffer.readUInt16LE(0), 0x0201, "readUInt16LE");
  is(buffer.readUInt16BE(0), 0x0102, "readUInt16BE");
  is(buffer.readUInt32LE(0), 0x04030201, "readUInt32LE");
  is(buffer.readUInt32BE(0), 0x01020304, "readUInt32BE");
  is(buffer.readUInt16LE(6), 0x0807, "readUInt16LE at an offset");
  is(buffer.readUInt32BE(4), 0x05060708, "readUInt32BE at an offset");
  is(buffer.readBigUInt64LE(0), 0x0807060504030201n, "readBigUInt64LE");
  is(buffer.readBigUInt64BE(0), 0x0102030405060708n, "readBigUInt64BE");
  is(buffer.readBigInt64LE(0), 0x0807060504030201n, "readBigInt64LE positive");

  const signed = Buffer.from([0xff, 0xff, 0xff, 0xff]);
  is(signed.readInt8(0), -1, "readInt8 negative");
  is(signed.readInt16LE(0), -1, "readInt16LE negative");
  is(signed.readInt16BE(0), -1, "readInt16BE negative");
  is(signed.readInt32LE(0), -1, "readInt32LE negative");
  is(signed.readInt32BE(0), -1, "readInt32BE negative");
  is(signed.readUInt32LE(0), 0xffffffff, "readUInt32LE unsigned");
  const signed64 = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  is(signed64.readBigInt64LE(0), -1n, "readBigInt64LE negative");
  is(signed64.readBigUInt64LE(0), 0xffffffffffffffffn, "readBigUInt64LE unsigned");

  is(Buffer.from([0x00, 0x00, 0x80, 0x3f]).readFloatLE(0), 1, "readFloatLE");
  is(Buffer.from([0x3f, 0x80, 0x00, 0x00]).readFloatBE(0), 1, "readFloatBE");
  is(Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f]).readDoubleLE(0), 1, "readDoubleLE");
  is(Buffer.from([0x3f, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]).readDoubleBE(0), 1, "readDoubleBE");

  throwsMessage(
    () => buffer.readUInt8(8),
    'The value of "offset" is out of range. It must be >= 0 and <= 7. Received 8',
    "readUInt8 out-of-range message",
  );
  throwsWith(
    () => buffer.readUInt8(8),
    "RangeError",
    "ERR_OUT_OF_RANGE",
    "readUInt8 out-of-range code",
  );
  throwsWith(
    () => buffer.readUInt8(1.5),
    "RangeError",
    "ERR_OUT_OF_RANGE",
    "readUInt8 rejects a fractional offset",
  );
  throwsWith(
    () => buffer.readUInt16LE(7),
    "RangeError",
    "ERR_OUT_OF_RANGE",
    "readUInt16LE out-of-range code",
  );
  throwsWith(
    () => Buffer.alloc(0).readUInt8(0),
    "RangeError",
    "ERR_BUFFER_OUT_OF_BOUNDS",
    "readUInt8 on an empty buffer",
  );
}

{
  const buffer = Buffer.alloc(8);
  is(buffer.writeUInt8(0xff, 0), 1, "writeUInt8 returns offset + 1");
  is(buffer.writeInt8(-1, 1), 2, "writeInt8 returns offset + 1");
  is(buffer.writeUInt16LE(0x0102, 2), 4, "writeUInt16LE returns offset + 2");
  is(buffer.writeUInt16BE(0x0304, 4), 6, "writeUInt16BE returns offset + 2");
  is(buffer.writeUInt32LE(0xdeadbeef, 0), 4, "writeUInt32LE returns offset + 4");
  is(buffer.toString("hex"), "efbeadde03040000", "numeric writes lay out bytes");
  is(buffer.readUInt32LE(0), 0xdeadbeef, "numeric write/read round-trip");

  const big = Buffer.alloc(8);
  is(big.writeBigUInt64LE(0x0102030405060708n, 0), 8, "writeBigUInt64LE returns offset + 8");
  is(big.toString("hex"), "0807060504030201", "writeBigUInt64LE bytes");
  is(big.readBigUInt64LE(0), 0x0102030405060708n, "writeBigUInt64LE round-trip");
  is(big.writeBigInt64LE(-2n, 0), 8, "writeBigInt64LE returns offset + 8");
  is(big.readBigInt64LE(0), -2n, "writeBigInt64LE round-trip");
  is(big.writeBigUInt64BE(0x0102030405060708n, 0), 8, "writeBigUInt64BE");
  is(big.toString("hex"), "0102030405060708", "writeBigUInt64BE bytes");

  const floats = Buffer.alloc(8);
  is(floats.writeFloatLE(1.5, 0), 4, "writeFloatLE returns offset + 4");
  is(floats.readFloatLE(0), 1.5, "writeFloatLE round-trip");
  is(floats.writeDoubleBE(2.5, 0), 8, "writeDoubleBE returns offset + 8");
  is(floats.readDoubleBE(0), 2.5, "writeDoubleBE round-trip");

  throwsWith(
    () => Buffer.alloc(2).writeUInt8(256, 0),
    "RangeError",
    "ERR_OUT_OF_RANGE",
    "writeUInt8 rejects a value above 255",
  );
  throwsWith(
    () => Buffer.alloc(2).writeUInt8(-1, 0),
    "RangeError",
    "ERR_OUT_OF_RANGE",
    "writeUInt8 rejects a negative value",
  );
  throwsWith(
    () => Buffer.alloc(2).writeInt8(128, 0),
    "RangeError",
    "ERR_OUT_OF_RANGE",
    "writeInt8 rejects a value above 127",
  );
  throwsWith(
    () => Buffer.alloc(2).writeUInt16LE(0x10000, 0),
    "RangeError",
    "ERR_OUT_OF_RANGE",
    "writeUInt16LE rejects a value above 65535",
  );
  throwsWith(
    () => Buffer.alloc(2).writeUInt16LE(1, 1),
    "RangeError",
    "ERR_OUT_OF_RANGE",
    "writeUInt16LE rejects an offset that does not fit",
  );
  throwsWith(
    () => Buffer.alloc(8).writeBigUInt64LE(-1n, 0),
    "RangeError",
    "ERR_OUT_OF_RANGE",
    "writeBigUInt64LE rejects a negative BigInt",
  );
  throwsWith(
    () => Buffer.alloc(8).writeBigUInt64LE(1, 0),
    "TypeError",
    undefined,
    "writeBigUInt64LE rejects a Number",
  );
}

// -------------------------------------------------------------------------------------------
// swap
// -------------------------------------------------------------------------------------------

{
  const buffer = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  is(buffer.swap16(), buffer, "swap16 returns this");
  isBytes(buffer, [0x02, 0x01, 0x04, 0x03], "swap16 swaps pairs");

  const buffer32 = Buffer.from([1, 2, 3, 4]);
  is(buffer32.swap32(), buffer32, "swap32 returns this");
  isBytes(buffer32, [4, 3, 2, 1], "swap32 reverses groups of four");

  const buffer64 = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  is(buffer64.swap64(), buffer64, "swap64 returns this");
  isBytes(buffer64, [8, 7, 6, 5, 4, 3, 2, 1], "swap64 reverses groups of eight");

  throwsWith(
    () => Buffer.alloc(3).swap16(),
    "RangeError",
    "ERR_INVALID_BUFFER_SIZE",
    "swap16 validates the buffer length",
  );
  throwsWith(
    () => Buffer.alloc(3).swap32(),
    "RangeError",
    "ERR_INVALID_BUFFER_SIZE",
    "swap32 validates the buffer length",
  );
  throwsWith(
    () => Buffer.alloc(7).swap64(),
    "RangeError",
    "ERR_INVALID_BUFFER_SIZE",
    "swap64 validates the buffer length",
  );
}

// -------------------------------------------------------------------------------------------
// Iteration
// -------------------------------------------------------------------------------------------

{
  const buffer = Buffer.from([10, 20]);
  is(JSON.stringify(Array.from(buffer.keys())), "[0,1]", "keys()");
  is(JSON.stringify(Array.from(buffer.values())), "[10,20]", "values()");
  is(JSON.stringify(Array.from(buffer.entries())), "[[0,10],[1,20]]", "entries()");
  is(JSON.stringify(Array.from(buffer)), "[10,20]", "Symbol.iterator");
}

// -------------------------------------------------------------------------------------------

if (failures > 0) {
  console.error("# buffer: " + failures + " failure(s)");
  process.exit(1);
}
console.log("# buffer: all checks passed");
