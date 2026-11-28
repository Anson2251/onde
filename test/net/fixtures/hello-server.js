"use strict";

// Minimal hello-world server for test/net/bench.sh. Binds 127.0.0.1:0, writes the port to
// <port-file>, and keeps the connection alive (the response is length-delimited).

const fs = require("fs");
const http = require("http");

const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": "11" });
    res.end("hello world");
});

server.on("error", (error) => {
    console.error(`bench-server: ${error.code || error.message}`);
    process.exit(1);
});

server.listen(0, "127.0.0.1", () => {
    fs.writeFileSync(process.argv[2], String(server.address().port));
});

function shutdown() {
    server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
