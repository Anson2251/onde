"use strict";

// A request/response over one TCP connection. Both runtimes bind 127.0.0.1:0; the port is never
// printed. Each side prints its own event list after both sockets are closed, so TCP scheduling
// between the two sockets cannot change the output.

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

const server = net.createServer((socket) => {
    serverEvents.push("connection");
    socket.on("data", (chunk) => {
        serverEvents.push("data");
        socket.write(chunk);
        socket.end();
    });
    socket.on("end", () => serverEvents.push("end"));
    socket.on("close", () => {
        serverEvents.push("close");
        finish();
    });
});

server.on("listening", () => {
    const address = server.address();
    console.log("listening: " + address.address + " " + address.family);
});

server.listen(0, "127.0.0.1", () => {
    const client = net.connect(server.address().port, "127.0.0.1", () => {
        clientEvents.push("connect");
        client.end("hello");
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
