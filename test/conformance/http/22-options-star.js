"use strict";

// `OPTIONS *` is a legal request target: the server sees method OPTIONS and url "*", and the
// response is an ordinary 200.

const http = require("http");
const net = require("net");

const server = http.createServer((req, res) => {
  console.log(`method:${req.method}`);
  console.log(`url:${req.url}`);
  res.writeHead(200, { Allow: "GET, POST" });
  res.end();
});

server.listen(0, "127.0.0.1", () => {
  const socket = net.connect(server.address().port, "127.0.0.1", () => {
    socket.write("OPTIONS * HTTP/1.1\r\nHost: example\r\nConnection: close\r\n\r\n");
  });
  let data = "";
  socket.setEncoding("latin1");
  socket.on("data", (chunk) => {
    data += chunk;
  });
  socket.on("close", () => {
    console.log(`status:${data.split("\r\n")[0]}`);
    server.close();
  });
});
