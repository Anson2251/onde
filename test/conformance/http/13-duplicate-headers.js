"use strict";

// Duplicate request headers: most names join with ", ", `cookie` joins with "; ", and
// `set-cookie` is the one response header that must stay an array. `rawHeaders` keeps wire order
// and case for both directions.

const http = require("http");
const net = require("net");

const server = http.createServer((req, res) => {
    console.log(`headers:${JSON.stringify(req.headers)}`);
    console.log(`raw:${JSON.stringify(req.rawHeaders)}`);
    res.setHeader("Set-Cookie", ["a=1", "b=2"]);
    res.setHeader("X-Merge", ["one", "two"]);
    res.end("ok");
});

server.listen(0, "127.0.0.1", () => {
    const socket = net.connect(server.address().port, "127.0.0.1", () => {
        socket.write(
            "GET / HTTP/1.1\r\nHost: example\r\nX-Dup: a\r\nx-dup: b\r\n" +
                "Cookie: x=1\r\nCookie: y=2\r\nConnection: close\r\n\r\n",
        );
    });
    let data = "";
    socket.setEncoding("latin1");
    socket.on("data", (chunk) => {
        data += chunk;
    });
    socket.on("close", () => {
        const lines = data.split("\r\n");
        const selected = lines
            .filter((line) => /^(set-cookie|x-merge|connection|content-length):/i.test(line))
            .map((line) => line.toLowerCase());
        console.log(`response-headers:${selected.join("|")}`);
        server.close();
    });
});
