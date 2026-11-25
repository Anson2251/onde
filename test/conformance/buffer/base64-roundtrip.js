"use strict";
// Base64 round trips through Buffer's codec seam (`internal/bytes.js`): every tail length, both
// alphabets, and the `start`/`end` window `toString` takes. Results print as hex so the comparison
// is byte-exact and node and onde cannot agree on a wrong string.

const { Buffer } = require("buffer");

const pattern = Buffer.from(Array.from({ length: 40 }, (_, index) => (index * 37 + 11) & 0xff));

for (let length = 0; length <= 12; length++) {
  const slice = pattern.subarray(0, length);
  const standard = slice.toString("base64");
  const url = slice.toString("base64url");
  const back = Buffer.from(standard, "base64").toString("hex");
  const backUrl = Buffer.from(url, "base64url").toString("hex");
  console.log(`${length} ${JSON.stringify(standard)} ${JSON.stringify(url)} ${back} ${backUrl}`);
}

// A 40-byte body exercises every residue class past the first block.
console.log(`body ${pattern.toString("base64")}`);
console.log(`body-url ${pattern.toString("base64url")}`);
console.log(`body-back ${Buffer.from(pattern.toString("base64"), "base64").equals(pattern)}`);

// `Buffer#toString` keeps start/end in JS and passes the view plus the range to the host.
console.log(`range one ${pattern.toString("base64", 0, 1)}`);
console.log(`range two ${pattern.toString("base64", 3, 5)}`);
console.log(`range all ${pattern.toString("base64", 0, pattern.length)}`);
console.log(`range none ${JSON.stringify(pattern.toString("base64", 7, 7))}`);
console.log(`range reversed ${JSON.stringify(pattern.toString("base64", 9, 3))}`);
console.log(`range past end ${pattern.toString("base64", 35, 999)}`);
console.log(`range negative ${pattern.toString("base64", -4, 2)}`);

// Both alphabets decode whichever flag was requested, as Node does.
for (const encoding of ["base64", "base64url"]) {
  for (const text of ["+/8=", "-_8", "-_8=", "+/8", "-_8==", "+/8=="]) {
    console.log(`${encoding} ${text} ${Buffer.from(text, encoding).toString("hex")}`);
  }
}

// Every 1- and 2-byte tail, which is where the padding branches live.
for (const byte of [0x00, 0x01, 0x0f, 0x40, 0xfb, 0xff]) {
  const one = Buffer.from([byte]);
  const two = Buffer.from([byte, byte ^ 0x5a]);
  console.log(
    `tails ${byte} ${one.toString("base64")} ${one.toString("base64url")} ` +
      `${two.toString("base64")} ${two.toString("base64url")} ` +
      `${Buffer.from(one.toString("base64"), "base64").toString("hex")} ` +
      `${Buffer.from(two.toString("base64url"), "base64url").toString("hex")}`,
  );
}
