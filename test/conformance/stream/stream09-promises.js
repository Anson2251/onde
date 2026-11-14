"use strict";
// stream/promises: pipeline resolves undefined; finished resolves undefined and honours signals.
const { pipeline, finished } = require("stream/promises");
const { Readable, Writable } = require("stream");

(async () => {
  const out = [];
  const dest = new Writable({
    write(chunk, encoding, callback) {
      out.push(String(chunk));
      callback();
    },
  });
  const resolved = await pipeline(Readable.from(["a", "b"]), dest);
  console.log("pipeline", resolved === undefined, out.join(""));

  const readable = Readable.from(["z"]);
  readable.resume();
  const done = await finished(readable);
  console.log("finished", done === undefined);

  const controller = new AbortController();
  controller.abort();
  const pre = new Readable({ read() {} });
  pre.on("error", () => {});
  try {
    await finished(pre, { signal: controller.signal });
  } catch (error) {
    console.log("aborted", error.name, error.code);
  }
  pre.destroy();
})();
