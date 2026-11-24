"use strict";

// Raw TCP server for the slow-loris floor measurement (test/net/slowloris.sh, raw mode).
//
// It accepts connections, consumes whatever arrives and answers nothing. That is the floor the
// HTTP server is compared against: same sockets, same kernel buffers, no HTTP layer and no JS
// session state. The difference between the two numbers is what the HTTP layer costs per
// half-open connection, which is the number m7-plan §6.1 re-specifies the bound against.

const fs = require("fs");
const net = require("net");

const server = net.createServer((socket) => {
  socket.on("data", () => {});
  socket.on("error", () => {});
});

server.on("error", (error) => {
  console.error(`raw-server: ${error.code || error.message}`);
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
