"use strict";

// Pipelining: two requests written in one segment are answered in order on the same connection,
// with the first response not swallowed by the second parser round.

const http = require("http");
const net = require("net");

const server = http.createServer((req, res) => res.end(`r:${req.url}`));

server.listen(0, "127.0.0.1", () => {
    const socket = net.connect(server.address().port, "127.0.0.1", () => {
        socket.write(
            "GET /a HTTP/1.1\r\nHost: example\r\n\r\n" +
                "GET /b HTTP/1.1\r\nHost: example\r\nConnection: close\r\n\r\n",
        );
    });
    let data = "";
    socket.setEncoding("latin1");
    socket.on("data", (chunk) => {
        data += chunk;
    });
    socket.on("close", () => {
        const count = (data.match(/HTTP\/1\.1 200/g) || []).length;
        const bodies = [];
        let index = 0;
        for (;;) {
            const split = data.indexOf("\r\n\r\n", index);
            if (split === -1) break;
            const next = data.indexOf("HTTP/1.1 ", split + 4);
            bodies.push(data.slice(split + 4, next === -1 ? data.length : next));
            if (next === -1) break;
            index = next;
        }
        console.log(`responses:${count}`);
        console.log(`bodies:${JSON.stringify(bodies)}`);
        server.close();
    });
});
