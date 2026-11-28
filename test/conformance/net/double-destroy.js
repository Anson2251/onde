"use strict";

// double destroy: Node emits one `close`, no `error`, and `destroyed` is true.

const net = require("net");

const server = net.createServer((socket) => socket.resume());
server.listen(0, "127.0.0.1", () => {
    const client = net.connect(server.address().port, "127.0.0.1");
    let closes = 0;
    let errors = 0;
    client.on("error", () => {
        errors += 1;
    });
    client.on("close", () => {
        closes += 1;
        setTimeout(() => {
            console.log("closes: " + closes);
            console.log("errors: " + errors);
            console.log("destroyed: " + client.destroyed);
            server.close();
        }, 20);
    });
    client.on("connect", () => {
        client.destroy();
        client.destroy();
    });
});
