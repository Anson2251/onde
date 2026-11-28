"use strict";

// Runtime-agnostic self-check for js/lib/internal/bytes.js, the Buffer-vocabulary codecs.
//
//   node test/js/lib/bytes.test.js
//   ./target/debug/onde test/js/lib/bytes.test.js
//
// Only the module under test is required; no `node:` builtins are used. Literals are pinned from
// Node's own behaviour so the same file checks the JS fallback under both runtimes.

const {
    base64Decode,
    base64Encode,
    byteView,
    canonicalEncoding,
    concatBytes,
    decodeAscii,
    decodeLatin1,
    decodeUtf16le,
    encodeAscii,
    encodeLatin1,
    encodeUtf16le,
    hexDecode,
    hexEncode,
    isAnyArrayBuffer,
    isArrayBufferView,
} = require("../../../js/lib/internal/bytes.js");

let passed = 0;
let failed = 0;

function show(value) {
    if (value instanceof Uint8Array) return "[" + Array.from(value).join(",") + "]";
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "bigint") return `${value}n`;
    if (value === undefined) return "undefined";
    return String(value);
}

function ok(label) {
    passed++;
    console.log("ok " + label);
}

function fail(label, expected, actual) {
    failed++;
    console.error("FAIL " + label);
    console.error("  expected: " + show(expected));
    console.error("  actual:   " + show(actual));
}

function is(actual, expected, label) {
    if (Object.is(actual, expected)) ok(label);
    else fail(label, expected, actual);
}

function sameBytes(actual, expected, label) {
    if (
        actual instanceof Uint8Array &&
        actual.length === expected.length &&
        expected.every((value, index) => actual[index] === value)
    ) {
        ok(label);
    } else {
        fail(label, expected, actual);
    }
}

function from(list) {
    return Uint8Array.from(list);
}

// ---------------------------------------------------------------------------------------------
// canonicalEncoding
// ---------------------------------------------------------------------------------------------

{
    const aliases = {
        utf8: "utf8",
        "utf-8": "utf8",
        UTF8: "utf8",
        "UTF-8": "utf8",
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
        HeX: "hex",
    };
    for (const label of Object.keys(aliases)) {
        is(
            canonicalEncoding(label),
            aliases[label],
            "canonicalEncoding(" + JSON.stringify(label) + ")",
        );
    }

    is(canonicalEncoding(undefined), "utf8", "canonicalEncoding(undefined) is utf8");
    is(canonicalEncoding(null), "utf8", "canonicalEncoding(null) is utf8");
    is(canonicalEncoding(""), "utf8", "canonicalEncoding(empty) is utf8");
    is(canonicalEncoding(1), null, "canonicalEncoding(number) is null");
    is(canonicalEncoding({}), null, "canonicalEncoding(object) is null");
    is(canonicalEncoding([]), null, "canonicalEncoding(array) is null");
    is(canonicalEncoding("bogus"), null, "canonicalEncoding(unknown) is null");
    is(canonicalEncoding(" utf8"), null, "canonicalEncoding does not trim");
}

// ---------------------------------------------------------------------------------------------
// utf16le
// ---------------------------------------------------------------------------------------------

{
    sameBytes(
        encodeUtf16le("A€💩"),
        [0x41, 0x00, 0xac, 0x20, 0x3d, 0xd8, 0xa9, 0xdc],
        "encodeUtf16le writes both bytes of every code unit",
    );
    is(encodeUtf16le("").length, 0, "encodeUtf16le(empty) is empty");

    is(decodeUtf16le(from([0x41, 0x00, 0xac, 0x20]), 0, 4), "A€", "decodeUtf16le basic");
    is(decodeUtf16le(from([0x3d, 0xd8, 0xa9, 0xdc]), 0, 4), "💩", "decodeUtf16le surrogate pair");
    is(
        decodeUtf16le(from([0x41, 0x00, 0x42]), 0, 3),
        "A",
        "decodeUtf16le drops a trailing odd byte",
    );
    is(decodeUtf16le(from([0xff, 0x00, 0x41, 0x00]), 1, 1), "", "decodeUtf16le empty range");
    is(decodeUtf16le(from([0xff, 0xff, 0x41, 0x00]), 2, 4), "A", "decodeUtf16le honours start");
    is(decodeUtf16le(from([0x41, 0x00, 0x42, 0x00]), 0, 2), "A", "decodeUtf16le honours end");
    is(decodeUtf16le(encodeUtf16le("a💩b"), 0, 8), "a💩b", "utf16le round-trip");
}

// ---------------------------------------------------------------------------------------------
// latin1 / ascii
// ---------------------------------------------------------------------------------------------

