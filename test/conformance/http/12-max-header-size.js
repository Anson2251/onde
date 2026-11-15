"use strict";

// `maxHeaderSize` is enforced end-to-end: a head past the limit gets a canned 431 and the
// connection is closed; a request under the same limit is served normally.

const http = require("http");
const net = require("net");

function request(port, head) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(head));
    let data = "";
    socket.setEncoding("latin1");
    socket.on("data", (chunk) => {
      data += chunk;
    });
    socket.on("close", () => resolve(data));
  });
}

const server = http.createServer({ maxHeaderSize: 256 }, (req, res) => res.end("ok"));

server.listen(0, "127.0.0.1", async () => {
  const port = server.address().port;
  const big = await request(
    port,
    `GET / HTTP/1.1\r\nHost: example\r\nX-Big: ${"a".repeat(400)}\r\n\r\n`,
  );
  console.log(`big:${big.split("\r\n")[0]}`);
  const small = await request(
    port,
    `GET / HTTP/1.1\r\nHost: example\r\nX-Small: ${"b".repeat(50)}\r\nConnection: close\r\n\r\n`,
  );
  console.log(`small:${small.split("\r\n")[0]}`);
  console.log(`small-body:${small.slice(small.indexOf("\r\n\r\n") + 4)}`);
  server.close();
});
