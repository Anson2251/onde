"use strict";

// Randomized differential for the Buffer operations that moved into the host: search (`indexOf`,
// `lastIndexOf`, `includes`) and comparison (`compare`, `equals`).
//
// The point is coverage of the *host* path. `buffer.oracle.js` compares our JavaScript fallback
// against Node's Buffer, so thousands of edge cases protect the JS arm; the Rust search only had a
// handful of hand-written cases in buffer.test.js. Here a naive reference implementation is written
// inside the test, and:
//
//   under onde: our Buffer (the Rust host call) must agree with the reference;
//   under node: Node's Buffer must agree with the reference, which validates the reference itself.
//
// Both arms together mean "our search agrees with Node's" for the generated cases, transitively.
// The input is a deterministic LCG, so both runtimes generate exactly the same cases.

const isLite = typeof globalThis.__ln_host === "object";
const Buffer = isLite ? require("../../../js/lib/buffer.js") : require("node:buffer").Buffer;

let passed = 0;
const failures = [];

function eq(actual, expected, message) {
    if (actual === expected) {
        passed += 1;
    } else {
        failures.push(`${message} (expected ${expected}, got ${actual})`);
    }
}

// --- the reference ----------------------------------------------------------------------------

function needleBytes(needle) {
    return typeof needle === "number" ? null : Array.from(needle);
}

// A negative offset counts from the end of the buffer, for both directions; only the default
// differs (0 forwards, the length backwards). This mirrors `toIndexOffset`/`toLastIndexOffset` in
// buffer.js, which the oracle already validated, and it is the rule Node documents.
function startOffset(offset, length) {
    let value = Math.trunc(Number(offset));
    if (!Number.isFinite(value)) value = 0;
    if (value < 0) value = Math.max(length + value, 0);
    return value;
}

function endOffset(offset, length) {
    let value = Math.trunc(Number(offset));
    if (!Number.isFinite(value)) return length;
    if (value < 0) value = length + value;
    if (value > length) value = length;
    if (value < 0) value = 0;
    return value;
}

function refIndexOf(hay, needle, offset) {
    const length = hay.length;
    const bytes = needleBytes(needle);
    const size = bytes === null ? 1 : bytes.length;
    const start = startOffset(offset, length);
    if (size === 0) return Math.min(start, length);
    if (start > length - size) return -1;
    for (let i = start; i <= length - size; i += 1) {
        let match = true;
        for (let j = 0; j < size; j += 1) {
            const expected = bytes === null ? needle & 0xff : bytes[j];
            if (hay[i + j] !== expected) {
                match = false;
                break;
            }
        }
        if (match) return i;
    }
    return -1;
}

function refCompare(a, aStart, aEnd, b, bStart, bEnd) {
    const left = Array.from(a.subarray(aStart, aEnd));
    const right = Array.from(b.subarray(bStart, bEnd));
    const length = Math.min(left.length, right.length);
    for (let i = 0; i < length; i += 1) {
        if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
    }
    if (left.length === right.length) return 0;
    return left.length < right.length ? -1 : 1;
}

function refLastIndexOf(hay, needle, offset) {
    const length = hay.length;
    const bytes = needleBytes(needle);
    const size = bytes === null ? 1 : bytes.length;
    if (size === 0) return Math.min(endOffset(offset, length), length);

    const start = Math.min(endOffset(offset, length), length - size);
    if (start < 0) return -1;
    for (let i = start; i >= 0; i -= 1) {
        let match = true;
        for (let j = 0; j < size; j += 1) {
            const expected = bytes === null ? needle & 0xff : bytes[j];
            if (hay[i + j] !== expected) {
                match = false;
                break;
            }
        }
        if (match) return i;
    }
    return -1;
}

// --- deterministic cases ----------------------------------------------------------------------

let seed = 0x2f6e2b1;
function next() {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
}

function makeHay() {
    const length = next() % 24;
    const hay = Buffer.alloc(length);
    // A four-value alphabet makes matches, near-matches and overlapping needles common; uniform
    // bytes would mostly produce -1 and test nothing.
    for (let i = 0; i < length; i += 1) hay[i] = next() % 4;
    return hay;
}

