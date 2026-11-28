"use strict";

// Terminal history is newest-first, capped at historySize, duplicates moved to the front.

const readline = require("readline");
const { PassThrough } = require("stream");

const input = new PassThrough();
const output = new PassThrough();
const rl = readline.createInterface({
    input,
    output,
    terminal: true,
    historySize: 2,
    removeHistoryDuplicates: true,
});

rl.on("line", (line) => {
    console.log("line:" + line + " history:" + rl.history.join(","));
});

input.write("a\n");
input.write("a\n");
input.write("b\n");
input.write("a\n");
input.end();
