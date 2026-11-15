"use strict";

// Writing into a peer that has already reset its socket: the write path reports a broken pipe
// (`EPIPE` or `ECONNRESET`, platform dependent) rather than hanging or dropping the bytes
// silently. The family is printed, not the exact errno, so the case is portable.
//
// The server resets on accept and the client writes only after the reset has had time to land.
// That ordering is what makes the case deterministic: a client that writes in a loop while the
// peer resets races its own timer against the error delivery, and can close before the error is
// observed.

const net = require("net");

const events = [];
const server = net.createServer((socket) => socket.resetAndDestroy());
server.listen(0, "127.0.0.1", () => {
  const client = net.connect(server.address().port, "127.0.0.1", () => {
    client.on("error", (error) => {
      const family =
        error.code === "EPIPE" || error.code === "ECONNRESET" ? "broken-pipe" : error.code;
      events.push(`error-family:${family}`);
    });
    setTimeout(() => client.write(Buffer.alloc(64 * 1024, 0x62)), 150);
  });
  client.on("close", () => {
    events.push("close");
    console.log(events.join(","));
    server.close();
  });
});
