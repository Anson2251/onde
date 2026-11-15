"use strict";

// A chunked request with trailers: the body is de-framed before `'data'`, and the trailer fields
// are exposed on `'end'` as `req.trailers` (lowercased) and `req.rawTrailers` (wire case).

const http = require("http");
const net = require("net");

const server = http.createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    console.log(`body:${body}`);
    console.log(`trailers:${JSON.stringify(req.trailers)}`);
    console.log(`rawTrailers:${JSON.stringify(req.rawTrailers)}`);
    res.end("ok");
  });
});

server.listen(0, "127.0.0.1", () => {
  const socket = net.connect(server.address().port, "127.0.0.1", () => {
    socket.write(
      "POST /upload HTTP/1.1\r\nHost: example\r\nTransfer-Encoding: chunked\r\n" +
        "Trailer: X-Sum\r\nConnection: close\r\n\r\n" +
        "4\r\nwiki\r\n5\r\npedia\r\n0\r\nX-Sum: 9\r\n\r\n",
    );
  });
  let data = "";
  socket.setEncoding("latin1");
  socket.on("data", (chunk) => {
    data += chunk;
  });
  socket.on("close", () => {
    console.log(`response:${data.split("\r\n")[0]}`);
    server.close();
  });
});
