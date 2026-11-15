"use strict";

// `destroy(error)` emits the user's error once and then one `close`; `destroyed` is already true
// when the error callback runs.

const net = require("net");

const events = [];
const server = net.createServer((socket) => socket.resume());
server.listen(0, "127.0.0.1", () => {
  const client = net.connect(server.address().port, "127.0.0.1", () => {
    client.destroy(new Error("boom"));
  });
  client.on("error", (error) => events.push(`error:${error.message}:${client.destroyed}`));
  client.on("close", () => {
    events.push("close");
    setTimeout(() => {
      console.log(events.join(","));
      server.close();
    }, 10);
  });
});
