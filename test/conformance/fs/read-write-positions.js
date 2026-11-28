"use strict";
// fs: positional read/write on descriptors, EOF, readv and writev.
const fs = require("fs");
const os = require("os");
const path = require("path");

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conf-fs-pos-"));
    const file = path.join(dir, "f.txt");
    fs.writeFileSync(file, "0123456789");

    const fd = fs.openSync(file, "r+");
    console.log("write", fs.writeSync(fd, Buffer.from("XY"), 0, 2, 0));
    console.log("write-string", fs.writeSync(fd, "Z", 2));
    const buffer = Buffer.alloc(4);
    const read = fs.readSync(fd, buffer, 1, 2, 1);
    console.log("read", read, buffer.toString("utf8", 0, 4).replace(/\0/g, "_"));
    console.log("readv", fs.readvSync(fd, [Buffer.alloc(2), Buffer.alloc(2)], 0));
    console.log("writev", fs.writevSync(fd, [Buffer.from("AB")], 0));
    const copy = Buffer.alloc(2);
    const callback = await new Promise((resolve) => {
        fs.read(fd, copy, 0, 2, 4, (error, bytes) =>
            resolve(`${error}:${bytes}:${copy.toString("utf8")}`),
        );
    });
    console.log("read-callback", callback);
    fs.closeSync(fd);

    const readOnly = fs.openSync(file, "r");
    console.log("eof", fs.readSync(readOnly, Buffer.alloc(2), 0, 2, 100));
    fs.closeSync(readOnly);
    console.log("content", fs.readFileSync(file, "utf8"));

    fs.rmSync(dir, { recursive: true, force: true });
})();
