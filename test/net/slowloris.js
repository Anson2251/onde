"use strict";

// Half-open connection generator for test/net/slowloris.sh.
//
//   node slowloris.js <port-file> <connections>
//
// Each connection writes one partial request head (no blank line) and then sits idle, holding the
// server's parser state without completing a request. Prints `OPEN:<n>` once all sockets are
// connected (or `OPEN:<n> ERRORS:<m>` if some could not be opened), then stays alive until
// SIGTERM/SIGINT. No request is ever completed.

const fs = require("fs");
const net = require("net");

const port = Number(fs.readFileSync(process.argv[2], "utf8"));
const total = Number(process.argv[3] || 2000);
const batch = Number(process.env.NET_SLOWLORIS_BATCH || 200);

const sockets = [];
let connected = 0;
let errors = 0;
let launched = 0;
let stopped = false;

const partial = "GET / HTTP/1.1\r\nHost: example\r\nX-Partial: ";

function openOne() {
    const socket = net.connect(port, "127.0.0.1");
    sockets.push(socket);
    socket.setNoDelay(true);
    socket.on("connect", () => {
        socket.write(partial);
        connected += 1;
        maybeDone();
    });
    socket.on("error", () => {
        errors += 1;
        maybeDone();
    });
}

function maybeDone() {
    if (launched < total) return;
    // Every launched socket has either connected or errored.
    if (connected + errors < total) return;
    console.log(`OPEN:${connected}${errors > 0 ? ` ERRORS:${errors}` : ""}`);
    launched = total + 1; // one-shot
}

// Keep the process (and all sockets) alive until the harness is done.
setInterval(() => {}, 1000);

function pump() {
    if (stopped) return;
    const target = Math.min(total, launched + batch);
    while (launched < target) {
        launched += 1;
        openOne();
    }
    if (launched < total) setTimeout(pump, 20);
    else maybeDone();
}

function shutdown() {
    stopped = true;
    for (const socket of sockets) socket.destroy();
    process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
pump();
