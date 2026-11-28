"use strict";

// The header accessors on ServerResponse: appendHeader extends a value into an array,
// getHeaders/getHeaderNames are case-insensitive, removeHeader forgets it, and validateHeaderName
// / validateHeaderValue throw the documented codes.

const http = require("http");
const net = require("net");

const server = http.createServer((req, res) => {
    res.setHeader("X-A", "1");
    res.appendHeader("X-A", "2");
    console.log(`has:${res.hasHeader("x-a")}`);
    console.log(`get:${JSON.stringify(res.getHeader("X-A"))}`);
    console.log(`names:${JSON.stringify(res.getHeaderNames())}`);
    const all = res.getHeaders();
    console.log(`all:${JSON.stringify(Object.keys(all).sort())}`);
    res.removeHeader("X-A");
    console.log(`after-remove:${res.hasHeader("x-a")}`);
    for (const [label, fn] of [
        ["name", () => http.validateHeaderName("Bad Name")],
        ["value", () => http.validateHeaderValue("X-A", "a\r\nb")],
    ]) {
        try {
            fn();
            console.log(`${label}:no-throw`);
        } catch (error) {
            console.log(`${label}:${error.code}`);
        }
    }
    res.end("ok");
});

server.listen(0, "127.0.0.1", () => {
    const socket = net.connect(server.address().port, "127.0.0.1", () => {
        socket.write("GET / HTTP/1.1\r\nHost: example\r\nConnection: close\r\n\r\n");
    });
    socket.resume();
    socket.on("close", () => server.close());
});
