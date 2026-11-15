"use strict";

// `writeHead` validates at the call site: status must be 100-999, header names must be tokens
// (ERR_INVALID_HTTP_TOKEN), and values must not contain CR/LF (ERR_INVALID_CHAR). A rejected call
// must not leave the response half-written.

const http = require("http");
const net = require("net");

const server = http.createServer((req, res) => {
  const attempts = [
    ["status-low", () => res.writeHead(99)],
    ["status-high", () => res.writeHead(1000)],
    ["token", () => res.writeHead(200, { "Bad Name": "x" })],
    ["char", () => res.writeHead(200, { "X-Bad": "a\r\nb" })],
  ];
  for (const [label, fn] of attempts) {
    try {
      fn();
      console.log(`${label}:no-throw`);
    } catch (error) {
      console.log(`${label}:${error.code}`);
    }
  }
  res.end("still-ok");
});

server.listen(0, "127.0.0.1", () => {
  const socket = net.connect(server.address().port, "127.0.0.1", () => {
    socket.write("GET / HTTP/1.1\r\nHost: example\r\nConnection: close\r\n\r\n");
  });
  let data = "";
  socket.setEncoding("latin1");
  socket.on("data", (chunk) => {
    data += chunk;
  });
  socket.on("close", () => {
    const split = data.indexOf("\r\n\r\n");
    console.log(`status:${data.split("\r\n")[0]}`);
    console.log(`body:${data.slice(split + 4)}`);
    server.close();
  });
});
