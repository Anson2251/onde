"use strict";

// `write()` after `end()` returns false, then emits ERR_STREAM_WRITE_AFTER_END; the close that
// follows is the only one. The callback also receives the error (Node 16+).

const net = require("net");

const events = [];
const server = net.createServer((socket) => socket.resume());
server.listen(0, "127.0.0.1", () => {
    const client = net.connect(server.address().port, "127.0.0.1", () => {
        client.end();
        events.push(
            `write-returned:${client.write("late", (error) => {
                events.push(
                    `callback:${error === null || error === undefined ? "none" : error.code}`,
                );
            })}`,
        );
    });
    client.on("error", (error) => events.push(`error:${error.code}`));
    client.on("close", () => {
        events.push("close");
        setTimeout(() => {
            console.log(events.join(","));
            server.close();
        }, 10);
    });
});
