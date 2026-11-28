"use strict";

// The canonical request/response shape: the client half-closes after its request, and the server
// answers from inside `'end'` with the default `allowHalfOpen: false`. The automatic end of the
// writable side must happen only after the `'end'` listeners have run, or the reply is lost.

const net = require("net");

const events = [];
const server = net.createServer((socket) => {
    socket.resume();
    socket.on("end", () => {
        events.push("server-end");
        socket.end("reply");
    });
    socket.on("error", (error) => events.push(`server-error:${error.code}`));
    socket.on("close", () => events.push("server-close"));
});
server.listen(0, "127.0.0.1", () => {
    const client = net.connect(server.address().port, "127.0.0.1", () => client.end("request"));
    let data = "";
    client.setEncoding("utf8");
    client.on("data", (chunk) => {
        data += chunk;
    });
    client.on("close", () => {
        console.log(`reply:${JSON.stringify(data)}`);
        console.log(`server:${events.join(",")}`);
        server.close();
    });
});
