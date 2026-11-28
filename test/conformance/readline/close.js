"use strict";

// close() is idempotent and observable through `closed` and a single `close` event.

const readline = require("readline");
const { PassThrough } = require("stream");

const input = new PassThrough();
const rl = readline.createInterface({
    input,
    output: new PassThrough(),
    terminal: false,
});

let closes = 0;
rl.on("close", () => {
    closes += 1;
});

rl.close();
rl.close();
console.log("closed:" + rl.closed);
console.log("closes:" + closes);
console.log("line:" + JSON.stringify(rl.line));
