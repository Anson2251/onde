"use strict";

// `setTimeout(ms)` is an idle timer owned by JS (m4-plan §4). It fires while the connection is
// quiet, and the user destroys the socket; a second quiet interval must not fire again.

const net = require("net");

const events = [];
const server = net.createServer((socket) => socket.resume());
server.listen(0, "127.0.0.1", () => {
  const client = net.connect(server.address().port, "127.0.0.1", () => {
    client.setTimeout(30, () => {
      events.push("timeout");
      client.destroy();
      client.setTimeout(30, () => events.push("late-timeout"));
    });
  });
  client.on("close", () => {
    events.push("close");
    setTimeout(() => {
      console.log(events.join(","));
      server.close();
    }, 60);
  });
});
