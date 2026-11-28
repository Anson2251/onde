"use strict";

// `destroy()` before the connection completes: no `connect`, no `error`, exactly one `close`.
// The pending connect task must be cancelled rather than allowed to settle later.

const net = require("net");

const events = [];
const server = net.createServer((socket) => socket.resume());
server.listen(0, "127.0.0.1", () => {
    const client = net.connect(server.address().port, "127.0.0.1");
    client.on("connect", () => events.push("connect"));
    client.on("error", (error) => events.push(`error:${error.code}`));
    client.on("close", () => {
        events.push("close");
        setTimeout(() => {
            console.log(events.join(","));
            server.close();
        }, 20);
    });
    client.destroy();
});
