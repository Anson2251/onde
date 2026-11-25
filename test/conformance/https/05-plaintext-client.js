"use strict";

// A plaintext client against a TLS listener is rejected (Node's `tlsClientError`, here a closed
// connection), and the listener stays healthy: a real TLS request afterwards still succeeds.

const https = require("https");
const net = require("net");
const fs = require("fs");
const path = require("path");

const fixtures = path.join(__dirname, "../../fixtures/tls");
const key = fs.readFileSync(path.join(fixtures, "server-key.pem"));
const cert = fs.readFileSync(path.join(fixtures, "server-cert.pem"));
const ca = fs.readFileSync(path.join(fixtures, "ca-cert.pem"));

const server = https.createServer({ key, cert }, (req, res) => {
  res.end("still alive");
});
// Node reports the failed handshake here; the event does not exist in onde, which is why it is
// only listened to, never printed.
server.on("tlsClientError", () => {});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const plain = net.connect(port, "127.0.0.1", () => {
    plain.write("GET / HTTP/1.1\r\nHost: example\r\n\r\n");
  });
  plain.on("error", () => {});
  plain.on("data", () => {});
  plain.on("close", () => {
    console.log("plaintext:closed");
    const req = https.get({ host: "127.0.0.1", port, ca }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        console.log(`tls:${res.statusCode}:${body}`);
        server.close();
      });
    });
    req.on("error", (error) => {
      console.log(`tls:error:${error.code}`);
      server.close();
    });
  });
});
