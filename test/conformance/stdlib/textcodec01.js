"use strict";
const encoder = new TextEncoder();
console.log(encoder.encoding, encoder.encode("é").join(","));
const decoder = new TextDecoder();
console.log(decoder.decode(new Uint8Array([104, 105])));
const split = new TextDecoder();
console.log(split.decode(new Uint8Array([0xc3]), { stream: true }) + split.decode(new Uint8Array([0xa9])));
