"use strict";

// Runtime-agnostic self-test for js/lib/textcodec.js.
//
// Run under `node` (and `onde`): node test/js/lib/textcodec.test.js
// Prints one `ok <label>` line per passing check and exits 1 on any failure.

const {
    TextEncoder,
    TextDecoder,
    encodeUTF8,
    decodeUTF8,
} = require("../../../js/lib/textcodec.js");

let failures = 0;

function fmt(value) {
    if (value instanceof Uint8Array) return "[" + Array.from(value).join(",") + "]";
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

function isBytes(actual, expected, label) {
    const actualText = Array.from(actual).join(",");
    const expectedText = Array.from(expected).join(",");
    if (actualText === expectedText) {
        ok(label);
    } else {
        fail(label, "expected [" + expectedText + "], got [" + actualText + "]");
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
                "expected " +
                    name +
                    " " +
                    code +
                    ", got " +
                    (err && err.name) +
                    " " +
                    (err && err.code),
            );
        }
    }
}

function decoderDecode(label, encoding, bytes, options) {
    const decoder = new TextDecoder(encoding, options);
    return decoder.decode(Uint8Array.from(bytes));
}

// -------------------------------------------------------------------------------------------
// TextEncoder
// -------------------------------------------------------------------------------------------

const encoder = new TextEncoder();
is(encoder.encoding, "utf-8", "TextEncoder.encoding is utf-8");
isBytes(encoder.encode(""), [], "encode empty string");
isBytes(encoder.encode("abc"), [0x61, 0x62, 0x63], "encode ascii");
isBytes(encoder.encode("é"), [0xc3, 0xa9], "encode two-byte code point");
isBytes(encoder.encode("€"), [0xe2, 0x82, 0xac], "encode three-byte code point");
isBytes(encoder.encode("💩"), [0xf0, 0x9f, 0x92, 0xa9], "encode surrogate pair as one code point");
isBytes(encoder.encode("\uD800"), [0xef, 0xbf, 0xbd], "encode lone high surrogate as U+FFFD");
isBytes(encoder.encode("\uDC00"), [0xef, 0xbf, 0xbd], "encode lone low surrogate as U+FFFD");
isBytes(
    encoder.encode("a\uD800b"),
    [0x61, 0xef, 0xbf, 0xbd, 0x62],
    "encode lone surrogate between characters",
);
isBytes(encoder.encode("\u0000"), [0x00], "encode NUL");

{
    const dest = new Uint8Array(3);
    const result = encoder.encodeInto("abc", dest);
    is(result.read, 3, "encodeInto reads all three code units");
    is(result.written, 3, "encodeInto writes three bytes");
    isBytes(dest, [0x61, 0x62, 0x63], "encodeInto fills the destination");
}

{
    const dest = new Uint8Array(5);
    const result = encoder.encodeInto("a💩b", dest);
    is(result.read, 3, "encodeInto counts a surrogate pair as two code units");
    is(result.written, 5, "encodeInto writes the whole pair");
    isBytes(dest, [0x61, 0xf0, 0x9f, 0x92, 0xa9], "encodeInto writes pair bytes");
}

{
    const dest = new Uint8Array(4);
    const result = encoder.encodeInto("a💩b", dest);
    is(result.read, 1, "encodeInto stops before a surrogate pair that does not fit");
    is(result.written, 1, "encodeInto writes only the leading byte");
    isBytes(dest, [0x61, 0x00, 0x00, 0x00], "encodeInto never writes a partial pair");
}

{
    const dest = new Uint8Array(2);
    const result = encoder.encodeInto("💩", dest);
    is(result.read, 0, "encodeInto consumes nothing when a code point does not fit");
    is(result.written, 0, "encodeInto writes nothing when a code point does not fit");
}

{
    const dest = new Uint8Array(4);
    dest.fill(0xaa);
    const result = encoder.encodeInto("ab", dest);
    is(result.read, 2, "encodeInto reads when the destination is larger");
    is(result.written, 2, "encodeInto writes when the destination is larger");
    isBytes(dest, [0x61, 0x62, 0xaa, 0xaa], "encodeInto leaves the tail of the destination alone");
}

throwsWith(
    () => encoder.encodeInto("a", [1, 2]),
    "TypeError",
    "ERR_INVALID_ARG_TYPE",
    "encodeInto rejects a non-Uint8Array destination",
);

