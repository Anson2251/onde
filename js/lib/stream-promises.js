"use strict";

// `stream/promises` — promise forms of `pipeline` and `finished` (docs/compat.md Tier 1
// `stream` row). The callback implementations live in `js/lib/stream.js`; this module only
// adapts them so both entry points stay in lock-step (no duplicated pipeline/finished logic).
//
// Node semantics:
//   * `pipeline(...streams[, options])` resolves `undefined`, rejects on the first error and
//     destroys every stream in the chain.
//   * `finished(stream[, options])` resolves `undefined`, rejects with the stream error, and
//     supports `{ signal }`, `{ error }`, `{ readable }`, `{ writable }` and `{ cleanup }`.
//     An already-aborted signal rejects with `AbortError` whose `code` is `ABORT_ERR`.

const { pipeline: callbackPipeline, finished: callbackFinished } = require("./stream.js");

function isPlainOptions(value) {
  if (value === null || typeof value !== "object") return false;
  if (typeof value.pipe === "function" || typeof value.write === "function") return false;
  if (typeof value[Symbol.asyncIterator] === "function") return false;
  if (typeof value[Symbol.iterator] === "function") return false;
  return true;
}

function pipeline(...streams) {
  return new Promise((resolve, reject) => {
    let options;
    if (streams.length > 0 && isPlainOptions(streams[streams.length - 1])) {
      options = streams.pop();
    }
    const callback = function onPipelineDone(err) {
      if (err) reject(err);
      else resolve(undefined);
    };
    if (options === undefined) callbackPipeline(...streams, callback);
    else callbackPipeline(...streams, options, callback);
  });
}

function finished(stream, options) {
  return new Promise((resolve, reject) => {
    const opts = options === undefined || options === null ? {} : options;
    let autoCleanup = false;
    if (opts.cleanup !== undefined) {
      if (typeof opts.cleanup !== "boolean") {
        const err = new TypeError(
          `The "options.cleanup" property must be of type boolean. Received ${typeof opts.cleanup}`,
        );
        err.code = "ERR_INVALID_ARG_TYPE";
        throw err;
      }
      autoCleanup = opts.cleanup;
    }
    const cleanup = callbackFinished(stream, opts, (err) => {
      if (autoCleanup) cleanup();
      if (err) reject(err);
      else resolve(undefined);
    });
  });
}

module.exports = { pipeline, finished };
