"use strict";

// One pending next() per line keeps the expectation independent of when the stream schedules
// its data events: each line is written after the read is already waiting.

const readline = require("readline");
const { PassThrough } = require("stream");

async function main() {
  const input = new PassThrough();
  const rl = readline.createInterface({
    input,
    output: new PassThrough(),
    terminal: false,
  });
  const iterator = rl[Symbol.asyncIterator]();

  const first = iterator.next();
  input.write("x\n");
  console.log("line:" + (await first).value);

  const second = iterator.next();
  input.end("y\n");
  console.log("line:" + (await second).value);

  const done = await iterator.next();
  console.log("done:" + done.done);
}

main();
