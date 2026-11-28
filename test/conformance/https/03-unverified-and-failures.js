"use strict";

// The three client-side TLS outcomes, printed as codes only (the messages are OpenSSL's in Node
// and rustls' here; D41 records that):
//   * `rejectUnauthorized: false` completes the handshake and reports an unauthorized socket,
//   * an untrusted CA fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE,
//   * a servername that is not in the certificate fails with ERR_TLS_CERT_ALTNAME_INVALID.

const https = require("https");
const fs = require("fs");
const path = require("path");

const fixtures = path.join(__dirname, "../../fixtures/tls");
const key = fs.readFileSync(path.join(fixtures, "server-key.pem"));
const cert = fs.readFileSync(path.join(fixtures, "server-cert.pem"));
const ca = fs.readFileSync(path.join(fixtures, "ca-cert.pem"));
const otherCa = fs.readFileSync(path.join(fixtures, "other-ca-cert.pem"));

const server = https.createServer({ key, cert }, (req, res) => {
    res.end("ok");
});

function failure(options, label) {
    return new Promise((resolve) => {
        const req = https.request(
            Object.assign({ host: "127.0.0.1", port: server.address().port }, options),
            () => {
                console.log(`${label}:unexpected-success`);
                resolve();
            },
        );
        req.on("error", (error) => {
            console.log(`${label}:${error.code}`);
            resolve();
        });
        req.end();
    });
}

server.listen(0, "127.0.0.1", async () => {
    await new Promise((resolve) => {
        const req = https.get(
            { host: "127.0.0.1", port: server.address().port, rejectUnauthorized: false },
            (res) => {
                const socket = res.socket;
                console.log(
                    `unverified:${res.statusCode}:${socket.encrypted}:${socket.authorized}`,
                );
                console.log(`unverified-error:${socket.authorizationError}`);
                res.resume();
                res.on("end", resolve);
            },
        );
        req.on("error", (error) => {
            console.log(`unverified:${error.code}`);
            resolve();
        });
    });

    await failure({ ca: otherCa, agent: false }, "untrusted");
    await failure({ ca, servername: "wrong.example", agent: false }, "altname");
    server.close();
});
