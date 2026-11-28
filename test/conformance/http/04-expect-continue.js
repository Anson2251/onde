"use strict";

// 100-continue: the server answers the expectation itself (no 'checkContinue' listener), the
// client sends the body after the interim response, and the final response follows.

const http = require("http");
const net = require("net");

const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
        body += chunk;
    });
    req.on("end", () => {
        res.end(`body:${body}`);
    });
});

server.listen(0, "127.0.0.1", () => {
    const socket = net.connect(server.address().port, "127.0.0.1", () => {
        socket.write(
            "POST /continue HTTP/1.1\r\nHost: example\r\nExpect: 100-continue\r\n" +
                "Content-Length: 3\r\nConnection: close\r\n\r\n",
        );
    });
    let data = "";
    let sent = false;
    socket.setEncoding("latin1");
    socket.on("data", (chunk) => {
        data += chunk;
        if (!sent && data.includes("100 Continue")) {
            sent = true;
            console.log("interim:" + data.split("\r\n")[0]);
            data = "";
            socket.write("abc");
        }
    });
    socket.on("close", () => {
        const split = data.indexOf("\r\n\r\n");
        console.log(data.split("\r\n")[0]);
        console.log(`final-body:${data.slice(split + 4)}`);
        server.close();
    });
});
