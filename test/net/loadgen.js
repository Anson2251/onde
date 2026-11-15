"use strict";

// Keep-alive load generator for test/net/bench.sh.
//
//   node loadgen.js <port-file> <connections> <warmup-per-connection> <requests-per-connection>
//
// Opens <connections> sockets through one http.Agent, runs the warm-up (discarded), then measures
// every request on those sockets. Latency is per request (start of request until the response
// `'end'`), and the rate is measured over the whole measured phase, so it includes event-loop
// queueing the way the server actually sees load. Prints one RESULT line; exits 1 on any request
// error or when the requested connection count was not reached.

const fs = require("fs");
const http = require("http");

const port = Number(fs.readFileSync(process.argv[2], "utf8"));
const connections = Number(process.argv[3] || 100);
const warmup = Number(process.argv[4] || 20);
const requests = Number(process.argv[5] || 500);

const agent = new http.Agent({ keepAlive: true, maxSockets: connections });
const sockets = new Set();
const latencies = new Float64Array(connections * requests);
let slot = 0;
let errors = 0;
const errorCodes = {};

function oneRequest() {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const req = http.get({ host: "127.0.0.1", port, path: "/", agent }, (res) => {
      res.resume();
      res.on("end", () => {
        const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
        latencies[slot] = elapsed;
        slot += 1;
        resolve();
      });
    });
    req.on("socket", (socket) => sockets.add(socket));
    req.on("error", (error) => {
      errors += 1;
      const code = error && error.code ? error.code : "unknown";
      errorCodes[code] = (errorCodes[code] || 0) + 1;
      resolve();
    });
  });
}

async function worker(count) {
  for (let i = 0; i < count; i += 1) await oneRequest();
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index];
}

async function main() {
  await Promise.all(Array.from({ length: connections }, () => worker(warmup)));
  slot = 0;

  const startedAt = process.hrtime.bigint();
  await Promise.all(Array.from({ length: connections }, () => worker(requests)));
  const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;

  const total = connections * requests;
  const measured = latencies.subarray(0, slot);
  const sorted = Array.from(measured).sort((a, b) => a - b);
  const rps = total / seconds;

  console.log(
    `RESULT connections=${sockets.size} requests=${total} seconds=${seconds.toFixed(3)} ` +
      `rps=${rps.toFixed(1)} p50_ms=${percentile(sorted, 0.5).toFixed(3)} ` +
      `p99_ms=${percentile(sorted, 0.99).toFixed(3)} errors=${errors} ` +
      `error_codes=${JSON.stringify(errorCodes)}`,
  );

  agent.destroy();
  if (errors !== 0 || sockets.size !== connections) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`loadgen: ${error && error.code ? error.code : error}`);
  agent.destroy();
  process.exit(1);
});
