"use strict";

// A Unix-domain socket: `listen(path)` reports the path from `address()`, `connect(path)` works,
// and the accepted socket reports `remoteAddress` as undefined. The path is unique per process
// and never printed, so concurrent suites cannot collide.

const fs = require("fs");
const net = require("net");
const path = `${require("os").tmpdir()}/ln-unix-${process.pid}.sock`;

try {
  fs.unlinkSync(path);
} catch {}

const server = net.createServer((socket) => {
  console.log(`remote-address:${String(socket.remoteAddress)}`);
  socket.end("unix-ok");
});
server.listen(path, () => {
  console.log(`address-is-path:${server.address() === path}`);
  const client = net.connect(path, () => client.end());
  let data = "";
  client.setEncoding("utf8");
  client.on("data", (chunk) => {
    data += chunk;
  });
  client.on("close", () => {
    console.log(`data:${data}`);
    server.close(() => {
      try {
        fs.unlinkSync(path);
      } catch {}
    });
  });
});
