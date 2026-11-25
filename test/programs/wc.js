"use strict";

// `wc` clone for the M3 acceptance suite: counts lines, words and bytes from streams.
//   wc.js [-l] [-w] [-c] file...
// Default is `lines words bytes`, one line per file. Output is compared between Node and onde
// running the same program, so the format is ours, not system `wc`'s.

const fs = require("fs");

const argv = process.argv.slice(2);
const flags = new Set();
const files = [];
for (const arg of argv) {
  if (arg === "-l" || arg === "-w" || arg === "-c") flags.add(arg);
  else if (arg.startsWith("-") && arg.length > 1) {
    for (const ch of arg.slice(1)) {
      if (ch === "l" || ch === "w" || ch === "c") flags.add(`-${ch}`);
      else {
        console.error(`wc: invalid option -- '${ch}'`);
        process.exit(1);
      }
    }
  } else files.push(arg);
}
if (flags.size === 0) {
  flags.add("-l");
  flags.add("-w");
  flags.add("-c");
}

function count(text) {
  const lines = text.split("\n").length - 1 + (text.length > 0 && !text.endsWith("\n") ? 1 : 0);
  const words = text.split(/\s+/).filter(Boolean).length;
  return { lines, words, bytes: Buffer.byteLength(text) };
}

async function main() {
  for (const file of files) {
    let content = "";
    for await (const chunk of fs.createReadStream(file, { encoding: "utf8" })) {
      content += chunk;
    }
    const counts = count(content);
    const parts = [];
    if (flags.has("-l")) parts.push(counts.lines);
    if (flags.has("-w")) parts.push(counts.words);
    if (flags.has("-c")) parts.push(counts.bytes);
    parts.push(file);
    process.stdout.write(`${parts.join(" ")}\n`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
