"use strict";

// `allowHalfOpen: true`: the server keeps its writable side open after the client's FIN, sends a
// late answer, and only then ends. This is the ordering a proxy needs.

const net = require("net");

const serverEvents = [];
const server = net.createServer({ allowHalfOpen: true }, (socket) => {
  serverEvents.push("connection");
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => serverEvents.push(`data:${chunk}`));
  socket.on("end", () => {
    serverEvents.push("end");
    socket.end("bye");
  });
  socket.on("close", () => {
    serverEvents.push("close");
    console.log(`server:${serverEvents.join(",")}`);
    server.close();
  });
});
server.listen(0, "127.0.0.1", () => {
  const clientEvents = ["connect"];
  const client = net.connect(server.address().port, "127.0.0.1", () => client.end("hi"));
  client.setEncoding("utf8");
  client.on("data", (chunk) => clientEvents.push(`data:${chunk}`));
  client.on("end", () => clientEvents.push("end"));
  client.on("close", () => {
    clientEvents.push("close");
    console.log(`client:${clientEvents.join(",")}`);
  });
});
