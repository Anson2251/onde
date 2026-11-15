"use strict";

// Once the head is sent, `setHeader` and a second `writeHead` throw ERR_HTTP_HEADERS_SENT. The
// response already on the wire is unaffected.

const http = require("http");
const net = require("net");

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  try {
    res.setHeader("X-Late", "1");
    console.log("set-header:no-throw");
  } catch (error) {
    console.log(`set-header:${error.code}`);
  }
  try {
    res.writeHead(201);
    console.log("write-head-again:no-throw");
  } catch (error) {
    console.log(`write-head-again:${error.code}`);
  }
  res.end("ok");
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
    console.log(`late-header:${/^x-late:/im.test(data)}`);
    console.log(`body:${data.slice(split + 4)}`);
    server.close();
  });
});
