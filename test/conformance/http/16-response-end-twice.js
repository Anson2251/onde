"use strict";

// `res.end()` twice, and `res.write()` after end: the second write reports
// ERR_STREAM_WRITE_AFTER_END on the response (asynchronously), the first body is still delivered
// once, and the socket closes cleanly.

const http = require("http");
const net = require("net");

const server = http.createServer((req, res) => {
    const events = [];
    res.on("error", (error) => events.push(`error:${error.code}`));
    res.on("finish", () => {
        events.push("finish");
        setTimeout(() => console.log(`server:${events.join(",")}`), 20);
    });
    res.end("first");
    try {
        res.write("second");
        events.push("write-returned");
    } catch (error) {
        events.push(`write-threw:${error.code}`);
    }
});

server.listen(0, "127.0.0.1", () => {
    const socket = net.connect(server.address().port, "127.0.0.1", () => {
        socket.write("GET / HTTP/1.1\r\nHost: example\r\nConnection: close\r\n\r\n");
    });
    let data = "";
    socket.setEncoding("latin1");
    socket.on("data", (chunk) => {
        data += chunk;
    });
    socket.on("close", () => {
        const split = data.indexOf("\r\n\r\n");
        console.log(`status:${data.split("\r\n")[0]}`);
        console.log(`body:${JSON.stringify(data.slice(split + 4))}`);
        setTimeout(() => server.close(), 30);
    });
});
