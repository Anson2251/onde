"use strict";

// `setEncoding("utf8")` must decode a multi-byte character split across two TCP segments; the
// second segment starts with a continuation byte.

const net = require("net");

const text = "héllo wörld";
const bytes = Buffer.from(text, "utf8");
const split = 2; // "h" plus the first byte of "é".
const server = net.createServer((socket) => {
    socket.write(bytes.subarray(0, split));
    setTimeout(() => socket.end(bytes.subarray(split)), 20);
});
server.listen(0, "127.0.0.1", () => {
    const client = net.connect(server.address().port, "127.0.0.1");
    const chunks = [];
    client.setEncoding("utf8");
    client.on("data", (chunk) => chunks.push(chunk));
    client.on("close", () => {
        console.log(`payload:${chunks.join("")}`);
        console.log(`types:${chunks.every((chunk) => typeof chunk === "string")}`);
        server.close();
    });
});
