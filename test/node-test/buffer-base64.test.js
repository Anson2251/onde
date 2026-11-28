"use strict";

// Adapted from test/conformance/buffer/base64-roundtrip.js.
//
// The conformance case prints every tail length and window so the transcript can be byte-compared;
// this version asserts the round trip directly. Both alphabets and `toString`'s start/end window
// are covered because those are the branches the corpus exists for, and no fixture or timer is
// needed, so the file is safe under a sequential runner.

const test = require("node:test");
const assert = require("node:assert");
const { Buffer } = require("node:buffer");

// 40 bytes of a deterministic pattern exercise every residue class past the first block.
const pattern = Buffer.from(Array.from({ length: 40 }, (_, index) => (index * 37 + 11) & 0xff));

test("base64 round-trips every tail length", async (t) => {
    await t.test("standard alphabet", () => {
        for (let length = 0; length <= 12; length += 1) {
            const slice = pattern.subarray(0, length);
            const encoded = slice.toString("base64");
            assert.strictEqual(
                Buffer.from(encoded, "base64").toString("hex"),
                slice.toString("hex"),
                `tail length ${length}`,
            );
        }
        assert.strictEqual(pattern.toString("base64").length, 56);
    });

    await t.test("url alphabet", () => {
        for (let length = 0; length <= 12; length += 1) {
            const slice = pattern.subarray(0, length);
            const encoded = slice.toString("base64url");
            assert.strictEqual(
                Buffer.from(encoded, "base64url").toString("hex"),
                slice.toString("hex"),
                `tail length ${length}`,
            );
        }
        assert.ok(!pattern.toString("base64url").includes("+"));
        assert.ok(!pattern.toString("base64url").includes("/"));
    });
});

test("toString honours start and end", () => {
    // The range stays in JS and the host encodes the borrowed window, so the boundaries are where
    // the conformance case found bugs: zero length, reversed, past the end and negative.
    assert.strictEqual(pattern.toString("base64", 0, 1), "Cw==");
    assert.strictEqual(pattern.toString("base64", 3, 5), "ep8=");
    assert.strictEqual(pattern.toString("base64", 7, 7), "");
    assert.strictEqual(pattern.toString("base64", 9, 3), "");
    assert.strictEqual(Buffer.from([0x00, 0x01]).toString("hex", 1, 1), "");
    assert.strictEqual(Buffer.from([0x00, 0x01, 0x02, 0x03]).toString("hex", 1, 3), "0102");
});
