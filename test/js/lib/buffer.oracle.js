"use strict";

// Node-only differential test: compares js/lib/buffer.js and js/lib/string_decoder.js against
// Node's own implementations.
//
//   node test/js/lib/buffer.oracle.js
//
// Every mismatch is printed with the input bytes. The process exits non-zero if anything
// differs. Known, deliberate divergences (docs/compat.md D7 and the js/README rules) are not
// exercised here: `allocUnsafe` contents, `Buffer.from(array)` validation, iterable inputs and
// `Buffer.from(DataView)`.

const assert = require("node:assert");
const { Buffer: NodeBuffer } = require("node:buffer");
const { StringDecoder: NodeStringDecoder } = require("node:string_decoder");

const Buffer = require("../../../js/lib/buffer.js");
const { StringDecoder } = require("../../../js/lib/string_decoder.js");

let checks = 0;
const failures = [];

function hex(bytes) {
  if (bytes === undefined || bytes === null) return "<none>";
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(view)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function mismatch(label, inputBytes, ours, nodeValue) {
  const message =
    "MISMATCH " + label + "\n  input: " + hex(inputBytes) + "\n  ours:  " + ours + "\n  node:  " + nodeValue;
  failures.push(message);
  console.error(message);
}

function check(label, inputBytes, actual, expected) {
  checks++;
  try {
    assert.strictEqual(actual, expected);
  } catch (_) {
    mismatch(label, inputBytes, actual, expected);
  }
}

function outcome(fn, render) {
  try {
    return "OK:" + render(fn());
  } catch (err) {
    return "ERR:" + (err && err.name) + ":" + (err && err.code);
  }
}

function renderValue(value) {
  if (typeof value === "bigint") return value + "n";
  if (typeof value === "number" && Object.is(value, -0)) return "-0";
  return String(value);
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(0x5eedc0de);

function randomBytes(length) {
  const bytes = [];
  for (let i = 0; i < length; i++) bytes.push(Math.floor(random() * 256));
  return bytes;
}

function randomInt(max) {
  return Math.floor(random() * max);
}

// ---------------------------------------------------------------------------------------------
// 1. Strings to bytes, byte length and back again
// ---------------------------------------------------------------------------------------------

const ENCODINGS = ["utf8", "utf-8", "hex", "base64", "base64url", "latin1", "binary", "ascii", "utf16le", "ucs2"];
const STRINGS = [
  "",
  "a",
  "abc",
  "hello world",
  "é",
  "€",
  "💩",
  "a💩b",
  "日本語",
  "\u0000\u00ff",
  "ÿ",
  "\uD800",
  "\uDC00",
  "a\uD800b",
  "aGVsbG8=",
  "deadbeef",
  "00ff",
  "Zg==",
  "____",
  "a-b_",
  "0A0b",
  "0",
  "šŢ",
];

for (const string of STRINGS) {
  for (const encoding of ENCODINGS) {
    const inputBytes = Array.from(string).map((ch) => ch.codePointAt(0));
    check(
      "Buffer.from(" + JSON.stringify(string) + ", " + encoding + ")",
      inputBytes,
      hex(Buffer.from(string, encoding)),
      hex(NodeBuffer.from(string, encoding)),
    );
    check(
      "Buffer.byteLength(" + JSON.stringify(string) + ", " + encoding + ")",
      inputBytes,
      Buffer.byteLength(string, encoding),
      NodeBuffer.byteLength(string, encoding),
    );
  }

  // Round-trip through each text encoding.
  for (const encoding of ["utf8", "latin1", "ascii", "utf16le"]) {
    const inputBytes = Array.from(string).map((ch) => ch.codePointAt(0));
    const ours = Buffer.from(string, encoding);
    const node = NodeBuffer.from(string, encoding);
    check(
      "round-trip " + JSON.stringify(string) + " via " + encoding,
      inputBytes,
      ours.toString(encoding),
      node.toString(encoding),
    );
  }
}

// ---------------------------------------------------------------------------------------------
// 2. Base64 and hex edge cases
// ---------------------------------------------------------------------------------------------

const BASE64_EDGE_CASES = [
  "",
  "Zg==",
  "Zg",
  "Zm9v",
  "Zm9vYg==",
  "Zm9vYmE=",
  "aGVs bG8=",
  "aGVs\nbG8=",
  "!!!!",
  "aGVsbG8",
  "aGVsbG8=",
  "aGVsbG8==",
  "///+",
  "____",
  "AA==AA==",
  "a-b_",
  "a+b/",
  "Zg==Zg==",
  "AB==",
  "A===",
  "A",
  "AA",
  "AAA",
  "AAAAA",
  "Zg!Zg",
  "Zg=Zg",
  "Z=g",
  "=Zg",
  " Zg ",
  "Zg\t",
  "Zg\r\n",
  "Zm9v=",
  "Zm9v==",
  "Zm9v===",
  "Zm9vYg",
  "QUJD",
  "QUéJD",
  "QU💩JD",
  "a💩b",
  "\u013DQUJD",
  "01",
  "0a0B",
];

for (const string of BASE64_EDGE_CASES) {
  const inputBytes = Array.from(string).map((ch) => ch.codePointAt(0));
  check(
    "base64 decode " + JSON.stringify(string),
    inputBytes,
    hex(Buffer.from(string, "base64")),
    hex(NodeBuffer.from(string, "base64")),
  );
  check(
    "base64url decode " + JSON.stringify(string),
    inputBytes,
    hex(Buffer.from(string, "base64url")),
    hex(NodeBuffer.from(string, "base64url")),
  );
  check(
    "base64 byteLength " + JSON.stringify(string),
    inputBytes,
    Buffer.byteLength(string, "base64"),
    NodeBuffer.byteLength(string, "base64"),
  );
}

const HEX_EDGE_CASES = [
  "",
  "00",
  "0",
  "0g",
  "zz",
  "00zz11",
  "0a0B",
  " 00",
  "00 11",
  "0x11",
  "šŢ",
  "ıĲ",
  "💩",
  "\u0100a",
  "0\u0161",
  "0123456789abcdefABCDEF",
];
for (const string of HEX_EDGE_CASES) {
  const inputBytes = Array.from(string).map((ch) => ch.codePointAt(0));
  check(
    "hex decode " + JSON.stringify(string),
    inputBytes,
    hex(Buffer.from(string, "hex")),
    hex(NodeBuffer.from(string, "hex")),
  );
  check(
    "hex byteLength " + JSON.stringify(string),
    inputBytes,
    Buffer.byteLength(string, "hex"),
    NodeBuffer.byteLength(string, "hex"),
  );
}

// ---------------------------------------------------------------------------------------------
// 3. Random byte arrays: text encodings and slices
// ---------------------------------------------------------------------------------------------

const TEXT_ENCODINGS = ["utf8", "hex", "base64", "base64url", "latin1", "ascii", "utf16le"];
for (let trial = 0; trial < 300; trial++) {
  const bytes = randomBytes(randomInt(24));
  const lane = "random bytes " + trial;
  const ours = Buffer.from(bytes);
  const node = NodeBuffer.from(bytes);

  for (const encoding of TEXT_ENCODINGS) {
    check(lane + " toString(" + encoding + ")", bytes, ours.toString(encoding), node.toString(encoding));

    // Slices, including negative and out-of-range endpoints.
    const start = randomInt(30) - 5;
    const end = random() < 0.25 ? undefined : randomInt(30) - 5;
    check(
      lane + " toString(" + encoding + ", " + start + ", " + end + ")",
      bytes,
      ours.toString(encoding, start, end),
      node.toString(encoding, start, end),
    );
  }

  // Base64/hex reproduction.
  check(lane + " hex round-trip", bytes, hex(Buffer.from(hex(node), "hex")), hex(node));
  check(lane + " base64 round-trip", bytes, hex(Buffer.from(node.toString("base64"), "base64")), hex(node));
  check(
    lane + " base64url round-trip",
    bytes,
    hex(Buffer.from(node.toString("base64url"), "base64url")),
    hex(node),
  );
}

// ---------------------------------------------------------------------------------------------
// 4. Numeric reads and writes
// ---------------------------------------------------------------------------------------------

const READ_METHODS = [
  "readUInt8",
  "readInt8",
  "readUInt16LE",
  "readUInt16BE",
  "readInt16LE",
  "readInt16BE",
  "readUInt32LE",
  "readUInt32BE",
  "readInt32LE",
  "readInt32BE",
  "readFloatLE",
  "readFloatBE",
  "readDoubleLE",
  "readDoubleBE",
  "readBigUInt64LE",
  "readBigUInt64BE",
  "readBigInt64LE",
  "readBigInt64BE",
];

const WRITE_METHODS = [
  ["writeUInt8", () => randomInt(256)],
  ["writeInt8", () => randomInt(256) - 128],
  ["writeUInt16LE", () => randomInt(65536)],
  ["writeUInt16BE", () => randomInt(65536)],
  ["writeInt16LE", () => randomInt(65536) - 32768],
  ["writeInt16BE", () => randomInt(65536) - 32768],
  ["writeUInt32LE", () => Math.floor(random() * 4294967296)],
  ["writeUInt32BE", () => Math.floor(random() * 4294967296)],
  ["writeInt32LE", () => Math.floor(random() * 4294967296) - 2147483648],
  ["writeInt32BE", () => Math.floor(random() * 4294967296) - 2147483648],
  ["writeFloatLE", () => (random() - 0.5) * 1e10],
  ["writeFloatBE", () => (random() - 0.5) * 1e10],
  ["writeDoubleLE", () => (random() - 0.5) * 1e100],
  ["writeDoubleBE", () => (random() - 0.5) * 1e100],
  [
    "writeBigUInt64LE",
    () => BigInt(Math.floor(random() * 1e15)) * 1000n + BigInt(randomInt(1000)),
  ],
  [
    "writeBigUInt64BE",
    () => BigInt(Math.floor(random() * 1e15)) * 1000n + BigInt(randomInt(1000)),
  ],
  ["writeBigInt64LE", () => BigInt(Math.floor(random() * 2e15)) - 1000000000000000n],
  ["writeBigInt64BE", () => BigInt(Math.floor(random() * 2e15)) - 1000000000000000n],
];

for (let trial = 0; trial < 250; trial++) {
  const bytes = randomBytes(randomInt(24));
  const lane = "numeric trial " + trial;
  const ours = Buffer.from(bytes);
  const node = NodeBuffer.from(bytes);

  for (const method of READ_METHODS) {
    const offset = randomInt(bytes.length + 3) - 1;
    check(
      lane + " " + method + "(" + offset + ")",
      bytes,
      outcome(() => ours[method](offset), renderValue),
      outcome(() => node[method](offset), renderValue),
    );
  }

  for (const [method, generate] of WRITE_METHODS) {
    const value = generate();
    const offset = randomInt(bytes.length + 3) - 1;
    const oursCopy = Buffer.from(bytes);
    const nodeCopy = NodeBuffer.from(bytes);
    check(
      lane + " " + method + "(" + renderValue(value) + ", " + offset + ")",
      bytes,
      outcome(() => oursCopy[method](value, offset) + ":" + hex(oursCopy), renderValue),
      outcome(() => nodeCopy[method](value, offset) + ":" + hex(nodeCopy), renderValue),
    );
  }

  // Fractional and out-of-range offsets exercise the error paths.
  if (bytes.length > 0) {
    const badOffset = bytes.length + 1;
    for (const method of ["readUInt8", "readUInt16LE", "readUInt32BE", "readDoubleLE", "readBigUInt64LE"]) {
      check(
        lane + " " + method + " out of range",
        bytes,
        outcome(() => ours[method](badOffset), renderValue),
        outcome(() => node[method](badOffset), renderValue),
      );
    }
    check(
      lane + " readUInt8 fractional offset",
      bytes,
      outcome(() => ours.readUInt8(0.5), renderValue),
      outcome(() => node.readUInt8(0.5), renderValue),
    );
  }
}

// ---------------------------------------------------------------------------------------------
// 5. fill / copy / compare / indexOf / concat / swap / equals
// ---------------------------------------------------------------------------------------------

for (let trial = 0; trial < 200; trial++) {
  const bytes = randomBytes(randomInt(16));
  const lane = "ops trial " + trial;
  const ours = Buffer.from(bytes);
  const node = NodeBuffer.from(bytes);

  const fillPatterns = [
    randomInt(256),
    randomInt(512) - 256,
    "ab",
    "é",
    "💩",
    Buffer.from(randomBytes(randomInt(4) + 1)),
  ];
  for (const pattern of fillPatterns) {
    const start = randomInt(bytes.length + 1);
    const end = randomInt(bytes.length + 3) - 1;
    const oursCopy = Buffer.from(bytes);
    const nodeCopy = NodeBuffer.from(bytes);
    check(
      lane + " fill(" + renderValue(pattern) + ", " + start + ", " + end + ")",
      bytes,
      outcome(() => oursCopy.fill(pattern, start, end) === oursCopy, () => hex(oursCopy)),
      outcome(() => nodeCopy.fill(pattern, start, end) === nodeCopy, () => hex(nodeCopy)),
    );
  }

  const targetLength = randomInt(10);
  const targetStart = randomInt(12) - 2;
  const sourceStart = randomInt(12) - 2;
  const sourceEnd = randomInt(12) - 2;
  const oursTarget = Buffer.alloc(targetLength);
  const nodeTarget = NodeBuffer.alloc(targetLength);
  check(
    lane + " copy(" + targetLength + ", " + targetStart + ", " + sourceStart + ", " + sourceEnd + ")",
    bytes,
    outcome(() => ours.copy(oursTarget, targetStart, sourceStart, sourceEnd) + ":" + hex(oursTarget)),
    outcome(() => node.copy(nodeTarget, targetStart, sourceStart, sourceEnd) + ":" + hex(nodeTarget)),
  );

  const other = randomBytes(randomInt(10));
  const compareArgs = [randomInt(8) - 2, randomInt(8) - 2, randomInt(8) - 2, randomInt(8) - 2];
  check(
    lane + " compare(" + hex(other) + ", " + compareArgs.join(",") + ")",
    bytes,
    outcome(() => ours.compare(NodeBuffer.from(other), ...compareArgs)),
    outcome(() => node.compare(NodeBuffer.from(other), ...compareArgs)),
  );
  check(
    lane + " equals(" + hex(other) + ")",
    bytes,
    outcome(() => ours.equals(NodeBuffer.from(other))),
    outcome(() => node.equals(NodeBuffer.from(other))),
  );

  const needle = bytes.slice(0, randomInt(Math.min(3, bytes.length) + 1));
  const searchOffset = randomInt(bytes.length + 4) - 2;
  check(
    lane + " indexOf(" + hex(needle) + ", " + searchOffset + ")",
    bytes,
    outcome(() => ours.indexOf(NodeBuffer.from(needle), searchOffset)),
    outcome(() => node.indexOf(NodeBuffer.from(needle), searchOffset)),
  );
  check(
    lane + " lastIndexOf(" + hex(needle) + ", " + searchOffset + ")",
    bytes,
    outcome(() => ours.lastIndexOf(NodeBuffer.from(needle), searchOffset)),
    outcome(() => node.lastIndexOf(NodeBuffer.from(needle), searchOffset)),
  );
  check(
    lane + " includes(" + hex(needle) + ", " + searchOffset + ")",
    bytes,
    outcome(() => ours.includes(NodeBuffer.from(needle), searchOffset)),
    outcome(() => node.includes(NodeBuffer.from(needle), searchOffset)),
  );

  const byteValue = randomInt(256);
  check(
    lane + " indexOf(number " + byteValue + ", " + searchOffset + ")",
    bytes,
    outcome(() => ours.indexOf(byteValue, searchOffset)),
    outcome(() => node.indexOf(byteValue, searchOffset)),
  );
  check(
    lane + " lastIndexOf(number " + byteValue + ", " + searchOffset + ")",
    bytes,
    outcome(() => ours.lastIndexOf(byteValue, searchOffset)),
    outcome(() => node.lastIndexOf(byteValue, searchOffset)),
  );

  const totalLength = random() < 0.4 ? undefined : randomInt(16);
  check(
    lane + " concat(" + hex(bytes) + ", " + hex(other) + ", " + totalLength + ")",
    bytes,
    outcome(() => hex(Buffer.concat([Buffer.from(bytes), Buffer.from(other)], totalLength))),
    outcome(() => hex(NodeBuffer.concat([NodeBuffer.from(bytes), NodeBuffer.from(other)], totalLength))),
  );

  check(
    lane + " swap16",
    bytes,
    outcome(() => hex(Buffer.from(bytes).swap16()), () => "buf"),
    outcome(() => hex(NodeBuffer.from(bytes).swap16()), () => "buf"),
  );
  check(
    lane + " swap32",
    bytes,
    outcome(() => hex(Buffer.from(bytes).swap32()), () => "buf"),
    outcome(() => hex(NodeBuffer.from(bytes).swap32()), () => "buf"),
  );
  check(
    lane + " swap64",
    bytes,
    outcome(() => hex(Buffer.from(bytes).swap64()), () => "buf"),
    outcome(() => hex(NodeBuffer.from(bytes).swap64()), () => "buf"),
  );
}

// ---------------------------------------------------------------------------------------------
// 6. write(), slice(), alloc() and inspect()
// ---------------------------------------------------------------------------------------------

const WRITE_STRINGS = ["", "abc", "é", "💩", "a💩b", "\uD800", "日本語", "abcdef", "616263", "aGVsbG8="];
const WRITE_ENCODINGS = ["utf8", "hex", "base64", "base64url", "latin1", "ascii", "utf16le"];
for (let trial = 0; trial < 400; trial++) {
  const string = WRITE_STRINGS[randomInt(WRITE_STRINGS.length)];
  const encoding = WRITE_ENCODINGS[randomInt(WRITE_ENCODINGS.length)];
  const length = randomInt(10);
  const offset = randomInt(length + 2);
  const size = random() < 0.5 ? undefined : randomInt(length + 2) - 1;
  const ours = Buffer.alloc(length);
  const node = NodeBuffer.alloc(length);
  const inputBytes = Array.from(string).map((ch) => ch.codePointAt(0));
  check(
    "write(" + JSON.stringify(string) + ", " + offset + ", " + size + ", " + encoding + ") length " + length,
    inputBytes,
    outcome(() => {
      const written = size === undefined ? ours.write(string, offset, encoding) : ours.write(string, offset, size, encoding);
      return written + ":" + hex(ours);
    }),
    outcome(() => {
      const written = size === undefined ? node.write(string, offset, encoding) : node.write(string, offset, size, encoding);
      return written + ":" + hex(node);
    }),
  );
}

for (let length = 0; length < 8; length++) {
  const bytes = randomBytes(length);
  const ours = Buffer.alloc(length, "ab");
  const node = NodeBuffer.alloc(length, "ab");
  check("alloc(" + length + ", 'ab')", bytes, hex(ours), hex(node));
  check("allocUnsafe(" + length + ") length", bytes, Buffer.allocUnsafe(length).length, NodeBuffer.allocUnsafe(length).length);
  check("allocUnsafeSlow(" + length + ") length", bytes, Buffer.allocUnsafeSlow(length).length, NodeBuffer.allocUnsafeSlow(length).length);
  check("inspect(" + length + ")", bytes, Buffer.alloc(length).inspect(), NodeBuffer.alloc(length).inspect());
  for (const encoding of TEXT_ENCODINGS) {
    check(
      "slice.toString(" + encoding + ") on " + length,
      bytes,
      Buffer.from(bytes).slice(1).toString(encoding),
      NodeBuffer.from(bytes).slice(1).toString(encoding),
    );
  }
}

// Slices and subarrays are views: writing through them changes the parent.
{
  const ours = Buffer.from([1, 2, 3, 4]);
  const node = NodeBuffer.from([1, 2, 3, 4]);
  ours.slice(1, 3)[0] = 9;
  node.slice(1, 3)[0] = 9;
  check("slice is a view", [1, 2, 3, 4], hex(ours), hex(node));
  check(
    "subarray is a view",
    [1, 2, 3, 4],
    (() => {
      const view = ours.subarray(0, 2);
      view[1] = 7;
      return hex(ours);
    })(),
    (() => {
      const view = node.subarray(0, 2);
      view[1] = 7;
      return hex(node);
    })(),
  );
  check(
    "slice negative bounds",
    [1, 2, 3, 4],
    hex(ours.slice(-2)) + "|" + ours.slice(3, 1).length,
    hex(node.slice(-2)) + "|" + node.slice(3, 1).length,
  );
}

// Views passed to Buffer.from are copied from their viewed region.
{
  const backing = new Uint8Array([1, 2, 3, 4]).buffer;
  const view = new Uint8Array(backing, 1, 2);
  check("from(Uint8Array view) copies viewed bytes", [2, 3], hex(Buffer.from(view)), hex(NodeBuffer.from(view)));
}

// ---------------------------------------------------------------------------------------------
// 7. StringDecoder, chunk by chunk
// ---------------------------------------------------------------------------------------------

function checkDecoderStream(encoding, bytes, chunks) {
  const ours = new StringDecoder(encoding);
  const node = new NodeStringDecoder(encoding);
  check("StringDecoder(" + encoding + ") encoding", bytes, ours.encoding, node.encoding);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const oursText = ours.write(Uint8Array.from(chunk));
    const nodeText = node.write(NodeBuffer.from(chunk));
    check(
      "StringDecoder " + encoding + " chunk " + i + " (" + hex(chunk) + ")",
      bytes,
      JSON.stringify(oursText) + "|" + ours.lastNeed + "|" + ours.lastTotal,
      JSON.stringify(nodeText) + "|" + node.lastNeed + "|" + node.lastTotal,
    );
  }

  check(
    "StringDecoder " + encoding + " end",
    bytes,
    JSON.stringify(ours.end()),
    JSON.stringify(node.end()),
  );
}

const DECODER_ENCODINGS = ["utf8", "utf16le", "base64", "base64url", "hex", "latin1", "ascii"];
for (const encoding of DECODER_ENCODINGS) {
  for (let trial = 0; trial < 120; trial++) {
    const bytes = randomBytes(randomInt(20));
    const chunks = [];
    let position = 0;
    while (position < bytes.length) {
      const size = 1 + randomInt(4);
      chunks.push(bytes.slice(position, position + size));
      position += size;
    }
    checkDecoderStream(encoding, bytes, chunks);
  }

  // Byte-by-byte over a set of awkward sequences.
  const samples = [
    [],
    [0x41],
    [0x80],
    [0xff],
    [0xe2],
    [0xe2, 0x82],
    [0xe2, 0x82, 0xac],
    [0xe2, 0x82, 0xac, 0x41],
    [0xf0, 0x9f],
    [0xf0, 0x9f, 0x92, 0xa9],
    [0xf0, 0x9f, 0x92],
    [0xe0, 0x80, 0x80],
    [0xed, 0xa0, 0x80],
    [0xc0, 0xaf],
    [0xf8, 0x88, 0x80, 0x80, 0x80],
    [0x00, 0xd8],
    [0x00, 0xd8, 0x41, 0x00],
    [0x3d, 0xd8, 0xa9, 0xdc],
    [0x61, 0x00, 0x62],
    [0x61, 0x00, 0x62, 0x00, 0x63],
  ];
  for (const bytes of samples) {
    checkDecoderStream(
      encoding,
      bytes,
      bytes.map((byte) => [byte]),
    );
  }
}

// ---------------------------------------------------------------------------------------------

if (failures.length > 0) {
  assert.fail(failures.length + " differential mismatch(es); see the messages above");
}
console.log("# buffer.oracle: " + checks + " comparisons, 0 mismatches");
