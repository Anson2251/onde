"use strict";

// Client-side HEAD: the response headers describe the GET body, but no body bytes are read and
// the request completes. The server is separate, so this exercises the client framing rule too.

const http = require("http");

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Length": "7", "Content-Type": "text/plain" });
  res.end("ignored");
});

server.listen(0, "127.0.0.1", () => {
  const req = http.request(
    { host: "127.0.0.1", port: server.address().port, path: "/head", method: "HEAD" },
    (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        console.log(`status:${res.statusCode}`);
        console.log(`content-length:${res.headers["content-length"]}`);
        console.log(`body:${chunks.reduce((n, chunk) => n + chunk.length, 0)}`);
        console.log(`complete:${res.complete}`);
        server.close();
      });
    },
  );
  req.on("error", (error) => {
    console.log(`error:${error.code}`);
    server.close();
  });
  req.end();
});
