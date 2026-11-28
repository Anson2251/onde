"use strict";

// pause()/resume(): no byte is lost while the readable is paused. Chunk boundaries are TCP
// scheduling, so only the accumulated payload and the observable paused/flowing flags print.

const net = require("net");

const server = net.createServer((socket) => {
    socket.write("one");
    setTimeout(() => socket.write("two"), 20);
    setTimeout(() => {
        socket.write("three");
        socket.end();
    }, 40);
});

server.listen(0, "127.0.0.1", () => {
    const client = net.connect(server.address().port, "127.0.0.1");
    let payload = "";
    let paused = false;
    client.on("data", (chunk) => {
        payload += chunk.toString("utf8");
        if (paused) return;
        paused = true;
        client.pause();
        console.log("paused: " + client.isPaused());
        setTimeout(() => {
            client.resume();
            console.log("flowing: " + (client.readableFlowing !== false));
        }, 60);
    });
    client.on("end", () => {
        console.log("payload: " + payload);
    });
    client.on("close", () => {
        server.close();
    });
});
