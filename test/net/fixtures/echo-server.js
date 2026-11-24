"use strict";

// TCP echo server for test/perf/echo.sh. Binds 127.0.0.1:0, writes the port to <port-file>, and
// echoes every chunk back on the same socket.
//
// It is deliberately the smallest possible `net` program: the ratio it feeds compares the runtimes'
// TCP paths, so a cleverer fixture would measure the fixture.

const fs = require("fs");
const net = require("net");

const server = net.createServer((socket) => {
  socket.on("data", (chunk) => {
    socket.write(chunk);
  });
  socket.on("error", () => {});
});

server.on("error", (error) => {
  console.error(`echo-server: ${error.code || error.message}`);
  process.exit(1);
});

server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(process.argv[2], String(server.address().port));
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
