"use strict";
// fs: AbortSignal delivery, callback and promise forms (already-aborted signal is deterministic).
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conf-fs-abort-"));
  const file = path.join(dir, "f.txt");
  fs.writeFileSync(file, "data");

  const controller = new AbortController();
  controller.abort();
  const promiseError = await fsp.readFile(file, { signal: controller.signal }).then(() => null, (error) => error);
  console.log("promise", promiseError.code, promiseError.name);

  const callbackController = new AbortController();
  callbackController.abort();
  const callbackError = await new Promise((resolve) => {
    fs.readFile(file, { signal: callbackController.signal }, (error) => resolve(error));
  });
  console.log("callback", callbackError.code, callbackError.name);

  fs.rmSync(dir, { recursive: true, force: true });
})();
