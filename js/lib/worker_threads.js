"use strict";

// `worker_threads` — a worker is a nested isolate on its own thread (M5, ADR-0008 §2.1).
//
// The implementation lives in `internal/worker.js` because `bootstrap.js` must load it eagerly on
// a worker isolate: the parent can send a message before user code requires this module, and that
// message has to be queued for `parentPort` rather than dropped.

const EMBEDDED = typeof __filename === "string" && __filename.startsWith("<lite:");

function requireInternal(name, relative) {
  if (EMBEDDED) return require(name);
  return require(relative);
}

module.exports = requireInternal("internal/worker", "./internal/worker.js");
