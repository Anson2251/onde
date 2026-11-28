"use strict";

// An HTTP/1.0 client without keep-alive gets a close-delimited response when the body length is
// unknown: no `Transfer-Encoding`, no `Content-Length`, body ends at EOF.

const http = require("http");
const net = require("net");

const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.write("hello");
    res.end(" world");
});

server.listen(0, "127.0.0.1", () => {
    const socket = net.connect(server.address().port, "127.0.0.1", () => {
        socket.write("GET / HTTP/1.0\r\nHost: example\r\n\r\n");
    });
    let data = "";
    socket.setEncoding("latin1");
    socket.on("data", (chunk) => {
        data += chunk;
    });
    socket.on("close", () => {
        const split = data.indexOf("\r\n\r\n");
        const lines = data.slice(0, split).split("\r\n");
        const framed = lines.filter((line) => {
            const lowered = line.toLowerCase();
            return (
                lowered.startsWith("content-length:") || lowered.startsWith("transfer-encoding:")
            );
        });
        console.log(`status:${lines[0]}`);
        console.log(`framed:${framed.length}`);
        console.log(
            `connection:${lines.some((line) => line.toLowerCase() === "connection: close")}`,
        );
        console.log(`body:${data.slice(split + 4)}`);
        server.close();
    });
});
