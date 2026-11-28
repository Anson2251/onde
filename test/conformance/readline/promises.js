"use strict";

// `readline/promises`: question() resolves with the answer and restores the prompt.

const readline = require("readline/promises");
const { PassThrough } = require("stream");

async function main() {
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

    const pending = rl.question("Q? ");
    input.write("hello\n");
    const answer = await pending;
    console.log("answer:" + answer);
    console.log("written:" + JSON.stringify(written));
    console.log("prompt-restored:" + rl.getPrompt());
    rl.close();
}

main();
