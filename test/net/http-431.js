"use strict";

// 431 end-to-end probe for test/net/slowloris.sh: a single connection whose request head exceeds
// the server's default maxHeaderSize must get `HTTP/1.1 431` and be closed (m4-plan §8).
//
//   node http-431.js <port-file>

const fs = require("fs");
const net = require("net");

const port = Number(fs.readFileSync(process.argv[2], "utf8"));
const socket = net.connect(port, "127.0.0.1", () => {
    socket.write(`GET / HTTP/1.1\r\nHost: example\r\nX-Big: ${"a".repeat(20000)}\r\n\r\n`);
});

let data = "";
let closed = false;
socket.setEncoding("latin1");
socket.on("data", (chunk) => {
    data += chunk;
});

const timer = setTimeout(() => {
    console.log("timeout");
    socket.destroy();
    process.exit(1);
}, 5000);

socket.on("close", () => {
    closed = true;
    clearTimeout(timer);
    const status = data.split("\r\n")[0];
    console.log(`status:${status}`);
    console.log(`closed:${closed}`);
    if (!/^HTTP\/1\.1 431/.test(status) || !closed) process.exit(1);
});

socket.on("error", (error) => {
    clearTimeout(timer);
    console.log(`error:${error.code}`);
    process.exit(1);
});
