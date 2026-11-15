"use strict";

// Connection churn for test/net/fdleak.sh: open, connect, send FIN, close. A bounded number are
// in flight at once so the client itself does not need tens of thousands of fds. Half-open
// (immediate destroy) produces RSTs that race the server's accept; a graceful FIN is the
// disconnect shape the leak criterion is about.
//
//   node connect-cycles.js <port-file> <cycles>
//   NET_CONCURRENCY=50 (default)

const fs = require("fs");
const net = require("net");

const port = Number(fs.readFileSync(process.argv[2], "utf8"));
const cycles = Number(process.argv[3] || 10000);
const concurrency = Number(process.env.NET_CONCURRENCY || 50);

let started = 0;
let completed = 0;
let errors = 0;
const errorCodes = {};

// A connect that never completes would wait forever here (zero CPU, no error), so each connection
// gets a deadline and a code the summary can report. Back-to-back runs are fine: three in a row
// finished in 3, 4 and 6 seconds, because each run's server has a new port and closed sockets in
// TIME_WAIT do not block a different destination.
const connectTimeoutMs = Number(process.env.NET_CONNECT_TIMEOUT_MS || 15000);

function one() {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      completed += 1;
      resolve();
    };
    socket.setTimeout(connectTimeoutMs, () => {
      errors += 1;
      errorCodes.ETIMEDOUT = (errorCodes.ETIMEDOUT || 0) + 1;
      socket.destroy();
    });
    socket.on("connect", () => {
      socket.setTimeout(0);
      socket.end();
    });
    socket.on("error", (error) => {
      // A connection destroyed by its owner may observe the peer's RST; churn is the point.
      errors += 1;
      errorCodes[error.code] = (errorCodes[error.code] || 0) + 1;
    });
    socket.on("close", done);
  });
}

async function worker() {
  while (started < cycles) {
    started += 1;
    await one();
  }
}

Promise.all(Array.from({ length: concurrency }, worker)).then(() => {
  console.log(`cycles=${completed} errors=${errors} ${JSON.stringify(errorCodes)}`);
  if (errorCodes.ETIMEDOUT !== undefined) {
    console.error(
      "connect-cycles: connections timed out; the ephemeral port range is saturated by the " +
        "previous run's TIME_WAIT sockets, so wait about 30 s before running fdleak again",
    );
  }
  process.exit(completed === cycles ? 0 : 1);
});
