"use strict";

// IPv6 loopback: bind `::1`, connect, and check the accepted socket's family. If the platform has
// no usable loopback the case prints one skip line instead of failing (CI has IPv6 on both OSes).

const net = require("net");

const server = net.createServer((socket) => {
  socket.end(`family:${socket.remoteFamily}`);
});

server.on("error", () => {
  console.log("skip:ipv6-unavailable");
});

server.listen(0, "::1", () => {
  const address = server.address();
  console.log(`listening:${address.address}:${address.family}`);
  const client = net.connect(address.port, "::1", () => client.end());
  client.setEncoding("utf8");
  let data = "";
  client.on("data", (chunk) => {
    data += chunk;
  });
  client.on("close", () => {
    console.log(`data:${data}`);
    server.close();
  });
});