// -------------------------------------------------------------------------------------------
// Encoding labels and properties
// -------------------------------------------------------------------------------------------

is(new TextDecoder("utf-8").encoding, "utf-8", "label utf-8");
is(new TextDecoder("utf8").encoding, "utf-8", "label utf8");
is(new TextDecoder("unicode-1-1-utf-8").encoding, "utf-8", "label unicode-1-1-utf-8");
is(new TextDecoder("utf-16le").encoding, "utf-16le", "label utf-16le");
is(new TextDecoder("utf-16").encoding, "utf-16le", "label utf-16");
is(new TextDecoder("ucs-2").encoding, "utf-16le", "label ucs-2");
is(new TextDecoder("latin1").encoding, "windows-1252", "label latin1 maps to windows-1252");
is(new TextDecoder("iso-8859-1").encoding, "windows-1252", "label iso-8859-1");
is(new TextDecoder("windows-1252").encoding, "windows-1252", "label windows-1252");
is(new TextDecoder("ascii").encoding, "windows-1252", "label ascii maps to windows-1252");

throwsWith(
    () => new TextDecoder("bogus"),
    "RangeError",
    "ERR_ENCODING_NOT_SUPPORTED",
    "unknown label throws RangeError with code",
);
throwsWith(
    () => new TextDecoder("utf-32"),
    "RangeError",
    "ERR_ENCODING_NOT_SUPPORTED",
    "unsupported multi-byte label throws",
);

{
    const plain = new TextDecoder();
    is(plain.fatal, false, "fatal defaults to false");
    is(plain.ignoreBOM, false, "ignoreBOM defaults to false");
    const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    is(strict.fatal, true, "fatal option is boolean");
    is(strict.ignoreBOM, true, "ignoreBOM option is boolean");
}

// -------------------------------------------------------------------------------------------
// UTF-8 decoding
// -------------------------------------------------------------------------------------------

is(new TextDecoder().decode(), "", "decode() with no argument returns empty string");
is(new TextDecoder().decode(new Uint8Array(0)), "", "decode empty Uint8Array");
is(
    decoderDecode("x", "utf-8", [0x61, 0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x92, 0xa9]),
    "aé€💩",
    "decode mixed UTF-8",
);
is(
    new TextDecoder().decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41])),
    "A",
    "strip UTF-8 BOM by default",
);
is(
    new TextDecoder("utf-8", { ignoreBOM: true }).decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41])),
    "\uFEFFA",
    "ignoreBOM keeps the BOM",
);
is(new TextDecoder().decode(new Uint8Array([0xef, 0xbb, 0xbf])), "", "lone BOM decodes to empty");
is(
    new TextDecoder().decode(new Uint8Array([0x41, 0xef, 0xbb, 0xbf])),
    "A\uFEFF",
    "a BOM after the start is kept",
);

// Input coercion: ArrayBuffer, DataView and other views are allowed.
is(new TextDecoder().decode(Uint8Array.from([0x41]).buffer), "A", "decode ArrayBuffer");
is(
    new TextDecoder().decode(new DataView(Uint8Array.from([0x41, 0x42, 0x43]).buffer, 1, 1)),
    "B",
    "decode DataView",
);
is(
    new TextDecoder().decode(Uint8Array.from([0x41, 0x42, 0x43]).subarray(1, 2)),
    "B",
    "decode subarray",
);
throwsWith(
    () => new TextDecoder().decode("abc"),
    "TypeError",
    "ERR_INVALID_ARG_TYPE",
    "decode rejects a string",
);

