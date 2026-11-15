"use strict";

// `write(string, encoding)` honours the encoding argument: latin1 sends one byte per code unit,
// so "héllo" is 5 bytes on the wire, not the 6 a UTF-8 encoding would produce.

const net = require("net");

const server = net.createServer((socket) => {
  let bytes = 0;
  socket.on("data", (chunk) => {
    bytes += chunk.length;
  });
  socket.on("end", () => {
    console.log(`server-bytes:${bytes}`);
  });
});
server.listen(0, "127.0.0.1", () => {
  const client = net.connect(server.address().port, "127.0.0.1", () => client.end("héllo", "latin1"));
  client.on("close", () => server.close());
});
