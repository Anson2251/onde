"use strict";

// HTTP/1.1 requires `Host`. A request without one is rejected by the server with a canned 400,
// before any `'request'` event; the same request with `Host` is served.

const http = require("http");
const net = require("net");

let requests = 0;
const server = http.createServer((req, res) => {
    requests += 1;
    res.end("ok");
});

function request(port, head) {
    return new Promise((resolve) => {
        const socket = net.connect(port, "127.0.0.1", () => socket.write(head));
        let data = "";
        socket.setEncoding("latin1");
        socket.on("data", (chunk) => {
            data += chunk;
        });
        socket.on("close", () => resolve(data.split("\r\n")[0]));
    });
}

server.listen(0, "127.0.0.1", async () => {
    const port = server.address().port;
    console.log(`no-host:${await request(port, "GET / HTTP/1.1\r\nConnection: close\r\n\r\n")}`);
    console.log(
        `with-host:${await request(port, "GET / HTTP/1.1\r\nHost: example\r\nConnection: close\r\n\r\n")}`,
    );
    console.log(`requests:${requests}`);
    server.close();
});
