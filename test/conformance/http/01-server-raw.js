"use strict";

// One raw HTTP/1.1 request against an `http` server: status line, selected headers and body.
// Everything printed is deterministic: no Date, no ports, no timings.

const http = require("http");
const net = require("net");

const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/plain");
    res.setHeader("X-Test", "value");
    res.end("hello world");
});

server.listen(0, "127.0.0.1", () => {
    const socket = net.connect(server.address().port, "127.0.0.1", () => {
        socket.write("GET /hello HTTP/1.1\r\nHost: example\r\nConnection: close\r\n\r\n");
    });
    let data = "";
    socket.setEncoding("latin1");
    socket.on("data", (chunk) => {
        data += chunk;
    });
    socket.on("close", () => {
        const split = data.indexOf("\r\n\r\n");
        const lines = data.slice(0, split).split("\r\n");
        console.log(lines[0]);
        for (const name of ["content-type", "x-test", "connection", "content-length"]) {
            for (let i = 1; i < lines.length; i += 1) {
                const colon = lines[i].indexOf(":");
                if (colon !== -1 && lines[i].slice(0, colon).toLowerCase() === name) {
                    console.log(`${name}:${lines[i].slice(colon + 1).trim()}`);
                }
            }
        }
        console.log(`body:${data.slice(split + 4)}`);
        server.close();
    });
});
