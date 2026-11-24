"use strict";

// `worker_threads` — a worker is a nested isolate on its own thread (M5, ADR-0008 §2.1).
//
// The implementation lives in `internal/worker.js` because `bootstrap.js` must load it eagerly on
// a worker isolate: the parent can send a message before user code requires this module, and that
// message has to be queued for `parentPort` rather than dropped.

module.exports = require("./internal/worker.js");
