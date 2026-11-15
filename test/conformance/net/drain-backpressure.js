"use strict";

// Backpressure: writing past the 16 KiB high-water mark makes `write()` return false, `'drain'`
// follows once the peer reads again, and every byte still arrives.
//
// The peer does not read at first, and the client writes until `write()` refuses instead of
// writing one fixed 1 MiB buffer. Whether a single write is buffered depends on the kernel's send
// buffer: macOS refuses early, Linux autotunes large enough to swallow a megabyte, so a fixed
// write makes `write()` return true there and `'drain'` never fires (the process then never exits).

const net = require("net");

const CHUNK = Buffer.alloc(64 * 1024, 7);
// 32 MiB: larger than any default socket send buffer, so the client must see backpressure.
const MAX_BYTES = 32 * 1024 * 1024;

const server = net.createServer((socket) => {
  // Do not read until the client has hit its high-water mark; a reading peer drains the kernel
  // fast enough that the client's own buffer never fills.
  socket.pause();
  let received = 0;
  socket.on("data", (chunk) => {
    received += chunk.length;
  });
  socket.on("end", () => {
    // Echo the byte count so the client can check integrity without knowing platform buffering.
    socket.end(String(received));
  });
  setTimeout(() => socket.resume(), 100);
});

server.listen(0, "127.0.0.1", () => {
  const client = net.connect(server.address().port, "127.0.0.1", () => {
    let sent = 0;
    let value = true;
    while (value && sent < MAX_BYTES) {
      value = client.write(CHUNK);
      sent += CHUNK.length;
    }
    console.log(`write-returned:${value}`);

    let reply = "";
    client.setEncoding("utf8");
    client.on("data", (chunk) => {
      reply += chunk;
    });
    client.on("end", () => {
      console.log(`bytes-intact:${Number(reply) === sent}`);
    });
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
