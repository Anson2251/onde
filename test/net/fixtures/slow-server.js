"use strict";

// Slow-loris server for test/net/slowloris.sh. `maxHeaderSize` stays at the Node default (16 KiB)
// so the 431 probe exercises the real limit. A high backlog lets thousands of half-open
// connections queue without the OS refusing the probe connection.

const fs = require("fs");
const http = require("http");

const server = http.createServer({ maxHeaderSize: 16384 }, (req, res) => res.end("ok"));
server.on("clientError", () => {
  // Half-open peers are expected; the runtime owns the canned error response (D42).
});

server.on("error", (error) => {
  console.error(`slow-server: ${error.code || error.message}`);
  process.exit(1);
});

server.listen({ port: 0, host: "127.0.0.1", backlog: 4096 }, () => {
  fs.writeFileSync(process.argv[2], String(server.address().port));
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