function makeNeedle() {
    const kind = next() % 3;
    if (kind === 0) {
        // A number, sometimes larger than a byte so the masking rule is exercised.
        return next() % 260;
    }
    const length = next() % 5;
    const needle = Buffer.alloc(length);
    for (let i = 0; i < length; i += 1) needle[i] = next() % 4;
    // Occasionally hand back a Uint8Array rather than a Buffer, which Node also accepts.
    return next() % 4 === 0 ? new Uint8Array(needle) : needle;
}

const COMPARE_CASES = 1500;
for (let index = 0; index < COMPARE_CASES; index += 1) {
    const left = makeHay();
    const right = makeHay();

    eq(
        left.compare(right),
        refCompare(left, 0, left.length, right, 0, right.length),
        `compare case ${index}`,
    );
    eq(Buffer.compare(left, right), left.compare(right), `static compare case ${index}`);
    eq(left.equals(right), left.compare(right) === 0, `equals case ${index}`);

    // Ranges: valid per Buffer.compare, so pick starts and ends inside each buffer.
    const leftStart = next() % (left.length + 1);
    const leftEnd = leftStart + (next() % (left.length - leftStart + 1));
    const rightStart = next() % (right.length + 1);
    const rightEnd = rightStart + (next() % (right.length - rightStart + 1));
    eq(
        left.compare(right, rightStart, rightEnd, leftStart, leftEnd),
        refCompare(left, leftStart, leftEnd, right, rightStart, rightEnd),
        `compare ranges case ${index}`,
    );
}

const CASES = 2000;
for (let index = 0; index < CASES; index += 1) {
    const hay = makeHay();
    const needle = makeNeedle();
    // Negative offsets, offsets inside the haystack and offsets past its end.
    const offset = (next() % 30) - 2;

    eq(hay.indexOf(needle, offset), refIndexOf(hay, needle, offset), `indexOf case ${index}`);
    eq(
        hay.lastIndexOf(needle, offset),
        refLastIndexOf(hay, needle, offset),
        `lastIndexOf case ${index}`,
    );
    eq(
        hay.includes(needle, offset),
        refIndexOf(hay, needle, offset) !== -1,
        `includes case ${index}`,
    );
}

// Hand-written edges the generator cannot reach reliably.
{
    const empty = Buffer.alloc(0);
    eq(empty.indexOf(""), 0, "empty haystack, empty needle");
    eq(empty.indexOf("a"), -1, "empty haystack, byte needle");
    eq(empty.lastIndexOf(""), 0, "empty haystack, empty needle, backwards");
    eq(Buffer.from("abc").indexOf("abcabc"), -1, "needle longer than haystack");
    eq(Buffer.from("abc").indexOf(""), 0, "empty needle defaults to 0");
    eq(Buffer.from("abc").indexOf("", 99), 3, "empty needle clamps to length");
    eq(Buffer.from("abc").lastIndexOf(""), 3, "empty needle backwards defaults to length");
    eq(Buffer.from("abc").lastIndexOf("", 1), 1, "empty needle backwards honours offset");
    eq(Buffer.from("aaaa").indexOf("aa", 1), 1, "overlapping needle, offset inside the match");
    eq(Buffer.from("aaaa").lastIndexOf("aa", 1), 1, "overlapping needle backwards");
    eq(Buffer.from("abc").indexOf(0x1ff), -1, "number needle is masked");
    eq(Buffer.from([0xff]).indexOf(0x1ff), 0, "masked number needle matches");
    eq(Buffer.from("ab").compare(Buffer.from("abc")), -1, "shorter prefix compares less");
    eq(Buffer.from("abc").compare(Buffer.alloc(0)), 1, "anything compares greater than empty");
    eq(Buffer.from("ab").equals(Buffer.from("ab")), true, "equals on identical buffers");
    eq(
        Buffer.from("ab").compare(Buffer.from("ab"), 0, 0, 0, 0),
        0,
        "two empty ranges compare equal",
    );
}

if (failures.length > 0) {
    for (const failure of failures.slice(0, 20)) console.log(`not ok: ${failure}`);
    if (failures.length > 20) console.log(`not ok: ... ${failures.length - 20} more`);
    console.log(`# buffer-differential: ${failures.length} failure(s)`);
    process.exit(1);
}
console.log(`ok: ${passed} assertions`);
