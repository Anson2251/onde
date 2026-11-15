"use strict";

// With a `'checkContinue'` listener Node does not send the interim response automatically: the
// listener calls `res.writeContinue()`, reads the body, and answers. Without the listener the
// same request is continued automatically (04-expect-continue covers that path).

const http = require("http");
const net = require("net");

const events = [];

const server = http.createServer((req, res) => {
  events.push("request");
  res.end("unexpected");
});
server.on("checkContinue", (req, res) => {
  events.push("checkContinue");
  res.writeContinue();
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => res.end(`continued:${body}`));
});

server.listen(0, "127.0.0.1", () => {
  const socket = net.connect(server.address().port, "127.0.0.1", () => {
    socket.write(
      "POST /continue HTTP/1.1\r\nHost: example\r\nExpect: 100-continue\r\n" +
        "Content-Length: 3\r\nConnection: close\r\n\r\n",
    );
  });
  let data = "";
  let sent = false;
  socket.setEncoding("latin1");
  socket.on("data", (chunk) => {
    data += chunk;
    if (!sent && data.includes("100 Continue")) {
      sent = true;
      console.log(`interim:${data.split("\r\n")[0]}`);
      data = "";
      socket.write("abc");
    }
  });
  socket.on("close", () => {
    const split = data.indexOf("\r\n\r\n");
    console.log(`final:${data.split("\r\n")[0]}`);
    console.log(`body:${data.slice(split + 4)}`);
    console.log(`events:${events.join(",")}`);
    server.close();
  });
});