const invalidUtf8 = [
    [[0xf0, 0x9f, 0x92], "\uFFFD", "truncated four-byte sequence"],
    [[0xf0, 0x9f], "\uFFFD", "truncated four-byte sequence (two bytes)"],
    [[0xf0], "\uFFFD", "truncated four-byte sequence (one byte)"],
    [[0xe0, 0x80, 0x80], "\uFFFD\uFFFD\uFFFD", "overlong E0 80 80"],
    [[0xed, 0xa0, 0x80], "\uFFFD\uFFFD\uFFFD", "UTF-16 surrogate encoded as UTF-8"],
    [[0xf4, 0x90, 0x80, 0x80], "\uFFFD\uFFFD\uFFFD\uFFFD", "code point above U+10FFFF"],
    [
        [0xf8, 0x88, 0x80, 0x80, 0x80],
        "\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD",
        "invalid five-byte sequence",
    ],
    [
        [0xfc, 0x84, 0x80, 0x80, 0x80, 0x80],
        "\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD",
        "invalid six-byte sequence",
    ],
    [[0x80], "\uFFFD", "bare continuation byte"],
    [[0xc0, 0xaf], "\uFFFD\uFFFD", "overlong C0 AF"],
    [[0xc1, 0xbf], "\uFFFD\uFFFD", "overlong C1 BF"],
    [[0xe0, 0xa0], "\uFFFD", "truncated three-byte sequence"],
    [[0xe2, 0x28, 0xa1], "\uFFFD(\uFFFD", "invalid continuation in the middle"],
    [[0xf0, 0x28, 0x8c, 0x28], "\uFFFD(\uFFFD(", "invalid continuations in a four-byte sequence"],
    [[0xfe], "\uFFFD", "invalid byte FE"],
    [[0xff], "\uFFFD", "invalid byte FF"],
];

for (const [bytes, expected, label] of invalidUtf8) {
    is(decoderDecode(label, "utf-8", bytes), expected, "UTF-8 replacement: " + label);
}

throwsWith(
    () => new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from([0xff])),
    "TypeError",
    "ERR_ENCODING_INVALID_ENCODED_DATA",
    "fatal UTF-8 throws on invalid data",
);
throwsWith(
    () => new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from([0xf0, 0x9f])),
    "TypeError",
    "ERR_ENCODING_INVALID_ENCODED_DATA",
    "fatal UTF-8 throws on truncated data at EOF",
);

// Streaming: split the bytes of "€💩a" at every position and compare with a one-shot decode.
{
    const bytes = [0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x92, 0xa9, 0x61];
    const expected = "€💩a";
    for (let split = 0; split <= bytes.length; split++) {
        const decoder = new TextDecoder();
        let text = decoder.decode(Uint8Array.from(bytes.slice(0, split)), { stream: true });
        text += decoder.decode(Uint8Array.from(bytes.slice(split)), { stream: true });
        text += decoder.decode();
        is(text, expected, "UTF-8 stream split at " + split);
    }
}

// Byte-by-byte streaming.
{
    const decoder = new TextDecoder();
    let text = "";
    for (const byte of [0xf0, 0x9f, 0x92, 0xa9]) {
        text += decoder.decode(Uint8Array.from([byte]), { stream: true });
    }
    text += decoder.decode();
    is(text, "💩", "UTF-8 byte-by-byte streaming");
}

// BOM split across streaming calls is not emitted.
{
    const decoder = new TextDecoder();
    const first = decoder.decode(Uint8Array.from([0xef]), { stream: true });
    const second = decoder.decode(Uint8Array.from([0xbb, 0xbf, 0x41]), { stream: true });
    is(first + second + decoder.decode(), "A", "UTF-8 BOM split across stream chunks");
}

// Fatal mode: an incomplete sequence is only an error at flush time.
{
    const decoder = new TextDecoder("utf-8", { fatal: true });
    is(
        decoder.decode(Uint8Array.from([0xe2]), { stream: true }),
        "",
        "fatal stream holds an incomplete sequence",
    );
    throwsWith(
        () => decoder.decode(),
        "TypeError",
        "ERR_ENCODING_INVALID_ENCODED_DATA",
        "fatal stream throws when flushed with an incomplete sequence",
    );
    is(decoder.decode(Uint8Array.from([0x61])), "a", "fatal decoder recovers after an error");
}

// A finished (non-stream) decode restarts BOM handling.
{
    const decoder = new TextDecoder();
    is(
        decoder.decode(Uint8Array.from([0xef, 0xbb, 0xbf, 0x41])),
        "A",
        "BOM stripped on first read",
    );
    is(
        decoder.decode(Uint8Array.from([0xef, 0xbb, 0xbf, 0x41])),
        "A",
        "BOM stripped again after a reset",
    );
}

// -------------------------------------------------------------------------------------------
// UTF-16LE decoding
// -------------------------------------------------------------------------------------------

