"use strict";

// Connection-churn server for test/net/fdleak.sh: accepts, swallows errors, and never keeps
// application state per socket, so an fd or memory leak is the runtime's, not the handler's.

const fs = require("fs");
const net = require("net");

const server = net.createServer((socket) => {
  socket.on("error", () => {});
  socket.resume();
});

server.on("error", (error) => {
  console.error(`fd-server: ${error.code || error.message}`);
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
