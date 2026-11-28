"use strict";

// https server + https.get with the fixture CA: status, selected headers, body, and the TLS
// socket surface. Everything printed is deterministic (no Date, no ports, no cipher names).

const https = require("https");
const fs = require("fs");
const path = require("path");

const fixtures = path.join(__dirname, "../../fixtures/tls");
const key = fs.readFileSync(path.join(fixtures, "server-key.pem"));
const cert = fs.readFileSync(path.join(fixtures, "server-cert.pem"));
const ca = fs.readFileSync(path.join(fixtures, "ca-cert.pem"));

const server = https.createServer({ key, cert, ALPNProtocols: ["http/1.1"] }, (req, res) => {
    res.setHeader("Content-Type", "text/plain");
    res.setHeader("X-Test", "value");
    res.end(`hello ${req.method} ${req.url}`);
});

server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    const req = https.get(
        {
            host: "127.0.0.1",
            port,
            path: "/tls",
            ca,
            ALPNProtocols: ["http/1.1"],
        },
        (res) => {
            const socket = res.socket;
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
                body += chunk;
            });
            res.on("end", () => {
                console.log(`status:${res.statusCode}`);
                for (const name of ["content-type", "x-test", "connection", "content-length"]) {
                    console.log(`${name}:${res.headers[name]}`);
                }
                console.log(`body:${body}`);
                console.log(`protocol:${req.protocol}`);
                console.log(`encrypted:${socket.encrypted}`);
                console.log(`authorized:${socket.authorized}`);
                console.log(`authorizationError:${String(socket.authorizationError)}`);
                console.log(`alpn:${socket.alpnProtocol}`);
                console.log(`tlsVersion:${socket.getProtocol().startsWith("TLSv")}`);
                console.log(`peerCertificate:${typeof socket.getPeerCertificate()}`);
                server.close();
            });
        },
    );
    req.on("error", (error) => {
        console.log(`error:${error.code}`);
        server.close();
    });
});
