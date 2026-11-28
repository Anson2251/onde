"use strict";

// Aborting an in-flight client request produces one error and one close: Node reports
// ECONNRESET for a socket destroyed before the response arrives, and never emits `'close'` twice.

const http = require("http");

const events = [];
const server = http.createServer((req, res) => {
    setTimeout(() => res.end("late"), 300);
});

server.listen(0, "127.0.0.1", () => {
    const req = http.get({ host: "127.0.0.1", port: server.address().port, path: "/" }, (res) =>
        res.resume(),
    );
    req.on("error", (error) => events.push(`error:${error.code}`));
    req.on("close", () => events.push("close"));
    setTimeout(() => req.destroy(), 20);
    setTimeout(() => {
        console.log(events.join(","));
        if (typeof server.closeAllConnections === "function") server.closeAllConnections();
        server.close();
    }, 600);
});
