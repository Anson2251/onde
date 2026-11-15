"use strict";

// A 304 is bodyless even when it carries `Content-Length` metadata, and it must not desynchronize
// a keep-alive connection: the next request on the same socket is answered normally.

const http = require("http");
const net = require("net");

let firstRemotePort = null;
let reused = false;

const server = http.createServer((req, res) => {
  if (firstRemotePort === null) firstRemotePort = req.socket.remotePort;
  else if (req.socket.remotePort === firstRemotePort) reused = true;
  if (req.url === "/cached") {
    res.writeHead(304, { ETag: "\"abc\"", "Content-Length": "10" });
    res.end();
    return;
  }
  res.end("fresh");
});

server.listen(0, "127.0.0.1", () => {
  const socket = net.connect(server.address().port, "127.0.0.1");
  let data = "";
  let stage = 0;
  socket.setEncoding("latin1");
  socket.on("connect", () => socket.write("GET /cached HTTP/1.1\r\nHost: example\r\n\r\n"));
  socket.on("data", (chunk) => {
    data += chunk;
    if (stage === 0) {
      const split = data.indexOf("\r\n\r\n");
      if (split === -1) return;
      stage = 1;
      console.log(`status:${data.split("\r\n")[0]}`);
      console.log(`304-body:${data.slice(split + 4).length}`);
      data = "";
      socket.write("GET /fresh HTTP/1.1\r\nHost: example\r\nConnection: close\r\n\r\n");
    } else if (stage === 1 && data.includes("fresh")) {
      const split = data.indexOf("\r\n\r\n");
      stage = 2;
      console.log(`second:${data.split("\r\n")[0]}`);
      console.log(`second-body:${data.slice(split + 4)}`);
    }
  });
  socket.on("close", () => {
    console.log(`same-connection:${reused}`);
    server.close();
  });
});
