"use strict";

// Randomized differential for UTF-8 encode and decode.
//
// The Rust path (host.text) is only reached under onde; the node arm compares Node's own Buffer
// against the reference, which is what makes the reference trustworthy. Both arms generate the same
// cases from a fixed seed.
//
// The decoder reference implements the WHATWG rule the JavaScript fallback documents: on an invalid
// sequence, emit one U+FFFD for the maximal prefix that could have been valid and resume at the byte
// that broke it. That is why a truncated four-byte sequence yields one replacement, not three.

const isLite = typeof globalThis.__ln_host === "object";
const Buffer = isLite ? require("../../../js/lib/buffer.js") : require("node:buffer").Buffer;

let passed = 0;
const failures = [];

function eq(actual, expected, message) {
    if (actual === expected) {
        passed += 1;
    } else {
        failures.push(
            `${message}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`,
        );
    }
}

// --- references -------------------------------------------------------------------------------

function refEncode(text) {
    const bytes = [];
    for (let i = 0; i < text.length; i += 1) {
        let codePoint = text.charCodeAt(i);
        if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
            const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
            if (next >= 0xdc00 && next <= 0xdfff) {
                codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00);
                i += 1;
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
    return bytes;
}

function refDecode(bytes) {
    let out = "";
    let i = 0;
    while (i < bytes.length) {
        const byte = bytes[i];

        if (byte <= 0x7f) {
            out += String.fromCharCode(byte);
            i += 1;
            continue;
        }

        let needed;
        let codePoint;
        let lower = 0x80;
        let upper = 0xbf;
        if (byte >= 0xc2 && byte <= 0xdf) {
            needed = 1;
            codePoint = byte & 0x1f;
        } else if (byte >= 0xe0 && byte <= 0xef) {
            needed = 2;
            codePoint = byte & 0x0f;
            if (byte === 0xe0) lower = 0xa0;
            if (byte === 0xed) upper = 0x9f; // no surrogates
        } else if (byte >= 0xf0 && byte <= 0xf4) {
            needed = 3;
            codePoint = byte & 0x07;
            if (byte === 0xf0) lower = 0x90;
            if (byte === 0xf4) upper = 0x8f;
        } else {
            // 0x80-0xc1, 0xf5-0xff: never a lead byte.
            out += "\ufffd";
            i += 1;
            continue;
        }

        i += 1;
        let seen = 0;
        let broken = false;
        while (seen < needed) {
            if (i >= bytes.length) {
                broken = true;
                break;
            }
            const next = bytes[i];
            if (next < lower || next > upper) {
                // The invalid byte is *not* consumed: it is re-examined as a potential lead byte.
                broken = true;
                break;
            }
            codePoint = (codePoint << 6) | (next & 0x3f);
            seen += 1;
            i += 1;
            lower = 0x80;
            upper = 0xbf;
        }
        if (broken) {
            out += "\ufffd";
            continue;
        }
        out += String.fromCodePoint(codePoint);
    }
    return out;
}

// --- deterministic inputs ---------------------------------------------------------------------

let seed = 0x51ce71;
function next() {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
}

const TEXT_UNITS = [
    () => next() % 0x80, // ASCII
    () => 0x80 + (next() % 0x700), // two-byte
    () => 0x800 + (next() % 0xd000), // three-byte, below the surrogate range
    () => 0xe000 + (next() % 0x2000), // three-byte, above it
    () => 0xd800 + (next() % 0x400), // lone high surrogate
    () => 0xdc00 + (next() % 0x400), // lone low surrogate
    () => 0x10000 + (next() % 0xfffff), // astral, encoded as a pair
    () => 0, // NUL
];

function makeText() {
    const length = next() % 10;
    let text = "";
    for (let i = 0; i < length; i += 1) {
        const pick = TEXT_UNITS[next() % TEXT_UNITS.length];
        const codePoint = pick();
        if (codePoint > 0xffff) {
            const offset = codePoint - 0x10000;
            text += String.fromCharCode(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
        } else {
            text += String.fromCharCode(codePoint);
        }
    }
    return text;
}

function makeBytes() {
    const length = next() % 14;
    const bytes = new Array(length);
    // Mix structured and random bytes so valid sequences, truncations and invalid leads all appear.
    const structured = next() % 2 === 0;
    for (let i = 0; i < length; i += 1) {
        bytes[i] = structured ? next() % 0x100 : 0x80 + (next() % 0x80);
    }
    return bytes;
}

const CASES = 1500;
for (let index = 0; index < CASES; index += 1) {
    const text = makeText();
    eq(
        Buffer.from(text).toString("hex"),
        refEncode(text)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(""),
        `encode case ${index}: ${JSON.stringify(text)}`,
    );

    const bytes = makeBytes();
    eq(
        Buffer.from(bytes).toString("utf8"),
        refDecode(bytes),
        `decode case ${index}: ${JSON.stringify(bytes)}`,
    );
}

// Hand-written edges the generator will rarely produce.
{
    eq(Buffer.from("\ud800").toString("hex"), "efbfbd", "lone high surrogate becomes U+FFFD");
    eq(Buffer.from("\udc00").toString("hex"), "efbfbd", "lone low surrogate becomes U+FFFD");
    eq(Buffer.from("\ud83d\ude00").toString("hex"), "f09f9880", "a pair becomes one code point");
    eq(
        Buffer.from([0xf0, 0x9f]).toString("utf8"),
        "\ufffd",
        "truncated four-byte lead is one replacement",
    );
    eq(
        Buffer.from([0xf0, 0x9f, 0x98]).toString("utf8"),
        "\ufffd",
        "three of four bytes is one replacement",
    );
    eq(
        Buffer.from([0xed, 0xa0, 0x80]).toString("utf8"),
        "\ufffd\ufffd\ufffd",
        "an encoded surrogate is three replacements",
    );
    eq(
        Buffer.from([0xc0, 0x80]).toString("utf8"),
        "\ufffd\ufffd",
        "an overlong NUL is two replacements",
    );
    eq(Buffer.from([0xe0, 0x80]).toString("utf8"), "\ufffd\ufffd", "an overlong two-byte prefix");
    eq(
        Buffer.from([0x61, 0xff, 0x62]).toString("utf8"),
        "a\ufffdb",
        "invalid byte is one replacement",
    );
    eq(Buffer.from([0xef, 0xbb, 0xbf, 0x61]).toString("utf8"), "\ufeffa", "Buffer keeps a BOM");
    eq(
        new TextDecoder().decode(Uint8Array.from([0xef, 0xbb, 0xbf, 0x61])),
        "a",
        "TextDecoder strips a BOM",
    );
}

if (failures.length > 0) {
    for (const failure of failures.slice(0, 20)) console.log(`not ok: ${failure}`);
    if (failures.length > 20) console.log(`not ok: ... ${failures.length - 20} more`);
    console.log(`# textcodec-differential: ${failures.length} failure(s)`);
    process.exit(1);
}
console.log(`ok: ${passed} assertions`);
