"use strict";

// Probe whether the runtime under test can actually serve TLS. `interop.sh` runs this under onde
// and prints a skip line when it fails, so the TLS legs appear automatically once WP6 lands.
//
//   <runtime> tls-probe.js <key.pem> <cert.pem>
//
// Exit 0 only when a TLS listener reaches `'listening'`.

const fs = require("fs");
const https = require("https");

const key = fs.readFileSync(process.argv[2]);
const cert = fs.readFileSync(process.argv[3]);

let server;
try {
  server = https.createServer({ key, cert }, (req, res) => res.end("ok"));
} catch (error) {
  console.error(`tls-probe: ${error.code || error.message}`);
  process.exit(1);
}

server.on("error", (error) => {
  console.error(`tls-probe: ${error.code || error.message}`);
  process.exit(1);
});

server.listen(0, "127.0.0.1", () => {
  server.close(() => process.exit(0));
});
