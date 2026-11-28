"use strict";

// Half-close: the client sends FIN with `end()` and its read side stays open for the answer.
// Output is per-socket and printed after both closes, so it is stable across runtimes.

const net = require("net");

let clientEvents = [];
let serverEvents = [];
let payload = "";
let remaining = 2;

function finish() {
    remaining -= 1;
    if (remaining > 0) return;
    console.log("client: " + clientEvents.join(","));
    console.log("server: " + serverEvents.join(","));
    console.log("payload: " + payload);
    server.close();
}

const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    serverEvents.push("connection");
    let received = "";
    socket.on("data", (chunk) => {
        serverEvents.push("data");
        received += chunk.toString("utf8");
    });
    socket.on("end", () => {
        serverEvents.push("end");
        socket.end("late:" + received);
    });
    socket.on("close", () => {
        serverEvents.push("close");
        finish();
    });
});

server.listen(0, "127.0.0.1", () => {
    const client = net.connect(server.address().port, "127.0.0.1", () => {
        clientEvents.push("connect");
        client.end("hi");
    });
    client.on("data", (chunk) => {
        clientEvents.push("data");
        payload += chunk.toString("utf8");
    });
    client.on("end", () => clientEvents.push("end"));
    client.on("close", () => {
        clientEvents.push("close");
        finish();
    });
});
