"use strict";

// The reason phrase: the default for a status code, and a user-supplied `statusMessage`. Only the
// status line is asserted, so the Date header stays out of the output.

const http = require("http");
const net = require("net");

function request(port, path) {
    return new Promise((resolve) => {
        const socket = net.connect(port, "127.0.0.1", () => {
            socket.write(`GET ${path} HTTP/1.1\r\nHost: example\r\nConnection: close\r\n\r\n`);
        });
        let data = "";
        socket.setEncoding("latin1");
        socket.on("data", (chunk) => {
            data += chunk;
        });
        socket.on("close", () => resolve(data.split("\r\n")[0]));
    });
}

const server = http.createServer((req, res) => {
    if (req.url === "/created") {
        res.writeHead(201);
    } else {
        res.statusCode = 418;
        res.statusMessage = "Short And Stout";
    }
    res.end();
});

server.listen(0, "127.0.0.1", async () => {
    const port = server.address().port;
    console.log(`default:${await request(port, "/created")}`);
    console.log(`custom:${await request(port, "/teapot")}`);
    server.close();
});
