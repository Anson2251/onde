"use strict";

// Address metadata on both ends of a loopback connection. The dynamic values are only asserted
// as booleans/relations so nothing port-specific can leak into the output.

const net = require("net");

const server = net.createServer((socket) => {
    // Printed when the client's first byte arrives, not on 'connection': the two event streams
    // interleave by loopback timing, and macOS and Linux do not agree on which fires first.
    socket.once("data", () => {
        console.log(`server-remote:${socket.remoteAddress === "127.0.0.1"}`);
        console.log(`server-remote-family:${socket.remoteFamily}`);
        console.log(`server-remote-port:${socket.remotePort > 0}`);
        console.log(`server-local-address:${socket.localAddress}`);
        socket.end("bye");
    });
});
server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    const client = net.connect(port, "127.0.0.1", () => {
        console.log(`client-local-address:${client.localAddress}`);
        console.log(`client-remote-address:${client.remoteAddress}`);
        console.log(`client-remote-family:${client.remoteFamily}`);
        console.log(`client-local-port:${client.localPort > 0}`);
        console.log(`client-remote-port:${client.remotePort === port}`);
        // The client's lines are already queued, so the server's block cannot land before them.
        client.write("go");
    });
    client.resume();
    client.on("close", () => server.close());
});
