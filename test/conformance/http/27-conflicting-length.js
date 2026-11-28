"use strict";

// `Content-Length` together with `Transfer-Encoding` is a request-smuggling shape. The server
// must reject the head with 400 rather than choose one framing and let the other be interpreted.

const http = require("http");
const net = require("net");

let requests = 0;
const server = http.createServer((req, res) => {
    requests += 1;
    req.resume();
    req.on("end", () => res.end("ok"));
});

server.listen(0, "127.0.0.1", () => {
    const socket = net.connect(server.address().port, "127.0.0.1", () => {
        socket.write(
            "POST / HTTP/1.1\r\nHost: example\r\nContent-Length: 3\r\n" +
                "Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n",
        );
    });
    let data = "";
    socket.setEncoding("latin1");
    socket.on("data", (chunk) => {
        data += chunk;
    });
    socket.on("close", () => {
        console.log(`status:${data.split("\r\n")[0]}`);
        console.log(`requests:${requests}`);
        server.close();
    });
});