is(decoderDecode("utf16", "utf-16le", [0x61, 0x00]), "a", "decode UTF-16LE ascii");
is(
    decoderDecode("utf16", "utf-16le", [0x3d, 0xd8, 0xa9, 0xdc]),
    "💩",
    "decode UTF-16LE surrogate pair",
);
is(decoderDecode("utf16", "utf-16le", [0x00, 0xd8]), "\uFFFD", "lone UTF-16LE high surrogate");
is(decoderDecode("utf16", "utf-16le", [0x00, 0xdc]), "\uFFFD", "lone UTF-16LE low surrogate");
is(decoderDecode("utf16", "utf-16le", [0x61]), "\uFFFD", "odd trailing UTF-16LE byte");
is(decoderDecode("utf16", "utf-16le", [0xff, 0xfe, 0x41, 0x00]), "A", "strip UTF-16LE BOM");
is(
    new TextDecoder("utf-16le", { ignoreBOM: true }).decode(
        Uint8Array.from([0xff, 0xfe, 0x41, 0x00]),
    ),
    "\uFEFFA",
    "ignoreBOM keeps the UTF-16LE BOM",
);
throwsWith(
    () => new TextDecoder("utf-16le", { fatal: true }).decode(Uint8Array.from([0x00, 0xd8])),
    "TypeError",
    "ERR_ENCODING_INVALID_ENCODED_DATA",
    "fatal UTF-16LE throws on a lone surrogate",
);

{
    const decoder = new TextDecoder("utf-16le");
    let text = decoder.decode(Uint8Array.from([0x61]), { stream: true });
    text += decoder.decode(Uint8Array.from([0x00]));
    is(text, "a", "UTF-16LE stream with a split code unit");
}

{
    const decoder = new TextDecoder("utf-16le");
    let text = decoder.decode(Uint8Array.from([0x3d, 0xd8]), { stream: true });
    text += decoder.decode(Uint8Array.from([0xa9, 0xdc]));
    is(text, "💩", "UTF-16LE stream split across a surrogate pair");
}

// -------------------------------------------------------------------------------------------
// windows-1252 / ascii
// -------------------------------------------------------------------------------------------

is(decoderDecode("cp1252", "windows-1252", [0x80]), "€", "windows-1252 0x80 maps to euro");
is(decoderDecode("cp1252", "windows-1252", [0x81]), "\u0081", "windows-1252 0x81 is a C1 control");
is(
    decoderDecode("cp1252", "windows-1252", [0x91, 0x92, 0x93, 0x94]),
    "‘’“”",
    "windows-1252 quotes",
);
is(decoderDecode("cp1252", "windows-1252", [0x9f]), "Ÿ", "windows-1252 0x9F");
is(decoderDecode("cp1252", "windows-1252", [0xff]), "ÿ", "windows-1252 0xFF");
is(decoderDecode("cp1252", "windows-1252", [0x41]), "A", "windows-1252 ASCII range");
is(decoderDecode("ascii", "ascii", [0x80]), "€", "ascii label decodes as windows-1252");
is(
    new TextDecoder("latin1").decode(Uint8Array.from([0x80])),
    "€",
    "latin1 label decodes as windows-1252",
);

// -------------------------------------------------------------------------------------------
// encodeUTF8 / decodeUTF8 helpers
// -------------------------------------------------------------------------------------------

isBytes(encodeUTF8("aé💩"), [0x61, 0xc3, 0xa9, 0xf0, 0x9f, 0x92, 0xa9], "encodeUTF8 helper");
is(
    decodeUTF8(Uint8Array.from([0x61, 0xc3, 0xa9, 0xf0, 0x9f, 0x92, 0xa9])),
    "aé💩",
    "decodeUTF8 helper",
);
is(
    decodeUTF8(Uint8Array.from([0xf0, 0x9f, 0x92])),
    "\uFFFD",
    "decodeUTF8 replacement on truncation",
);
is(decodeUTF8(Uint8Array.from([0xef, 0xbb, 0xbf, 0x41])), "\uFEFFA", "decodeUTF8 never strips BOM");

// -------------------------------------------------------------------------------------------

if (failures > 0) {
    console.error("# textcodec: " + failures + " failure(s)");
    process.exit(1);
}
console.log("# textcodec: all checks passed");
