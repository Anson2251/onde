"use strict";

// `cp -r` clone for the M3 acceptance suite. Uses `lstat`, `readdir`, `mkdir`, `copyFile`,
// `readlink`/`symlink` and `chmod`, plus the recursion a real copy needs.
//   cp.js [-r] source destination

const fs = require("fs");
const path = require("path");

const recursive = process.argv[2] === "-r";
const args = recursive ? process.argv.slice(3) : process.argv.slice(2);
if (args.length !== 2) {
  console.error("usage: cp.js [-r] source destination");
  process.exit(1);
}

function copyTree(source, destination) {
  const stats = fs.lstatSync(source);
  if (stats.isDirectory()) {
    if (!recursive) throw new Error(`${source} is a directory (use -r)`);
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(source)) {
      copyTree(path.join(source, name), path.join(destination, name));
    }
    return;
  }
  if (stats.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), destination);
    return;
  }
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, stats.mode & 0o777);
}

try {
  copyTree(args[0], args[1]);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
