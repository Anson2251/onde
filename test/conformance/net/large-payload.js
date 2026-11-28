"use strict";

// A 1 MiB stream is not truncated or reordered: the server counts every byte and reports the
// count back on the same socket.

const net = require("net");

const payload = Buffer.alloc(1024 * 1024);
for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 7) % 253;

const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let bytes = 0;
    socket.on("data", (chunk) => {
        bytes += chunk.length;
    });
    socket.on("end", () => socket.end(`server-count:${bytes}`));
});
server.listen(0, "127.0.0.1", () => {
    const client = net.connect(server.address().port, "127.0.0.1", () => client.end(payload));
    let reply = "";
    client.setEncoding("utf8");
    client.on("data", (chunk) => {
        reply += chunk;
    });
    client.on("close", () => {
        console.log(`sent:${payload.length}`);
        console.log(reply);
        server.close();
    });
});
