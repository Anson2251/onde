"use strict";

// Self-check for `js/lib/net.js`: the `net` surface over the M4 handle bridge.
//
//   ./target/debug/onde test/js/lib/net.test.js
//
// Plain Node skips it: the TCP tasks only exist under onde. Nothing here prints a port or a
// timing, so the output is stable run to run.

if (typeof globalThis.__ln_host !== "object") {
    console.log("skip: onde host unavailable");
    process.exit(0);
}

let net;
try {
    net = require("net");
} catch (_) {
    net = require("../../../js/lib/net.js");
}
let stream;
try {
    stream = require("stream");
} catch (_) {
    stream = require("../../../js/lib/stream.js");
}

let passed = 0;
let failed = 0;
const failures = [];

function record(condition, detail) {
    if (condition) passed += 1;
    else {
        failed += 1;
        failures.push(detail);
    }
}

function ok(value, message) {
    record(Boolean(value), `${message} (expected truthy, got ${String(value)})`);
}

function eq(actual, expected, message) {
    record(actual === expected, `${message} (expected ${String(expected)}, got ${String(actual)})`);
}

function throwsCode(fn, code, message) {
    try {
        fn();
        record(false, `${message} (expected a throw)`);
    } catch (error) {
        record(
            error !== null && typeof error === "object" && error.code === code,
            `${message} (code was ${error && error.code})`,
        );
    }
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function listen(server) {
    return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function closeServer(server) {
    return new Promise((resolve) => server.close(resolve));
}

// --- surface ---------------------------------------------------------------------------------

eq(typeof net.Socket, "function", "Socket is a class");
eq(typeof net.Server, "function", "Server is a class");
eq(typeof net.connect, "function", "connect is a function");
eq(typeof net.createConnection, "function", "createConnection is a function");
eq(typeof net.createServer, "function", "createServer is a function");
eq(typeof net.isIP, "function", "isIP is a function");
eq(typeof net.isIPv4, "function", "isIPv4 is a function");
eq(typeof net.isIPv6, "function", "isIPv6 is a function");
eq(typeof net.handleIdOf, "function", "handleIdOf is exported for http");
ok(new net.Socket() instanceof stream.Duplex, "Socket extends stream.Duplex");
ok(new net.Server() instanceof require("events").EventEmitter, "Server is an EventEmitter");

eq(net.isIP("127.0.0.1"), 4, "isIP recognises IPv4");
eq(net.isIP("::1"), 6, "isIP recognises IPv6");
eq(net.isIP("fe80::1%lo0"), 6, "isIP accepts a zone id");
eq(net.isIP("01.2.3.4"), 0, "isIP rejects IPv4 leading zeros");
eq(net.isIP("1::2::3"), 0, "isIP rejects a double ::");
eq(net.isIP("not-an-ip"), 0, "isIP rejects a hostname");
eq(net.isIP(4), 0, "isIP rejects a non-string");
ok(net.isIPv4("10.0.0.1"), "isIPv4 true for IPv4");
ok(!net.isIPv6("10.0.0.1"), "isIPv6 false for IPv4");

throwsCode(() => net.connect(), "ERR_MISSING_ARGS", "connect() needs options/port/path");
throwsCode(
    () => net.connect({ port: 70000 }),
    "ERR_SOCKET_BAD_PORT",
    "connect rejects an out-of-range port",
);
throwsCode(
    () => net.connect({ port: 80, family: 5 }),
    "ERR_INVALID_ARG_VALUE",
    "connect rejects a bad family",
);
throwsCode(
    () => net.createServer().listen({}),
    "ERR_INVALID_ARG_VALUE",
    "listen({}) needs port or path",
);
throwsCode(
    () => net.createServer().listen({ port: 0, backlog: "x" }),
    "ERR_INVALID_ARG_TYPE",
    "listen rejects a non-integer backlog",
);

// --- echo server / client, and the event order -----------------------------------------------

async function echoTest() {
    const clientEvents = [];
    const serverEvents = [];
    let resolveServerSocketClose;
    const serverSocketClosed = new Promise((resolve) => {
        resolveServerSocketClose = resolve;
    });
    const server = net.createServer((socket) => {
        serverEvents.push("connection");
        ok(socket instanceof net.Socket, "connection carries a net.Socket");
        eq(socket.remoteAddress, "127.0.0.1", "accepted socket has remoteAddress");
        eq(typeof socket.remotePort, "number", "accepted socket has a remotePort");
        eq(socket.remoteFamily, "IPv4", "accepted socket has remoteFamily");
        ok(typeof net.handleIdOf(socket) === "number", "accepted socket has a numeric handle id");
        ok(socket.readableFlowing !== true, "an accepted socket does not read until asked");
        eq(
            socket.address().port,
            server.address().port,
            "accepted socket.address() is the server side",
        );
        socket.on("data", (chunk) => {
            serverEvents.push("data");
            ok(Buffer.isBuffer(chunk), "socket data is a Buffer");
            socket.write(chunk);
        });
        socket.on("end", () => {
            serverEvents.push("end");
            socket.end();
        });
        socket.on("close", () => {
            serverEvents.push("close");
            resolveServerSocketClose();
        });
    });

    await listen(server);
    const address = server.address();
    eq(address.address, "127.0.0.1", "server.address().address");
    eq(address.family, "IPv4", "server.address().family");
    eq(typeof address.port, "number", "server.address().port is a number");
    ok(server.listening, "server.listening is true");

    await new Promise((resolve, reject) => {
        let received = "";
        const client = net.connect(address.port, "127.0.0.1", () => {
            clientEvents.push("connect");
            eq(client.readyState, "open", "readyState is open after connect");
            eq(client.remoteAddress, "127.0.0.1", "client.remoteAddress");
            eq(client.remoteFamily, "IPv4", "client.remoteFamily");
            eq(client.address().family, "IPv4", "client.address().family");
            ok(typeof client.address().port === "number", "client.address().port");
            ok(typeof net.handleIdOf(client) === "number", "client socket has a numeric handle id");
            eq(client.setNoDelay(true), client, "setNoDelay is chainable");
            eq(client.setKeepAlive(true, 1000), client, "setKeepAlive is chainable");
            eq(client.unref(), client, "unref is chainable");
            eq(client.ref(), client, "ref is chainable");
            client.end("ping");
        });
        client.on("data", (chunk) => {
            clientEvents.push("data");
            received += chunk.toString("utf8");
        });
        client.on("end", () => clientEvents.push("end"));
        client.on("error", reject);
        client.on("close", () => {
            clientEvents.push("close");
            eq(received, "ping", "the echo came back");
            eq(client.bytesRead, 4, "bytesRead counts the received bytes");
            ok(client.bytesWritten >= 4, "bytesWritten counts the written bytes");
            eq(client.readyState, "closed", "readyState is closed after close");
            resolve();
        });
    });

    // Server-side order for its own socket: connection, data, end, close.
    await serverSocketClosed;
    const serverSocketOrder = serverEvents;
    ok(serverSocketOrder.indexOf("connection") === 0, "connection precedes data");
    ok(serverSocketOrder.indexOf("data") !== -1, "the accepted socket received data");
    ok(
        serverSocketOrder.indexOf("data") < serverSocketOrder.indexOf("end"),
        "data precedes end on the accepted socket",
    );
    ok(
        serverSocketOrder.indexOf("end") < serverSocketOrder.indexOf("close"),
        "end precedes close on the accepted socket",
    );
    eq(
        clientEvents.join(","),
        "connect,data,end,close",
        "client order is connect, data, end, close",
    );

    await closeServer(server);
    eq(server.address(), null, "server.address() is null after close");
}

// --- half-close: the peer can still answer after `end()` -------------------------------------

async function halfCloseTest() {
    const server = net.createServer((socket) => {
        let data = "";
        socket.on("data", (chunk) => {
            data += chunk.toString("utf8");
            // Answer while the peer is half-closed: its `end()` sent FIN, but its read side is still
            // open, so this write and FIN are delivered.
            socket.end("late:" + data);
        });
    });
    await listen(server);
    const late = await new Promise((resolve, reject) => {
        const client = net.connect(server.address().port, "127.0.0.1", () => {
            // Send FIN immediately; the read side stays open for the answer (half-close).
            client.end("hi");
        });
        let got = "";
        client.on("data", (chunk) => {
            got += chunk.toString("utf8");
        });
        client.on("error", reject);
        client.on("end", () => resolve(got));
    });
    eq(late, "late:hi", "a half-closed client still reads the response");
    await delay(10);
    await closeServer(server);
}

// --- allowHalfOpen: true leaves the writable side open ---------------------------------------

async function allowHalfOpenTest() {
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
        let data = "";
        socket.on("data", (chunk) => {
            data += chunk.toString("utf8");
        });
        socket.on("end", () => {
            ok(socket.writable, "allowHalfOpen:true keeps writable open after end");
            setTimeout(() => socket.end("after:" + data), 5);
        });
    });
    await listen(server);
    const answer = await new Promise((resolve, reject) => {
        const client = net.connect(server.address().port, "127.0.0.1", () => client.end("x"));
        let got = "";
        client.on("data", (chunk) => {
            got += chunk.toString("utf8");
        });
        client.on("error", reject);
        client.on("end", () => resolve(got));
    });
    eq(answer, "after:x", "allowHalfOpen server can write after the peer FIN");
    await delay(10);
    await closeServer(server);
}

