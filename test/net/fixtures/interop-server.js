"use strict";

// HTTP(S) server used by test/net/interop.sh.
//
//   <runtime> interop-server.js <port-file>
//
// Binds 127.0.0.1:0 and writes the assigned port to <port-file> (the port is never printed, so
// nothing port-specific can leak into an assertion). `INTEROP_TLS=1` plus `TLS_KEY`/`TLS_CERT`
// serves the same handler over TLS.
//
// Endpoints:
//   /ok       Content-Length response, custom header with mixed case, per-socket request count
//   /chunked  unknown length, so the response is chunked

const fs = require("fs");

const tls = process.env.INTEROP_TLS === "1";
const portFile = process.argv[2];

function handler(req, res) {
    const socket = req.socket;
    socket.__interopRequests = (socket.__interopRequests || 0) + 1;
    if (req.url === "/chunked") {
        res.writeHead(200, { "Content-Type": "text/plain", "X-Custom": "ValueCase" });
        res.write("chunk-one");
        res.end("chunk-two");
        return;
    }
    res.writeHead(200, {
        "Content-Type": "text/plain",
        "Content-Length": "5",
        "X-Custom": "ValueCase",
        "X-Connection-Requests": String(socket.__interopRequests),
    });
    res.end("hello");
}

let server;
if (tls) {
    const https = require("https");
    server = https.createServer(
        { key: fs.readFileSync(process.env.TLS_KEY), cert: fs.readFileSync(process.env.TLS_CERT) },
        handler,
    );
} else {
    const http = require("http");
    server = http.createServer(handler);
}

server.on("error", (error) => {
    console.error(`interop-server: ${error.code || error.message}`);
    process.exit(1);
});

server.listen(0, "127.0.0.1", () => {
    fs.writeFileSync(portFile, String(server.address().port));
});

function shutdown() {
    server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