{
    is(
        decodeLatin1(from([0x41, 0x80, 0xff]), 0, 3),
        "A\u0080\u00ff",
        "decodeLatin1 passes bytes through",
    );
    is(decodeLatin1(from([0x00, 0xff]), 0, 2), "\u0000\u00ff", "decodeLatin1 keeps NUL");
    sameBytes(encodeLatin1("A\u0080\u00ff"), [0x41, 0x80, 0xff], "encodeLatin1 keeps the low byte");
    sameBytes(encodeLatin1("€"), [0xac], "encodeLatin1 truncates to eight bits");

    is(decodeAscii(from([0x41, 0x80, 0xff]), 0, 3), "A\u0000\u007f", "decodeAscii masks 0x7F");
    sameBytes(encodeAscii("é"), [0xe9], "encodeAscii truncates instead of masking");
    sameBytes(encodeAscii("\u0100"), [0x00], "encodeAscii keeps only the low byte");
    is(decodeAscii(encodeAscii("é"), 0, 1), "i", "ascii round-trip shows the asymmetry");

    // The chunk builder flushes every 4096 code units; cross it once to prove the reset works.
    const large = new Uint8Array(9001);
    for (let i = 0; i < large.length; i++) large[i] = i & 0xff;
    const latin1 = decodeLatin1(large, 0, large.length);
    is(latin1.length, 9001, "decodeLatin1 crosses the chunk boundary");
    is(latin1.charCodeAt(0), 0, "decodeLatin1 chunk boundary: first byte");
    is(latin1.charCodeAt(4095), 0xff, "decodeLatin1 chunk boundary: last of first chunk");
    is(latin1.charCodeAt(4096), 0, "decodeLatin1 chunk boundary: first of second chunk");
    is(latin1.charCodeAt(9000), 9000 & 0xff, "decodeLatin1 chunk boundary: final byte");
}

// ---------------------------------------------------------------------------------------------
// hex
// ---------------------------------------------------------------------------------------------

{
    is(hexEncode(from([0x00, 0x0a, 0xbc, 0xff]), 0, 4), "000abcff", "hexEncode is lowercase");
    is(hexEncode(from([0x00, 0x0a, 0xbc, 0xff]), 1, 3), "0abc", "hexEncode honours start/end");
    is(hexEncode(from([]), 0, 0), "", "hexEncode(empty)");

    sameBytes(hexDecode("000abcff"), [0x00, 0x0a, 0xbc, 0xff], "hexDecode basic");
    sameBytes(hexDecode("ABCDEF"), [0xab, 0xcd, 0xef], "hexDecode accepts uppercase");
    sameBytes(hexDecode("abc"), [0xab], "hexDecode drops an odd trailing digit");
    sameBytes(hexDecode(""), [], "hexDecode(empty)");
    sameBytes(hexDecode("12zz34"), [0x12], "hexDecode stops at the first non-hex pair");
    sameBytes(hexDecode("š0"), [0xa0], "hexDecode masks a UTF-16 code unit to a byte");
    sameBytes(hexDecode("\u01610"), [0xa0], "hexDecode masks a non-ASCII code unit");
}

// ---------------------------------------------------------------------------------------------
// base64
// ---------------------------------------------------------------------------------------------

{
    is(base64Encode(from([0xfb, 0xff]), 0, 2, false), "+/8=", "base64Encode pads two bytes");
    is(base64Encode(from([0xfb, 0xff]), 0, 2, true), "-_8", "base64Encode url-safe does not pad");
    is(base64Encode(from([0x41]), 0, 1, false), "QQ==", "base64Encode pads one byte");
    is(base64Encode(from([0x41]), 0, 1, true), "QQ", "base64Encode url-safe one byte");
    is(base64Encode(from([0x41, 0x42, 0x43]), 0, 3, false), "QUJD", "base64Encode three bytes");
    is(base64Encode(from([]), 0, 0, false), "", "base64Encode(empty)");
    is(
        base64Encode(from([0xff, 0xfe, 0xfd, 0xfc]), 1, 4, false),
        "/v38",
        "base64Encode honours start/end",
    );

    sameBytes(base64Decode("+/8=", false), [0xfb, 0xff], "base64Decode standard with padding");
    sameBytes(base64Decode("-_8", false), [0xfb, 0xff], "base64Decode url-safe without padding");
    sameBytes(
        base64Decode("+/8=", true),
        [0xfb, 0xff],
        "base64url decoder accepts standard alphabet",
    );
    sameBytes(base64Decode("-_8", true), [0xfb, 0xff], "base64 decoder accepts url-safe alphabet");
    sameBytes(base64Decode("", false), [], "base64Decode(empty)");
    sameBytes(base64Decode("A", false), [], "base64Decode drops a single trailing character");
    sameBytes(base64Decode("AB", false), [0x00], "base64Decode one pair yields one byte");
    sameBytes(
        base64Decode("ABC", false),
        [0x00, 0x10],
        "base64Decode three characters yield two bytes",
    );
    sameBytes(
        base64Decode("ABCD", false),
        [0x00, 0x10, 0x83],
        "base64Decode four characters yield three bytes",
    );
    sameBytes(
        base64Decode("aGVs bG8=", false),
        [0x68, 0x65, 0x6c, 0x6c, 0x6f],
        "base64Decode ignores whitespace",
    );
    sameBytes(base64Decode("*x", false), [], "base64Decode ignores non-alphabet characters");
    sameBytes(
        base64Decode("QUJD!?RA==", false),
        [0x41, 0x42, 0x43, 0x44],
        "base64Decode ignores punctuation",
    );
    sameBytes(base64Decode("QQ==QUJD", false), [0x41], "base64Decode stops at the first '='");
    sameBytes(
        base64Decode("QU\uD83DJD", false),
        [0x41],
        "base64Decode stops at a masked surrogate",
    );
}

