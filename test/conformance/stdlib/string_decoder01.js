"use strict";
const { Buffer } = require("buffer");
const { StringDecoder } = require("string_decoder");
const decoder = new StringDecoder("utf8");
let text = "";
for (const byte of Buffer.from("héllo")) {
  text += decoder.write(Buffer.from([byte]));
}
text += decoder.end();
console.log(text);
