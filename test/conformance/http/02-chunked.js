"use strict";

// Chunked framing in both directions: a response without Content-Length is chunked on the wire,
// and a chunked request body is de-framed before the request handler sees it.

const http = require("http");
const net = require("net");

function request(port, text) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(text));
    let data = "";
    socket.setEncoding("latin1");
    socket.on("data", (chunk) => {
      data += chunk;
    });
    socket.on("close", () => resolve(data));
  });
}

function bodyOf(data) {
  return data.slice(data.indexOf("\r\n\r\n") + 4);
}

/// Chunk-size boundaries are an implementation detail (Node coalesces pending writes); the
/// de-framed payload is the contract.
function dechunk(text) {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const lineEnd = text.indexOf("\r\n", index);
    if (lineEnd === -1) break;
    const size = parseInt(text.slice(index, lineEnd), 16);
    index = lineEnd + 2;
    if (size === 0) break;
    output += text.slice(index, index + size);
    index += size + 2;
  }
  return output;
}

const server = http.createServer((req, res) => {
  if (req.url === "/chunked") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.write("ab");
    res.end("cd");
    return;
  }
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    res.end(`echo:${body}`);
  });
});

server.listen(0, "127.0.0.1", async () => {
  const port = server.address().port;

  const chunkedResponse = await request(
    port,
    "GET /chunked HTTP/1.1\r\nHost: example\r\nConnection: close\r\n\r\n",
  );
  const head = chunkedResponse.slice(0, chunkedResponse.indexOf("\r\n\r\n"));
  const headers = head.split("\r\n");
  console.log(headers[0]);
  const te = headers.find((line) => line.toLowerCase().startsWith("transfer-encoding:"));
  console.log(te === undefined ? "transfer-encoding:none" : `transfer-encoding:${te.slice(te.indexOf(":") + 1).trim()}`);
  console.log(`body:${JSON.stringify(dechunk(bodyOf(chunkedResponse)))}`);

  const chunkedRequest = await request(
    port,
    "POST /echo HTTP/1.1\r\nHost: example\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n" +
      "3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n",
  );
  console.log(`echo:${bodyOf(chunkedRequest)}`);

  server.close();
});
