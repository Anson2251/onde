"use strict";

// `question()` writes its query once and restores the interface prompt before the callback.

const readline = require("readline");
const { PassThrough } = require("stream");

const input = new PassThrough();
const output = new PassThrough();
let written = "";
output.on("data", (chunk) => {
    written += String(chunk);
});

const rl = readline.createInterface({
    input,
    output,
    terminal: false,
    prompt: "P> ",
});

rl.question("Q? ", (answer) => {
    console.log("answer:" + answer);
    console.log("written:" + JSON.stringify(written));
    console.log("prompt-restored:" + rl.getPrompt());
    rl.close();
});

console.log("written-before:" + JSON.stringify(written));
input.write("hello\n");