// ---------------------------------------------------------------------------------------------
// concatBytes
// ---------------------------------------------------------------------------------------------

{
    sameBytes(concatBytes(from([1, 2]), from([3])), [1, 2, 3], "concatBytes joins two sequences");

    const first = from([1, 2]);
    const second = from([3]);
    is(
        concatBytes(first, new Uint8Array(0)),
        first,
        "concatBytes keeps the first when the second is empty",
    );
    is(
        concatBytes(new Uint8Array(0), second),
        second,
        "concatBytes keeps the second when the first is empty",
    );
    sameBytes(concatBytes(new Uint8Array(0), new Uint8Array(0)), [], "concatBytes of two empties");

    // internal/fs passes a chunk list and an exact total instead of a second sequence.
    sameBytes(
        concatBytes([from([1, 2]), from([]), from([3, 4])], 4),
        [1, 2, 3, 4],
        "concatBytes chunk list",
    );
    sameBytes(concatBytes([], 0), [], "concatBytes empty chunk list");
}

// ---------------------------------------------------------------------------------------------
// byteView / isAnyArrayBuffer / isArrayBufferView
// ---------------------------------------------------------------------------------------------

{
    const bytes = from([1, 2, 3]);
    is(byteView(bytes), bytes, "byteView returns a Uint8Array as-is");

    const backing = from([9, 8, 7, 6]);
    const dataView = new DataView(backing.buffer, 1, 2);
    sameBytes(byteView(dataView), [8, 7], "byteView honours a DataView's window");

    const whole = from([5, 6]).buffer;
    sameBytes(byteView(whole), [5, 6], "byteView covers the whole ArrayBuffer");

    const typed = new Uint16Array([0x0102]);
    sameBytes(
        byteView(typed),
        Array.from(new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength)),
        "byteView returns a typed array's raw bytes",
    );

    if (typeof SharedArrayBuffer !== "undefined") {
        const shared = new SharedArrayBuffer(3);
        const sharedBytes = new Uint8Array(shared);
        sharedBytes[0] = 4;
        sharedBytes[1] = 5;
        sharedBytes[2] = 6;
        sameBytes(byteView(shared), [4, 5, 6], "byteView covers a whole SharedArrayBuffer");
        is(isAnyArrayBuffer(shared), true, "isAnyArrayBuffer(SharedArrayBuffer)");
    }

    is(byteView("abc"), null, "byteView(string) is null");
    is(byteView([1, 2]), null, "byteView(plain array) is null");
    is(byteView(null), null, "byteView(null) is null");
    is(byteView(undefined), null, "byteView(undefined) is null");
    is(byteView(1), null, "byteView(number) is null");

    is(isAnyArrayBuffer(new ArrayBuffer(0)), true, "isAnyArrayBuffer(ArrayBuffer)");
    is(isAnyArrayBuffer(bytes), false, "isAnyArrayBuffer(Uint8Array) is false");
    is(isAnyArrayBuffer("abc"), false, "isAnyArrayBuffer(string) is false");

    is(isArrayBufferView(bytes), true, "isArrayBufferView(Uint8Array)");
    is(isArrayBufferView(dataView), true, "isArrayBufferView(DataView)");
    is(isArrayBufferView(whole), false, "isArrayBufferView(ArrayBuffer) is false");
    is(isArrayBufferView("abc"), false, "isArrayBufferView(string) is false");
}

console.log("");
if (failed === 0) {
    console.log(passed + " passed, 0 failed");
} else {
    console.log(passed + " passed, " + failed + " failed");
    process.exitCode = 1;
}
