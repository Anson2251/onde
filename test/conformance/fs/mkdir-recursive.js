"use strict";
// fs: recursive mkdir reports the first created path, and undefined when nothing was created.
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conf-fs-mkdir-"));
const file = path.join(dir, "file.txt");
fs.writeFileSync(file, "");

const first = fs.mkdirSync(path.join(dir, "a/b/c"), { recursive: true });
console.log("first", first === path.join(dir, "a"));
console.log("again", fs.mkdirSync(path.join(dir, "a/b/c"), { recursive: true }) === undefined);
console.log("existing", fs.mkdirSync(dir, { recursive: true }) === undefined);

try {
    fs.mkdirSync(file, { recursive: true });
} catch (error) {
    console.log("file", error.code);
}

fs.mkdir(path.join(dir, "cb/deep"), { recursive: true }, (error, created) => {
    console.log("callback", error, created === path.join(dir, "cb"));
    fs.rmSync(dir, { recursive: true, force: true });
});