// --- pause / resume --------------------------------------------------------------------------

async function pauseResumeTest() {
    const server = net.createServer((socket) => {
        socket.write("one");
        setTimeout(() => socket.write("two"), 20);
        setTimeout(() => {
            socket.write("three");
            socket.end();
        }, 40);
    });
    await listen(server);

    const got = await new Promise((resolve, reject) => {
        const client = net.connect(server.address().port, "127.0.0.1");
        let text = "";
        let paused = false;
        client.on("data", (chunk) => {
            text += chunk.toString("utf8");
            if (!paused) {
                paused = true;
                client.pause();
                ok(client.isPaused(), "pause() is observable");
                eq(client.readableFlowing, false, "pause() stops flowing");
                setTimeout(() => {
                    client.resume();
                    eq(client.readableFlowing, true, "resume() restarts flowing");
                }, 50);
            }
        });
        client.on("error", reject);
        client.on("end", () => resolve(text));
    });
    eq(got, "onetwothree", "pause/resume loses no byte");
    await closeServer(server);
}

// --- backpressure: write() false and one 'drain' ---------------------------------------------

async function drainTest() {
    const size = 64 * 1024;
    const chunks = 16;
    const server = net.createServer((socket) => {
        let total = 0;
        socket.on("data", (chunk) => {
            total += chunk.length;
            if (total === size * chunks) socket.end("done");
        });
    });
    await listen(server);

    const result = await new Promise((resolve, reject) => {
        const client = net.connect(server.address().port, "127.0.0.1");
        const chunk = Buffer.alloc(size, 97);
        let drains = 0;
        let sawFalse = false;
        let answer = "";
        client.on("connect", () => {
            client.on("drain", () => {
                drains += 1;
            });
            for (let index = 0; index < chunks; index += 1) {
                if (client.write(chunk) === false) sawFalse = true;
            }
            ok(client.writableLength > 0, "writableLength reports bytes still with the task");
            ok(sawFalse, "a large write returns false");
        });
        client.on("data", (data) => {
            answer += data.toString("utf8");
        });
        client.on("error", reject);
        client.on("end", () => resolve({ drains, answer, sawFalse }));
    });

    ok(result.sawFalse, "write() returned false past the high-water mark");
    ok(result.drains >= 1, "'drain' is emitted after a false write");
    eq(result.answer, "done", "the server received the whole 1 MiB");
    await closeServer(server);
}

