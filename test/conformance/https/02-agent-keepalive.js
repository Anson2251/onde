"use strict";

// An https.Agent pools TLS sockets: three sequential requests over one agent, printing whether
// each reused the previous socket. No port, no Date.

const https = require("https");
const fs = require("fs");
const path = require("path");

const fixtures = path.join(__dirname, "../../fixtures/tls");
const key = fs.readFileSync(path.join(fixtures, "server-key.pem"));
const cert = fs.readFileSync(path.join(fixtures, "server-cert.pem"));
const ca = fs.readFileSync(path.join(fixtures, "ca-cert.pem"));

const server = https.createServer({ key, cert, ALPNProtocols: ["http/1.1"] }, (req, res) => {
    res.end("ok");
});

server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    const agent = new https.Agent({ keepAlive: true, maxSockets: 4 });
    const results = [];

    function request(index) {
        const req = https.request(
            { host: "127.0.0.1", port, path: `/${index}`, ca, agent, ALPNProtocols: ["http/1.1"] },
            (res) => {
                res.resume();
                res.on("end", () => {
                    results.push(`${index}:${req.reusedSocket}`);
                    if (results.length < 3) {
                        // Give the agent a tick to return the socket to its free list: Node's own
                        // `reusedSocket` flag depends on that ordering, so a fixed delay keeps the recorded
                        // output stable across runtimes and runs.
                        setTimeout(() => request(index + 1), 20);
                    } else {
                        console.log(results.join(","));
                        console.log(`pooled:${Object.keys(agent.sockets).length}`);
                        agent.destroy();
                        server.close();
                    }
                });
            },
        );
        req.on("error", (error) => {
            console.log(`error:${error.code}`);
            server.close();
        });
        req.end();
    }

    request(0);
});
