"use strict";

// HEAD carries the framing headers of the request it mirrors but never a body. Both an explicit
// Content-Length and an unknown-length response (which would be chunked for GET) must leave the
// connection byte-clean and send no body.

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

function report(label, data) {
    const split = data.indexOf("\r\n\r\n");
    const lines = data.slice(0, split).split("\r\n");
    const framing = lines
        .filter((line) => {
            const lowered = line.toLowerCase();
            return (
                lowered.startsWith("content-length:") || lowered.startsWith("transfer-encoding:")
            );
        })
        .map((line) => line.toLowerCase());
    console.log(`${label}:${lines[0]}`);
    console.log(`${label}-framing:${framing.join("|")}`);
    console.log(`${label}-body:${data.slice(split + 4).length}`);
}

const server = http.createServer((req, res) => {
    if (req.url === "/explicit") {
        res.writeHead(200, { "Content-Length": "7", "Content-Type": "text/plain" });
        res.end("ignored");
        return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.write("ig");
    res.end("nored");
});

server.listen(0, "127.0.0.1", async () => {
    const port = server.address().port;
    report(
        "explicit",
        await request(
            port,
            "HEAD /explicit HTTP/1.1\r\nHost: example\r\nConnection: close\r\n\r\n",
        ),
    );
    report(
        "unknown",
        await request(port, "HEAD /unknown HTTP/1.1\r\nHost: example\r\nConnection: close\r\n\r\n"),
    );
    server.close();
});