// --- setTimeout ------------------------------------------------------------------------------

async function timeoutTest() {
    const server = net.createServer((socket) => socket.resume());
    await listen(server);
    let fired = false;
    await new Promise((resolve, reject) => {
        const client = net.connect(server.address().port, "127.0.0.1");
        client.setTimeout(30, () => {
            fired = true;
            client.destroy();
        });
        client.on("error", reject);
        client.on("close", resolve);
    });
    ok(fired, "setTimeout emitted 'timeout'");
    await closeServer(server);
}

// --- destroy(err) emits locally, and double destroy is a no-op -------------------------------

async function destroyTest() {
    const server = net.createServer((socket) => socket.resume());
    await listen(server);
    const marker = new Error("local");
    marker.code = "ELOCAL";
    let errors = 0;
    let closes = 0;
    let client = null;
    await new Promise((resolve) => {
        client = net.connect(server.address().port, "127.0.0.1");
        client.on("error", (error) => {
            errors += 1;
            eq(error, marker, "destroy(err) emits the exact error object");
        });
        client.on("close", () => {
            closes += 1;
        });
        client.on("connect", () => {
            client.destroy(marker);
            client.destroy();
            setTimeout(resolve, 30);
        });
    });
    eq(errors, 1, "destroy(err) emits one error");
    eq(closes, 1, "double destroy emits one close");
    ok(client.destroyed, "a destroyed socket reports destroyed");
    await closeServer(server);
}

// --- a late consumer still gets bytes (no read before a consumer asks) -----------------------

async function lateConsumerTest() {
    const server = net.createServer((socket) => {
        socket.write("early");
        socket.end();
    });
    await listen(server);
    const client = net.connect(server.address().port, "127.0.0.1");
    await delay(25);
    eq(client.readableFlowing, null, "a socket with no consumer is not flowing");
    const text = await new Promise((resolve, reject) => {
        let got = "";
        client.on("data", (chunk) => {
            got += chunk.toString("utf8");
        });
        client.on("error", reject);
        client.on("end", () => resolve(got));
    });
    eq(text, "early", "bytes are delivered once a consumer attaches");
    await closeServer(server);
}

// --- unref lets the process exit while the server is still listening --------------------------

function unrefTest() {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
        server.unref();
        console.log("unref: listening, process should exit");
        // If the unref did not work, the process stays alive; this unref'd watchdog reports it and
        // fails instead of hanging the harness.
        const watchdog = setTimeout(() => {
            console.log("unref: FAIL (server kept the loop alive)");
            process.exit(1);
        }, 1500);
        watchdog.unref();
    });
}

// --- runner ----------------------------------------------------------------------------------

async function main() {
    await echoTest();
    await halfCloseTest();
    await allowHalfOpenTest();
    await pauseResumeTest();
    await drainTest();
    await timeoutTest();
    await destroyTest();
    await lateConsumerTest();
    console.log(`net: ${passed} passed, ${failed} failed`);
    for (const failure of failures) console.log(`fail: ${failure}`);
    if (failed !== 0) process.exitCode = 1;
    unrefTest();
}

main().catch((error) => {
    console.log(`net: FAIL ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
});
