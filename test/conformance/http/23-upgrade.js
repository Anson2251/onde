"use strict";

// The upgrade path: the `'upgrade'` event fires, the connection detaches to raw bytes, and the
// frame sent in the same segment as the request head is not lost. Node reports those bytes as the
// third argument; onde parks them and reports a zero-length `head` (D44), so the case appends
// both `head` and later `data` and only asserts the payload the server heard.

const http = require("http");
const net = require("net");

const server = http.createServer((req, res) => res.end("normal"));
server.on("upgrade", (req, socket, head) => {
  console.log(`upgrade:${req.headers.upgrade}`);
  let received = head;
  socket.resume();
  socket.on("data", (chunk) => {
    received = Buffer.concat([received, chunk]);
  });
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
  );
  setTimeout(() => socket.end(`echo:${received.toString("latin1")}`), 200);
});

server.listen(0, "127.0.0.1", () => {
  const socket = net.connect(server.address().port, "127.0.0.1", () => {
    // Request head and first frame in one segment: the frame is "past the head".
    socket.write(
      "GET /upgrade HTTP/1.1\r\nHost: example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nping",
    );
  });
  let data = "";
  socket.setEncoding("latin1");
  socket.on("data", (chunk) => {
    data += chunk;
  });
  socket.on("close", () => {
    const split = data.indexOf("\r\n\r\n");
    console.log(`status:${data.slice(0, split).split("\r\n")[0]}`);
    console.log(`payload:${data.slice(split + 4)}`);
    server.close();
  });
});
