"use strict";

// TCP echo client for test/perf/echo.sh. Run under node against either runtime's echo server.
//
//   node test/perf/echo.js <port> <connections> <rounds> [payload-bytes]
//
// Each connection does <rounds> sequential round trips: write a payload, wait for exactly that many
// bytes back, record the round-trip time. Sequential round trips (rather than pipelining) are what
// a request/response workload pays, and they make the latency number mean one thing.
//
// Prints one RESULT line: connections, rounds, total round trips, requests/s over the measured
// phase, and p50/p99. Exits 1 on any socket error or short echo.

const net = require("net");

const port = Number(process.argv[2]);
const connections = Number(process.argv[3] || 20);
const rounds = Number(process.argv[4] || 200);
const payloadBytes = Number(process.argv[5] || 1024);

if (!port) {
    console.error("usage: echo.js <port> <connections> <rounds> [payload-bytes]");
    process.exit(2);
}

const payload = Buffer.alloc(payloadBytes, 0x61);
const latencies = new Float64Array(connections * rounds);
let slot = 0;
let failures = 0;

function oneConnection() {
    return new Promise((resolve) => {
        const socket = net.connect(port, "127.0.0.1");
        let received = 0;
        let sentAt = 0n;
        let index = 0;

        function done() {
            socket.end();
            resolve();
        }

        function next() {
            if (index === rounds) return done();
            received = 0;
            sentAt = process.hrtime.bigint();
            socket.write(payload);
        }

        socket.on("data", (chunk) => {
            received += chunk.length;
            if (received < payloadBytes) return;
            const elapsed = Number(process.hrtime.bigint() - sentAt) / 1e6;
            latencies[slot] = elapsed;
            slot += 1;
            index += 1;
            next();
        });
        socket.on("error", () => {
            failures += 1;
            socket.destroy();
            resolve();
        });
        socket.on("connect", next);
    });
}

async function main() {
    const started = process.hrtime.bigint();
    const sockets = [];
    for (let i = 0; i < connections; i += 1) sockets.push(oneConnection());
    await Promise.all(sockets);
    const elapsed = Number(process.hrtime.bigint() - started) / 1e9;

    if (failures !== 0 || slot !== connections * rounds) {
        console.error(
            `echo: ${failures} socket errors, ${slot}/${connections * rounds} round trips`,
        );
        process.exit(1);
    }

    const measured = latencies.subarray(0, slot).sort();
    const p50 = measured[Math.floor(0.5 * (slot - 1))];
    const p99 = measured[Math.floor(0.99 * (slot - 1))];
    console.log(
        `RESULT connections=${connections} rounds=${rounds} round_trips=${slot} rps=${(slot / elapsed).toFixed(1)} ` +
            `p50_ms=${p50.toFixed(3)} p99_ms=${p99.toFixed(3)}`,
    );
}

main();
