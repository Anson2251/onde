"use strict";

// Self-check for the `tls` module itself: the socket/server classes, the option mapping, and the
// error codes the Rust side reports for bad PEM. The `https` round trip lives in
// `https.test.js`; this file is about the surface `tls` adds on top of `net`.
//
// Skipped under plain Node (the host primitives only exist under lite).
//
//   ./target/debug/lite test/js/lib/tls.test.js
//   ./test/js/run.sh

if (typeof globalThis.__ln_host !== "object") {
  console.log("skip: lite host unavailable");
  process.exit(0);
}

const fs = require("fs");
const path = require("path");

let tls;
let net;
let https;
try {
  tls = require("tls");
  net = require("net");
  https = require("https");
} catch (_) {
  tls = require("../../../js/lib/tls.js");
  net = require("../../../js/lib/net.js");
  https = require("../../../js/lib/https.js");
}

const FIXTURES = path.join(__dirname, "../../fixtures/tls");
const ca = fs.readFileSync(path.join(FIXTURES, "ca-cert.pem"));
const serverCert = fs.readFileSync(path.join(FIXTURES, "server-cert.pem"));
const serverKey = fs.readFileSync(path.join(FIXTURES, "server-key.pem"));

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
  return new Promise((resolve) => server.close(() => resolve()));
}

/// The first `error` event on a server, for the bad-PEM cases.
function serverError(server) {
  return new Promise((resolve) => server.once("error", (error) => resolve(error)));
}

const WATCHDOG = setTimeout(() => {
  console.log("not ok: test watchdog expired");
  process.exit(1);
}, 20000);
if (WATCHDOG && typeof WATCHDOG.unref === "function") WATCHDOG.unref();

async function main() {
  // --- 1. surface ---------------------------------------------------------------------------

  ok(typeof tls.connect === "function", "tls.connect is a function");
  ok(typeof tls.createServer === "function", "tls.createServer is a function");
  ok(tls.TLSSocket.prototype instanceof net.Socket, "TLSSocket extends net.Socket");
  ok(tls.Server.prototype instanceof net.Server, "tls.Server extends net.Server");
  eq(typeof tls.TLSSocket.prototype.isSessionReused, "function", "isSessionReused exists");
  throwsCode(() => tls.createServer({}), "ERR_INVALID_ARG_VALUE", "tls.createServer requires cert/key");
  throwsCode(
    () => tls.connect({ host: "127.0.0.1", port: 1, socket: {} }),
    "ERR_FEATURE_UNAVAILABLE",
    "tls.connect({socket}) is refused",
  );

  // --- 2. a handshake without ALPN ----------------------------------------------------------

  const server = tls.createServer({ key: serverKey, cert: serverCert }, (socket) => {
    socket.on("error", () => {});
    socket.end();
  });
  const port = await listen(server);

  const socket = await new Promise((resolve, reject) => {
    const client = tls.connect(
      { host: "127.0.0.1", port, ca, servername: "localhost" },
      () => resolve(client),
    );
    client.on("error", reject);
  });
  eq(socket.encrypted, true, "tls.connect returns an encrypted socket");
  eq(socket.authorized, true, "the fixture CA verifies the server");
  eq(socket.servername, "localhost", "servername is reported");
  eq(socket.alpnProtocol, false, "no ALPN offer means false, like Node");
  eq(socket.isSessionReused(), false, "no session cache (D41)");
  eq(Object.keys(socket.getPeerCertificate()).length, 0, "no X.509 parser (D41)");
  socket.destroy();

  // --- 3. a malformed CA is ERR_TLS_CA_INVALID ---------------------------------------------

  const badCa = await new Promise((resolve) => {
    const client = tls.connect(
      { host: "127.0.0.1", port, ca: "this is not a certificate" },
      () => resolve(null),
    );
    client.on("error", (error) => resolve(error.code));
    client.on("close", () => resolve(null));
  });
  eq(badCa, "ERR_TLS_CA_INVALID", "a malformed ca is ERR_TLS_CA_INVALID");
  await closeServer(server);

  // --- 4. a malformed server certificate is ERR_TLS_INVALID_CERT ---------------------------

  const badCert = tls.createServer({ key: serverKey, cert: "not a certificate" }, () => {});
  const certError = serverError(badCert);
  badCert.listen(0, "127.0.0.1");
  eq((await certError).code, "ERR_TLS_INVALID_CERT", "a malformed cert is ERR_TLS_INVALID_CERT");

  // --- 5. the https.Server shares the same server options ----------------------------------

  throwsCode(() => https.createServer({ key: serverKey }), "ERR_INVALID_ARG_VALUE", "https needs cert too");
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
