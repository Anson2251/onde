"use strict";

// HTTP(S) client used by every "client" leg of test/net/interop.sh. It runs under node and under
// onde, so its assertions are the shared contract:
//
//   <runtime> http-client.js <port-file>
//
// Exit 0 when every assertion holds, 1 otherwise. One line on success; on failure, one line per
// failed assertion. Never prints the port.

const fs = require("fs");

const tls = process.env.INTEROP_TLS === "1";
const http = tls ? require("https") : require("http");
const port = Number(fs.readFileSync(process.argv[2], "utf8"));
const host = "127.0.0.1";

const options = {};
if (tls) {
    options.ca = fs.readFileSync(process.env.TLS_CA);
    options.servername = "localhost";
}

const failures = [];

function check(condition, label, detail) {
    if (!condition) failures.push(`${label} (${detail})`);
}

function get(pathname) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host, port, path: pathname, agent, ...options }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => resolve({ res, body: Buffer.concat(chunks).toString("utf8") }));
        });
        req.on("error", reject);
    });
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

async function main() {
    const first = await get("/ok");
    check(first.res.statusCode === 200, "status", first.res.statusCode);
    check(first.res.headers["x-custom"] === "ValueCase", "custom", first.res.headers["x-custom"]);
    const raw = first.res.rawHeaders || [];
    const rawIndex = raw.indexOf("X-Custom");
    check(
        rawIndex !== -1 && raw[rawIndex + 1] === "ValueCase",
        "rawHeaders-case",
        JSON.stringify(raw),
    );
    check(first.body === "hello", "body", JSON.stringify(first.body));
    check(
        first.res.headers["x-connection-requests"] === "1",
        "first-request-count",
        first.res.headers["x-connection-requests"],
    );

    // Give the agent a tick to park the socket in its free pool before the second request.
    await delay(20);
    const second = await get("/ok");
    check(
        second.res.headers["x-connection-requests"] === "2",
        "keep-alive-reuse",
        second.res.headers["x-connection-requests"],
    );
    check(second.body === "hello", "second-body", JSON.stringify(second.body));

    const chunked = await get("/chunked");
    check(
        /chunked/i.test(chunked.res.headers["transfer-encoding"] || ""),
        "chunked-header",
        chunked.res.headers["transfer-encoding"],
    );
    check(chunked.body === "chunk-onechunk-two", "chunked-body", JSON.stringify(chunked.body));

    agent.destroy();

    if (failures.length > 0) {
        console.error(`FAIL ${failures.length} assertion(s)`);
        for (const failure of failures) console.error(`  ${failure}`);
        process.exit(1);
    }
    console.log("status=200 custom=ValueCase rawHeaders=X-Custom body=hello reuse=2 chunked=ok");
}

main().catch((error) => {
    console.error(`FAIL ${error && error.code ? error.code : error}`);
    agent.destroy();
    process.exit(1);
});
