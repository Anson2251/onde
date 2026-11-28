"use strict";

// A request body whose `Content-Length` is not a non-negative integer is a framing error: the
// server answers with the canned 400 and closes, and the request never reaches the handler.

const http = require("http");
const net = require("net");

let requests = 0;
const server = http.createServer((req, res) => {
    requests += 1;
    req.resume();
    req.on("end", () => res.end("ok"));
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
    console.log(
        `letters:${await request(port, "POST / HTTP/1.1\r\nHost: example\r\nContent-Length: abc\r\nConnection: close\r\n\r\n")}`,
    );
    console.log(
        `negative:${await request(port, "POST / HTTP/1.1\r\nHost: example\r\nContent-Length: -1\r\nConnection: close\r\n\r\n")}`,
    );
    console.log(`requests:${requests}`);
    server.close();
});
