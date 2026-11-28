"use strict";
// The base64/hex rules Node's decoders actually implement, including the ones that look like
// bugs: characters outside the alphabet are skipped, padding ends the input, an odd hex digit is
// dropped, and each UTF-16 code unit is masked to a byte before the lookup. Printed as hex so a
// difference in any single byte fails the comparison.

const { Buffer } = require("buffer");

function decode(label, text, encoding) {
    const out = Buffer.from(text, encoding);
    console.log(`${label}: ${out.length} ${out.toString("hex")}`);
}

decode("empty base64", "", "base64");
decode("empty hex", "", "hex");
decode("base64 one char", "A", "base64");
decode("base64 two chars", "AB", "base64");
decode("base64 three chars", "ABC", "base64");
decode("base64 four chars", "ABCD", "base64");
decode("base64 whitespace", "aGVs bG8=\n\t", "base64");
decode("base64 punctuation", "QUJD!?RA==", "base64");
decode("base64 stops at padding", "QQ==QUJD", "base64");
decode("base64 only padding", "====", "base64");
decode("base64 invalid only", "*x", "base64");
decode("base64 url-safe under base64", "-_8", "base64");
decode("base64 standard under base64url", "+/8=", "base64url");
decode("hex odd digit", "abc", "hex");
decode("hex uppercase", "ABCDEF", "hex");
decode("hex stops at a pair", "12zz34", "hex");
decode("hex bad first pair", "0g00", "hex");
decode("hex empty tail", "ab0", "hex");

// Recorded against an official Node build. Homebrew's node devendors V8's simdutf, which changes
// this conversion (docs/internals.md §3); that is a distributor difference, not this runtime's.
// Node masks a UTF-16 code unit to one byte, so non-ASCII text can still be a digit.
decode("hex latin-1 masking", "\u01610", "hex");
decode("hex astral masking", "ab\u{1f4a9}cd", "hex");
decode("base64 latin-1 masking", "QU\u0161JD", "base64");
decode("base64 lone surrogate", "QU\uD83DJD", "base64");
decode("base64 lone low surrogate", "QU\uDC00JD", "base64");
decode("base64 astral", "QU\u{1f4a9}JD", "base64");
decode("base64 lone surrogate first", "\uD83DQUJD", "base64");

// Encode edges: empty, every tail length, and lowercase hex.
for (const sample of [[], [0x00], [0x0f], [0xff], [0xff, 0xff], [0xfb, 0xff], [0x41, 0x42, 0x43]]) {
    const buffer = Buffer.from(sample);
    console.log(
        `encode ${buffer.length} ${JSON.stringify(buffer.toString("hex"))} ` +
            `${JSON.stringify(buffer.toString("base64"))} ` +
            `${JSON.stringify(buffer.toString("base64url"))}`,
    );
}

// `toString` range handling: Buffer clamps, then the host encodes the borrowed window.
const wide = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
console.log(`hex range ${wide.toString("hex", 1, 4)}`);
console.log(`hex reversed ${JSON.stringify(wide.toString("hex", 5, 2))}`);
console.log(`hex past end ${wide.toString("hex", 6, 99)}`);
console.log(`hex negative ${wide.toString("hex", -3, 3)}`);
console.log(`base64 range ${wide.toString("base64", 2, 7)}`);
console.log(`base64url range ${wide.toString("base64url", 0, 8)}`);

// A Buffer subclass instance and a plain Uint8Array both reach the same host entry point.
const view = new Uint8Array(wide.buffer, wide.byteOffset + 2, 4);
console.log(
    `uint8 view hex ${Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("hex")}`,
);
console.log(`write+read ${Buffer.from([1, 2, 3]).toString("hex")}`);
