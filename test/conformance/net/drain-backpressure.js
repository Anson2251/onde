"use strict";

// Backpressure: a 1 MiB write exceeds the 16 KiB highWaterMark, so `write()` returns false and
// `'drain'` follows; every byte still arrives intact.

const net = require("net");

const payload = Buffer.alloc(1024 * 1024);
for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;

const server = net.createServer((socket) => {
  let received = 0;
  socket.on("data", (chunk) => {
    received += chunk.length;
  });
  socket.on("end", () => {
    console.log(`server-received:${received}`);
  });
});
server.listen(0, "127.0.0.1", () => {
  const client = net.connect(server.address().port, "127.0.0.1", () => {
    console.log(`write-returned:${client.write(payload)}`);
    client.on("drain", () => {
      console.log("drain");
      client.end();
    });
  });
  client.on("close", () => {
    console.log("closed");
    server.close();
  });
});
