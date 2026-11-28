"use strict";

// No body on HEAD or 204, and no body framing computed for either (m4-plan §5).

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
    const head = data.slice(0, split);
    const body = data.slice(split + 4);
    const lines = head.split("\r\n");
    const framing = lines
        .filter((line) => {
            const lowered = line.toLowerCase();
            return (
                lowered.startsWith("content-length:") || lowered.startsWith("transfer-encoding:")
            );
        })
        .map((line) => line.slice(0, line.indexOf(":")).toLowerCase());
    console.log(`${label}:${lines[0]}`);
    console.log(`${label}-framing:${framing.length}`);
    console.log(`${label}-body-length:${body.length}`);
}

const server = http.createServer((req, res) => {
    if (req.url === "/head") {
        res.end("ignored");
        return;
    }
    res.statusCode = 204;
    res.end("ignored");
});

server.listen(0, "127.0.0.1", async () => {
    const port = server.address().port;
    report(
        "head",
        await request(port, "HEAD /head HTTP/1.1\r\nHost: example\r\nConnection: close\r\n\r\n"),
    );
    report(
        "204",
        await request(port, "GET /204 HTTP/1.1\r\nHost: example\r\nConnection: close\r\n\r\n"),
    );
    server.close();
});
