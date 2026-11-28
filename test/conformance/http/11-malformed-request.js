"use strict";

// A malformed request line is answered by the server itself with a canned 400 and a close; the
// isolate never sees a `'request'` event (m4-plan §5, D42).

const http = require("http");
const net = require("net");

let requests = 0;
const server = http.createServer((req, res) => {
    requests += 1;
    res.end("ok");
});

server.listen(0, "127.0.0.1", () => {
    const socket = net.connect(server.address().port, "127.0.0.1", () => {
        socket.write("NOT A REQUEST\r\n\r\n");
    });
    let data = "";
    socket.setEncoding("latin1");
    socket.on("data", (chunk) => {
        data += chunk;
    });
    socket.on("close", () => {
        const split = data.indexOf("\r\n\r\n");
        console.log(`status:${data.split("\r\n")[0]}`);
        console.log(`body-length:${split === -1 ? 0 : data.slice(split + 4).length}`);
        console.log(`requests:${requests}`);
        server.close();
    });
});
