"use strict";

// server.close(): stops accepting, emits `close`, then calls the callback.

const net = require("net");

const server = net.createServer((socket) => socket.resume());
server.on("close", () => console.log("event: close"));
server.on("listening", () => console.log("event: listening"));
server.listen(0, "127.0.0.1", () => {
  console.log("listening: " + server.listening);
  server.close(() => {
    console.log("callback: closed");
    console.log("listening-after: " + server.listening);
    console.log("address-after: " + server.address());
  });
});
