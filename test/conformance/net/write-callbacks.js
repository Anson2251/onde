"use strict";

// Write callbacks run in queue order, before `finish`, and `end(callback)` runs on `finish`.

const net = require("net");

const events = [];
const server = net.createServer((socket) => {
  let received = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    received += chunk;
  });
  socket.on("end", () => console.log(`server:${received}`));
});
server.listen(0, "127.0.0.1", () => {
  const client = net.connect(server.address().port, "127.0.0.1", () => {
    client.write("a", () => events.push("write-a"));
    client.write("b", () => events.push("write-b"));
    client.end("c", () => events.push("end-callback"));
  });
  client.on("finish", () => events.push("finish"));
  client.on("close", () => {
    events.push("close");
    setTimeout(() => {
      console.log(`client:${events.join(",")}`);
      server.close();
    }, 10);
  });
});
