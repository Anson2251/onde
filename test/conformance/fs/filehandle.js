"use strict";
// fs/promises: FileHandle read/write/stat, close idempotence and EBADF after close.
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "conf-fs-fh-"));
  const file = path.join(dir, "f.txt");
  await fsp.writeFile(file, "0123456789");

  const handle = await fsp.open(file, "r+");
  console.log("fd", typeof handle.fd === "number" && handle.fd > 2);
  const wrote = await handle.write(Buffer.from("XY"), 0, 2, 0);
  console.log("write", wrote.bytesWritten, wrote.buffer instanceof Uint8Array);
  const read = await handle.read(Buffer.alloc(4), 1, 2, 1);
  console.log("read", read.bytesRead, read.buffer.toString("utf8", 1, 3));
  console.log("stat", (await handle.stat()).isFile(), (await handle.stat()).size);
  await handle.truncate(4);
  console.log("truncate", (await handle.stat()).size);
  await handle.close();
  console.log("closed-fd", handle.fd);
  console.log("double-close", await handle.close());

  const statAfterClose = await handle.stat().then(() => "resolved", (error) => error.code);
  const readAfterClose = await handle.read(Buffer.alloc(1), 0, 1, 0).then(() => "resolved", (error) => error.code);
  console.log("after-close", statAfterClose, readAfterClose);

  const reader = await fsp.open(file, "r");
  const text = await new Promise((resolve, reject) => {
    let collected = "";
    const stream = reader.createReadStream({ start: 0, end: 1 });
    stream.on("data", (chunk) => (collected += chunk));
    stream.on("end", () => resolve(collected));
    stream.on("error", reject);
  });
  const streamStat = await reader.stat().then(() => "open", (error) => error.code);
  console.log("handle-stream", text, streamStat);
  await reader.close();

  await fsp.rm(dir, { recursive: true, force: true });
})();
