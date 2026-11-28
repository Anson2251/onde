"use strict";

// Piped, chunked input: LF, CRLF split across chunks, and an unterminated tail.

const readline = require("readline");
const { PassThrough } = require("stream");

const input = new PassThrough();
const output = new PassThrough();
const rl = readline.createInterface({
    input,
    output,
    terminal: false,
    crlfDelay: 100,
});

rl.on("line", (line) => console.log("line:" + JSON.stringify(line)));
rl.on("close", () => console.log("close"));

input.write("a\n");
input.write("b\r");
input.write("\nc");
input.end();
