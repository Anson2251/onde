"use strict";

// Self-check for `http`/`https` over the handle bridge.
//
// Skipped under plain Node: the host primitives that make the transport work only exist under
// onde. The assertions are still written against Node's observable semantics (status lines,
// header order, framing bytes, socket reuse), so a failure names the behaviour, never a port, a
// path or a timing.
//
//   ./target/debug/onde test/js/lib/http.test.js
//   ./test/js/run.sh

if (typeof globalThis.__ln_host !== "object") {
    console.log("skip: onde host unavailable");
    process.exit(0);
}

let http;
let https;
let net;
try {
    http = require("http");
    https = require("https");
    net = require("net");
} catch (_) {
    http = require("../../../js/lib/http.js");
    https = require("../../../js/lib/https.js");
    net = require("../../../js/lib/net.js");
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
    record(
        actual === expected,
        `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
    );
}

function deepEq(actual, expected, message) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    record(a === b, `${message} (expected ${b}, got ${a})`);
}

function throwsCode(fn, code, message) {
    try {
        fn();
        record(false, `${message} (expected a throw)`);
    } catch (error) {
        record(
            error !== null && typeof error === "object" && error.code === code,
            `${message} (code was ${error && error.code}, expected ${code})`,
        );
    }
}

// --- helpers ---------------------------------------------------------------------------------

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", reject);
            resolve(server.address().port);
        });
    });
}

function closeServer(server) {
    return new Promise((resolve) => {
        server.close(() => resolve());
    });
}

/// One raw request on a fresh connection; resolves when the peer closes (so use
/// `Connection: close`, or call `finishWrite`).
function rawRequest(port, text) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => socket.write(text));
        let data = "";
        socket.setEncoding("latin1");
        socket.on("data", (chunk) => {
            data += chunk;
        });
        socket.on("close", () => resolve(data));
        socket.on("error", reject);
    });
}

/// A request over a socket the caller owns, so keep-alive can be exercised.
function openSocket(port) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1");
        socket.setEncoding("latin1");
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
    });
}

function waitFor(read, predicate, what) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        function poll() {
            const value = read();
            if (predicate(value)) {
                resolve(value);
                return;
            }
            if (Date.now() - started > 5000) {
                reject(new Error(`timed out waiting for ${what}`));
                return;
            }
            setTimeout(poll, 5);
        }
        poll();
    });
}

function get(port, path, options) {
    return new Promise((resolve, reject) => {
        const req = http.get(Object.assign({ host: "127.0.0.1", port, path }, options), (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
                body += chunk;
            });
            res.on("end", () => resolve({ res, body }));
        });
        req.on("error", reject);
    });
}

function splitResponse(text) {
    const index = text.indexOf("\r\n\r\n");
    return {
        head: index === -1 ? text : text.slice(0, index),
        body: index === -1 ? "" : text.slice(index + 4),
    };
}

function statusLine(head) {
    return head.split("\r\n")[0];
}

function header(head, name) {
    const lines = head.split("\r\n");
    for (let i = 1; i < lines.length; i += 1) {
        const colon = lines[i].indexOf(":");
        if (colon !== -1 && lines[i].slice(0, colon).toLowerCase() === name.toLowerCase()) {
            return lines[i].slice(colon + 1).trim();
        }
    }
    return undefined;
}

// --- surface ---------------------------------------------------------------------------------

ok(typeof http.createServer === "function", "http.createServer is a function");
ok(typeof http.request === "function", "http.request is a function");
ok(typeof http.get === "function", "http.get is a function");
ok(typeof http.Agent === "function", "http.Agent is a function");
ok(http.globalAgent instanceof http.Agent, "globalAgent is an Agent");
eq(http.STATUS_CODES[200], "OK", "STATUS_CODES[200]");
eq(http.STATUS_CODES[404], "Not Found", "STATUS_CODES[404]");
ok(http.METHODS.indexOf("GET") !== -1, "METHODS contains GET");
eq(http.maxHeaderSize, 16384, "maxHeaderSize is 16 KiB");
throwsCode(
    () => http.validateHeaderName("bad name"),
    "ERR_INVALID_HTTP_TOKEN",
    "validateHeaderName rejects a space",
);
throwsCode(
    () => http.validateHeaderValue("x", "a\r\nb"),
    "ERR_INVALID_CHAR",
    "validateHeaderValue rejects CRLF",
);
// `https` is a real transport since WP6; its round trip lives in `https.test.js`. Only the
// surface is asserted here, because `http` and `https` share the same `internal/http` client.
ok(typeof https.request === "function", "https.request is a function");
ok(typeof https.Agent === "function", "https.Agent is a function");
ok(https.globalAgent instanceof https.Agent, "https.globalAgent is an https.Agent");
throwsCode(
    () => https.createServer(),
    "ERR_INVALID_ARG_VALUE",
    "https.createServer requires cert and key",
);

const WATCHDOG = setTimeout(() => {
    console.log("not ok: test watchdog expired");
    process.exit(1);
}, 20000);
if (WATCHDOG && typeof WATCHDOG.unref === "function") WATCHDOG.unref();

async function main() {
    // --- 1. round trip and rawHeaders/headers ------------------------------------------------

    let observedHeaders = null;
    const headerServer = http.createServer((req, res) => {
        observedHeaders = { raw: req.rawHeaders.slice(), headers: Object.assign({}, req.headers) };
        eq(req.method, "GET", "server sees the method");
        eq(req.url, "/headers?q=1", "server sees the target");
        eq(req.httpVersion, "1.1", "server sees HTTP/1.1");
        res.setHeader("X-Test", "yes");
        res.end("hello");
    });
    let port = await listen(headerServer);
    let text = await rawRequest(
        port,
        "GET /headers?q=1 HTTP/1.1\r\n" +
            "hOsT: Example\r\n" +
            "X-Dup: one\r\n" +
            "x-dup: two\r\n" +
            "Set-Cookie: a=1\r\n" +
            "Set-Cookie: b=2\r\n" +
            "Connection: close\r\n\r\n",
    );
    let parts = splitResponse(text);
    eq(statusLine(parts.head), "HTTP/1.1 200 OK", "status line");
    eq(header(parts.head, "X-Test"), "yes", "response header is serialized in its original case");
    eq(header(parts.head, "Content-Length"), "5", "known body gets Content-Length");
    eq(parts.body, "hello", "response body");
    ok(observedHeaders !== null, "request handler ran");
    if (observedHeaders !== null) {
        deepEq(
            observedHeaders.raw,
            [
                "hOsT",
                "Example",
                "X-Dup",
                "one",
                "x-dup",
                "two",
                "Set-Cookie",
                "a=1",
                "Set-Cookie",
                "b=2",
                "Connection",
                "close",
            ],
            "rawHeaders is wire order with the original case",
        );
        eq(observedHeaders.headers["x-dup"], "one, two", "duplicate headers are joined with ', '");
        deepEq(observedHeaders.headers["set-cookie"], ["a=1", "b=2"], "set-cookie stays an array");
        eq(observedHeaders.headers.host, "Example", "header names are lowercased in headers");
    }
    await closeServer(headerServer);

    // --- 2. client request/response and one keep-alive connection ----------------------------

    const clientPorts = [];
    const clientServer = http.createServer((req, res) => {
        clientPorts.push(req.socket.remotePort);
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
            body += chunk;
        });
        req.on("end", () => {
            res.setHeader("X-Echo", "1");
            res.end(`${req.method}:${req.url}:${body}`);
        });
    });
    port = await listen(clientServer);

    let first = await get(port, "/one");
    eq(first.res.statusCode, 200, "client statusCode");
    eq(first.res.httpVersion, "1.1", "client httpVersion");
    eq(first.res.headers["x-echo"], "1", "client header map");
    eq(first.body, "GET:/one:", "client response body");

    const chunked = await new Promise((resolve, reject) => {
        const req = http.request(
            { host: "127.0.0.1", port, path: "/two", method: "POST" },
            (res) => {
                let body = "";
                res.setEncoding("utf8");
                res.on("data", (d) => {
                    body += d;
                });
                res.on("end", () => resolve(body));
            },
        );
        req.on("error", reject);
        req.write("ab");
        req.end("cd");
    });
    eq(chunked, "POST:/two:abcd", "chunked client request body is de-framed by the server");
    eq(clientPorts.length, 2, "both requests handled");
    // The client and the server are in one process: both ports describe the same socket pair, so
    // equal counts here mean one reused connection.
    eq(new Set(clientPorts).size, 1, "the Agent reused one keep-alive connection");
    await closeServer(clientServer);
    http.globalAgent.destroy();

    // --- 3. HEAD and 204 have no body -------------------------------------------------------

    const headServer = http.createServer((req, res) => {
        if (req.url === "/head") {
            res.setHeader("X-Head", "1");
            res.end("ignored");
            return;
        }
        res.statusCode = 204;
        res.end("ignored");
    });
    port = await listen(headServer);
    text = await rawRequest(port, "HEAD /head HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    parts = splitResponse(text);
    eq(statusLine(parts.head), "HTTP/1.1 200 OK", "HEAD status line");
    eq(header(parts.head, "Transfer-Encoding"), undefined, "HEAD has no Transfer-Encoding");
    eq(parts.body, "", "HEAD has no body");
    text = await rawRequest(port, "GET /204 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    parts = splitResponse(text);
    eq(statusLine(parts.head), "HTTP/1.1 204 No Content", "204 status line");
    eq(header(parts.head, "Content-Length"), undefined, "204 has no Content-Length");
    eq(header(parts.head, "Transfer-Encoding"), undefined, "204 has no Transfer-Encoding");
    eq(parts.body, "", "204 has no body");
    await closeServer(headServer);

    // --- 4. chunked response ------------------------------------------------------------------

    const chunkedServer = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.write("ab");
        res.end("cd");
    });
    port = await listen(chunkedServer);
    text = await rawRequest(port, "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    parts = splitResponse(text);
    eq(header(parts.head, "Transfer-Encoding"), "chunked", "unknown response length is chunked");
    eq(parts.body, "2\r\nab\r\n2\r\ncd\r\n0\r\n\r\n", "chunked response wire body");
    await closeServer(chunkedServer);

    // --- 5. chunked request -------------------------------------------------------------------

    const chunkServer = http.createServer((req, res) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
            body += chunk;
        });
        req.on("end", () => {
            res.setHeader("X-Trailers", req.rawTrailers.length);
            res.end(body);
        });
    });
    port = await listen(chunkServer);
    text = await rawRequest(
        port,
        "POST / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n" +
            "3\r\nabc\r\n2\r\nde\r\n0\r\nX-Trailer: yes\r\nX-Trailer: two\r\n\r\n",
    );
    parts = splitResponse(text);
    eq(parts.body, "abcde", "chunked request is de-framed before 'data'");
    eq(header(parts.head, "X-Trailers"), "4", "trailers arrive on messageEnd as rawHeaders");
    await closeServer(chunkServer);

    // --- 6. keep-alive, one connection, two requests ------------------------------------------

    const keepServer = http.createServer((req, res) => {
        res.end(req.url);
    });
    port = await listen(keepServer);
    const socket = await openSocket(port);
    let received = "";
    let responses = 0;
    socket.on("data", (chunk) => {
        received += chunk;
    });
    socket.write("GET /one HTTP/1.1\r\nHost: x\r\n\r\n");
    await waitFor(
        () => received,
        (value) => value.includes("/one"),
        "the first keep-alive response",
    );
    ok(
        received.indexOf("Connection: keep-alive") !== -1,
        "HTTP/1.1 response keeps the connection alive",
    );
    socket.write("GET /two HTTP/1.1\r\nHost: x\r\n\r\n");
    await waitFor(
        () => received,
        (value) => value.includes("/two"),
        "the second response",
    );
    responses = (received.match(/HTTP\/1\.1 200 OK/g) || []).length;
    eq(responses, 2, "two responses on one connection");
    socket.destroy();
    await closeServer(keepServer);

    // --- 7. writeHead validation throws at the call site -------------------------------------

    const codes = [];
    const validationServer = http.createServer((req, res) => {
        function capture(fn) {
            try {
                fn();
            } catch (error) {
                codes.push(error.code);
            }
        }
        capture(() => res.writeHead(99));
        capture(() => res.setHeader("bad name", "x"));
        capture(() => res.setHeader("x", "a\r\nb"));
        capture(() => res.writeHead(200, "bad\r\nreason"));
        capture(() => http.validateHeaderValue("x", "a\0b"));
        res.statusCode = 204;
        res.end();
    });
    port = await listen(validationServer);
    text = await rawRequest(port, "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    deepEq(
        codes,
        [
            "ERR_HTTP_INVALID_STATUS_CODE",
            "ERR_INVALID_HTTP_TOKEN",
            "ERR_INVALID_CHAR",
            "ERR_INVALID_CHAR",
            "ERR_INVALID_CHAR",
        ],
        "writeHead/setHeader validation codes",
    );
    eq(
        statusLine(splitResponse(text).head),
        "HTTP/1.1 204 No Content",
        "validation did not send the bad head",
    );
    await closeServer(validationServer);

    // --- 8. checkContinue and writeContinue ---------------------------------------------------

    let checkContinueSeen = 0;
    const continueServer = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => res.end("done"));
    });
    continueServer.on("checkContinue", (req, res) => {
        checkContinueSeen += 1;
        res.writeContinue();
        res.end("checked");
    });
    port = await listen(continueServer);
    text = await rawRequest(
        port,
        "POST / HTTP/1.1\r\nHost: x\r\nExpect: 100-continue\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    );
    ok(
        text.includes("HTTP/1.1 100 Continue\r\n\r\n"),
        "'checkContinue' listener + writeContinue sends the interim response",
    );
    eq(
        splitResponse(text).body.includes("checked") || text.includes("checked"),
        true,
        "the final response follows the interim one",
    );
    eq(checkContinueSeen, 1, "checkContinue fired once");
    await closeServer(continueServer);

    const defaultContinueServer = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => res.end("auto"));
    });
    port = await listen(defaultContinueServer);
    text = await rawRequest(
        port,
        "POST / HTTP/1.1\r\nHost: x\r\nExpect: 100-continue\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    );
    ok(
        text.startsWith("HTTP/1.1 100 Continue\r\n\r\n"),
        "without a listener the server answers 100 automatically",
    );
    await closeServer(defaultContinueServer);

    // --- 9. clientError on a malformed request ----------------------------------------------

    let clientErrors = 0;
    let clientErrorCode = null;
    let clientErrorSocket = null;
    const errorServer = http.createServer((req, res) => res.end("unreachable"));
    errorServer.on("clientError", (error, socket) => {
        clientErrors += 1;
        clientErrorCode = error && error.code;
        clientErrorSocket = socket;
    });
    port = await listen(errorServer);
    text = await rawRequest(port, "NOT A REQUEST\r\n\r\n");
    eq(clientErrors, 1, "clientError fired once");
    eq(clientErrorCode, "ERR_HTTP_PARSE", "clientError carries the parse error code");
    ok(
        clientErrorSocket !== null && typeof clientErrorSocket.destroy === "function",
        "clientError receives the socket",
    );
    ok(
        statusLine(splitResponse(text).head).startsWith("HTTP/1.1 400"),
        "the task answers 400 before closing",
    );
    await closeServer(errorServer);

    // --- 10. upgrade --------------------------------------------------------------------------

    let upgradeSeen = false;
    const upgradeServer = http.createServer((req, res) => res.end("not an upgrade"));
    upgradeServer.on("upgrade", (req, socket, head) => {
        upgradeSeen = true;
        eq(req.headers.upgrade, "websocket", "upgrade request header");
        eq(head.length, 0, "upgrade head is a Buffer");
        socket.write(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
        );
        socket.once("data", (data) => {
            eq(data.toString(), "ping", "upgraded socket carries raw bytes after detach");
            socket.end();
        });
    });
    port = await listen(upgradeServer);
    const upgrade = await openSocket(port);
    let upgradeText = "";
    // Record the close before the write: the socket can close faster than `waitFor` resolves, and a
    // `once("close")` attached afterwards would never fire.
    let upgradeClosed = false;
    upgrade.on("close", () => {
        upgradeClosed = true;
    });
    upgrade.on("data", (chunk) => {
        upgradeText += chunk;
        if (upgradeText.includes("\r\n\r\n")) upgrade.write("ping");
    });
    upgrade.write(
        "GET /up HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
    await waitFor(
        () => upgradeSeen,
        (value) => value === true,
        "the upgrade event",
    );
    await waitFor(
        () => upgradeClosed,
        (value) => value === true,
        "the upgraded socket to close",
    );
    await closeServer(upgradeServer);

    // --- 11. client abort ---------------------------------------------------------------------

    const slowServer = http.createServer((req, res) => {
        setTimeout(() => res.end("late"), 100);
    });
    port = await listen(slowServer);
    const aborted = await new Promise((resolve) => {
        const req = http.request({ host: "127.0.0.1", port, path: "/" });
        req.on("error", () => resolve("error"));
        req.on("close", () => resolve("close"));
        req.end();
        setTimeout(() => req.abort(), 5);
    });
    eq(aborted, "error", "abort before a response emits a request error");
    await closeServer(slowServer);
}

main().then(
    () => {
        clearTimeout(WATCHDOG);
        if (failed === 0) {
            console.log(`ok: ${passed} assertions`);
            process.exit(0);
        }
        for (const failure of failures) console.log(`not ok: ${failure}`);
        console.log(`${failed} failed, ${passed} passed`);
        process.exit(1);
    },
    (error) => {
        clearTimeout(WATCHDOG);
        console.log(`not ok: ${error && error.stack ? error.stack : error}`);
        process.exit(1);
    },
);
