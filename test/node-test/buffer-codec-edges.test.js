"use strict";

// Adapted from test/conformance/buffer/codec-edges.js.
//
// The conformance case prints each decoded buffer as hex so any single-byte difference fails the
// byte comparison. The same rules are asserted here directly: characters outside the alphabet are
// skipped, padding ends the input, an odd hex digit is dropped, and each UTF-16 code unit is masked
// to one byte before the lookup. These are Node's documented-by-behaviour edges, so the file also
// has to keep passing under Node 26.

const test = require("node:test");
const assert = require("node:assert");
const { Buffer } = require("node:buffer");

function decodedHex(text, encoding) {
    return Buffer.from(text, encoding).toString("hex");
}

test.describe("base64 decoding", () => {
    test("incomplete groups", () => {
        assert.strictEqual(decodedHex("", "base64"), "");
        assert.strictEqual(decodedHex("A", "base64"), "");
        assert.strictEqual(decodedHex("AB", "base64"), "00");
        assert.strictEqual(decodedHex("ABC", "base64"), "0010");
        assert.strictEqual(decodedHex("ABCD", "base64"), "001083");
    });

    test("ignored characters and padding", () => {
        assert.strictEqual(decodedHex("aGVs bG8=\n\t", "base64"), "68656c6c6f");
        assert.strictEqual(decodedHex("QUJD!?RA==", "base64"), "41424344");
        // Padding terminates the input: the bytes after it are not decoded.
        assert.strictEqual(decodedHex("QQ==QUJD", "base64"), "41");
        assert.strictEqual(decodedHex("====", "base64"), "");
        assert.strictEqual(decodedHex("*x", "base64"), "");
    });

    test("both alphabets decode whichever flag was requested", () => {
        assert.strictEqual(decodedHex("-_8", "base64"), "fbff");
        assert.strictEqual(decodedHex("+/8=", "base64url"), "fbff");
    });

    test("a code unit is masked to one byte", () => {
        assert.strictEqual(decodedHex("QU\u0161JD", "base64"), "414689");
        assert.strictEqual(decodedHex("QU\uD83DJD", "base64"), "41");
        assert.strictEqual(decodedHex("QU\uDC00JD", "base64"), "414243");
        assert.strictEqual(decodedHex("QU\u{1f4a9}JD", "base64"), "41");
        assert.strictEqual(decodedHex("\uD83DQUJD", "base64"), "");
    });
});

test.describe("hex decoding", () => {
    test("pairs only", () => {
        assert.strictEqual(decodedHex("", "hex"), "");
        assert.strictEqual(decodedHex("abc", "hex"), "ab");
        assert.strictEqual(decodedHex("ABCDEF", "hex"), "abcdef");
        assert.strictEqual(decodedHex("12zz34", "hex"), "12");
        assert.strictEqual(decodedHex("0g00", "hex"), "");
        assert.strictEqual(decodedHex("ab0", "hex"), "ab");
    });

    test("characters are masked to one byte", () => {
        assert.strictEqual(decodedHex("\u01610", "hex"), "a0");
        assert.strictEqual(decodedHex("ab\u{1f4a9}cd", "hex"), "ab");
    });
});

test("encoding edges and toString ranges", () => {
    assert.strictEqual(Buffer.from([]).toString("base64"), "");
    assert.strictEqual(Buffer.from([0x00]).toString("base64"), "AA==");
    assert.strictEqual(Buffer.from([0xfb, 0xff]).toString("base64"), "+/8=");
    assert.strictEqual(Buffer.from([0xfb, 0xff]).toString("base64url"), "-_8");
    assert.strictEqual(Buffer.from([0x41, 0x42, 0x43]).toString("base64"), "QUJD");

    const wide = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
    assert.strictEqual(wide.toString("hex", 1, 4), "010203");
    assert.strictEqual(wide.toString("hex", 5, 2), "");
    assert.strictEqual(wide.toString("hex", 6, 99), "0607");
    assert.strictEqual(wide.toString("hex", -3, 3), "000102");
    assert.strictEqual(wide.toString("base64", 2, 7), "AgMEBQY=");
    assert.strictEqual(wide.toString("base64url", 0, 8), "AAECAwQFBgc");
});
