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
const server = net.createServer((socket) => {
  // A socket reset on accept can still emit an error afterwards (the peer's write lands on a
  // destroyed socket). Without a listener that error is uncaught and takes the process down,
  // which on a piped stdout loses the lines already printed. macOS rarely reaches this path,
  // Linux on loopback does.
  socket.on("error", () => {});
  socket.resetAndDestroy();
});
server.listen(0, "127.0.0.1", () => {
  const client = net.connect(server.address().port, "127.0.0.1");
  // Attached before the handshake: on a fast loopback the reset can beat `connect`, and an
  // 'error' with no listener at that moment is fatal.
  client.on("error", (error) => {
    // First family only: the reset and the write can both report one, and the count depends on
    // how the kernel orders them, while the family is what the case is about.
    if (events.length > 0) return;
    const family =
      error.code === "EPIPE" || error.code === "ECONNRESET" ? "broken-pipe" : error.code;
    events.push(`error-family:${family}`);
  });
  client.on("connect", () => {
    setTimeout(() => {
      if (!client.destroyed) client.write(Buffer.alloc(64 * 1024, 0x62));
    }, 150);
  });
  client.on("close", () => {
    events.push("close");
    console.log(events.join(","));
    server.close();
  });
});
