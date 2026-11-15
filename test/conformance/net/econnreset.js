"use strict";

// A real reset (SO_LINGER 0 via `resetAndDestroy`) is visible as ECONNRESET on the peer, not as a
// clean FIN. A transport without a reset path silently turns this into `end`+`close`.

const net = require("net");

const events = [];
const server = net.createServer((socket) => {
  socket.once("data", () => setTimeout(() => socket.resetAndDestroy(), 20));
});
server.listen(0, "127.0.0.1", () => {
  const client = net.connect(server.address().port, "127.0.0.1", () => client.write("hello"));
  client.on("data", () => events.push("data"));
  client.on("end", () => events.push("end"));
  client.on("error", (error) => events.push(`error:${error.code}`));
  client.on("close", () => {
    events.push("close");
    setTimeout(() => {
      console.log(events.join(","));
      server.close();
    }, 10);
  });
});
