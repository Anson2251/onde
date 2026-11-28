"use strict";
// fs: createReadStream ranges and createWriteStream output.
const fs = require("fs");
const os = require("os");
const path = require("path");

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conf-fs-stream-"));
    const file = path.join(dir, "in.txt");
    fs.writeFileSync(file, "0123456789");

    const ranged = await new Promise((resolve, reject) => {
        let text = "";
        const stream = fs.createReadStream(file, { start: 2, end: 5, encoding: "utf8" });
        stream.on("data", (chunk) => (text += chunk));
        stream.on("end", () => resolve(text));
        stream.on("error", reject);
    });
    console.log("range", ranged);

    const out = path.join(dir, "out.txt");
    await new Promise((resolve, reject) => {
        const stream = fs.createWriteStream(out);
        stream.on("error", reject);
        stream.on("close", resolve);
        stream.end("written");
    });
    console.log("write", fs.readFileSync(out, "utf8"));

    fs.writeFileSync(file, "x".repeat(200000));
    const size = await new Promise((resolve, reject) => {
        let total = 0;
        const stream = fs.createReadStream(file);
        stream.on("data", (chunk) => (total += chunk.length));
        stream.on("end", () => resolve(total));
        stream.on("error", reject);
    });
    console.log("chunked", size);

    fs.rmSync(dir, { recursive: true, force: true });
})();
