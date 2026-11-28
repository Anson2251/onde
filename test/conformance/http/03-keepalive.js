"use strict";

// Keep-alive: two requests on one connection, then the server's `Connection: close` ends it.
// The output proves reuse without ever printing the port.

const http = require("http");
const net = require("net");

let firstPort = null;
let sameConnection = false;

const server = http.createServer((req, res) => {
    if (firstPort === null) firstPort = req.socket.remotePort;
    else if (req.socket.remotePort === firstPort) sameConnection = true;
    res.end(`reply:${req.url}`);
});

function header(line, name) {
    const lowered = line.toLowerCase();
    return lowered.startsWith(`${name}:`) ? line.slice(line.indexOf(":") + 1).trim() : undefined;
}

server.listen(0, "127.0.0.1", () => {
    const socket = net.connect(server.address().port, "127.0.0.1");
    let data = "";
    let stage = 0;
    socket.setEncoding("latin1");
    socket.on("connect", () => {
        socket.write("GET /one HTTP/1.1\r\nHost: example\r\n\r\n");
    });
    socket.on("data", (chunk) => {
        data += chunk;
        if (stage === 0 && data.includes("reply:/one")) {
            stage = 1;
            report();
            data = "";
            socket.write("GET /two HTTP/1.1\r\nHost: example\r\nConnection: close\r\n\r\n");
        } else if (stage === 1 && data.includes("reply:/two")) {
            stage = 2;
            report();
        }
    });
    function report() {
        const split = data.indexOf("\r\n\r\n");
        const lines = data.slice(0, split).split("\r\n");
        console.log(lines[0]);
        const connection = lines
            .map((line) => header(line, "connection"))
            .filter((value) => value !== undefined)[0];
        console.log(`connection:${connection}`);
        console.log(`body:${data.slice(split + 4)}`);
    }
    socket.on("close", () => {
        console.log(`same-connection:${sameConnection}`);
        server.close();
    });
});
