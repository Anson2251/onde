"use strict";

// Three concurrent clients get isolated sockets. Each client's result is collected and printed
// in sorted order, so TCP scheduling cannot reorder the output.

const net = require("net");

const results = [];
let remaining = 3;

const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => socket.end(`echo:${chunk}`));
});

function finish() {
    remaining -= 1;
    if (remaining > 0) return;
    for (const line of results.sort()) console.log(line);
    server.close();
}

server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    for (const label of ["bravo", "alpha", "charlie"]) {
        const client = net.connect(port, "127.0.0.1", () => client.end(label));
        const chunks = [];
        client.setEncoding("utf8");
        client.on("data", (chunk) => chunks.push(chunk));
        client.on("close", () => {
            results.push(`${label}:${chunks.join("")}`);
            finish();
        });
    }
});
