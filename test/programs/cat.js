"use strict";

// `cat` clone for the M3 acceptance suite: reads files in order, or stdin when none are given.
// Uses only the public `fs`/`stream`/`process` surface, so it exercises `createReadStream`,
// backpressure, async iteration and `process.stdin`/`stdout` together.

const fs = require("fs");

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    for await (const chunk of process.stdin) {
      process.stdout.write(chunk);
    }
    return;
  }
  for (const file of files) {
    for await (const chunk of fs.createReadStream(file)) {
      process.stdout.write(chunk);
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
