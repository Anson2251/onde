"use strict";

// Lifecycle flags: `destroyed` flips on the first destroy, the socket is not writable afterwards,
// and the second destroy does not produce a second `close`.

const net = require("net");

const server = net.createServer((socket) => socket.resume());
server.listen(0, "127.0.0.1", () => {
    const client = net.connect(server.address().port, "127.0.0.1", () => {
        console.log(`connected:${client.destroyed},${client.writable},${client.readable}`);
        client.destroy();
        console.log(`destroyed:${client.destroyed},${client.writable}`);
        client.destroy();
    });
    client.on("close", () => {
        console.log(`close:${client.destroyed},${client.readable}`);
        server.close();
    });
});
