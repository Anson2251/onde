"use strict";

// `end(chunk)` after `end()` is a write after end: Node emits ERR_STREAM_WRITE_AFTER_END on the
// socket (asynchronously, after `end()` returns) and still closes exactly once.

const net = require("net");

const clientEvents = [];
const server = net.createServer((socket) => {
  socket.resume();
});
server.listen(0, "127.0.0.1", () => {
  const client = net.connect(server.address().port, "127.0.0.1", () => {
    client.end("a");
    client.end("b");
    clientEvents.push("ends-returned");
  });
  client.on("finish", () => clientEvents.push("finish"));
  client.on("error", (error) => clientEvents.push(`error:${error.code}`));
  client.on("close", () => {
    clientEvents.push("close");
    setTimeout(() => {
      console.log(`client:${clientEvents.join(",")}`);
      server.close();
    }, 10);
  });
});
