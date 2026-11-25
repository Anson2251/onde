"use strict";

// Self-check for `https` over the handle bridge: a real rustls handshake against the committed
// fixture certificates, the options Node honours, and the socket surface.
//
// Skipped under plain Node (the host primitives only exist under onde). Nothing prints a port or
// a timing, and the fixtures are test-only (`test/fixtures/tls/generate.sh` regenerates them).
//
//   ./target/debug/onde test/js/lib/https.test.js
//   ./test/js/run.sh

if (typeof globalThis.__ln_host !== "object") {
  console.log("skip: onde host unavailable");
  process.exit(0);
}

const fs = require("fs");
const path = require("path");

let https;
let tls;
let net;
try {
  https = require("https");
  tls = require("tls");
  net = require("net");
} catch (_) {
  https = require("../../../js/lib/https.js");
  tls = require("../../../js/lib/tls.js");
  net = require("../../../js/lib/net.js");
}

const FIXTURES = path.join(__dirname, "../../fixtures/tls");
const ca = fs.readFileSync(path.join(FIXTURES, "ca-cert.pem"));
const otherCa = fs.readFileSync(path.join(FIXTURES, "other-ca-cert.pem"));
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

function ne(actual, unexpected, message) {
  record(
    actual !== unexpected,
    `${message} (expected anything but ${JSON.stringify(unexpected)})`,
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
  return new Promise((resolve) => server.close(() => resolve()));
}

function tlsServer(handler) {
  return https.createServer({ key: serverKey, cert: serverCert, ALPNProtocols: ["http/1.1"] }, handler);
}

/// One HTTPS request. `options` are Node's; the fixture CA is the default so the round trip works.
function request(port, options) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      Object.assign({ host: "127.0.0.1", port, path: "/", ca }, options),
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ res, body, req, socket: res.socket }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/// A request whose only outcome should be an error; resolves with `{ code, errors }`.
function requestError(port, options) {
  return new Promise((resolve, reject) => {
    let errors = [];
    const req = https.request(Object.assign({ host: "127.0.0.1", port, path: "/" }, options), () => {
      reject(new Error("expected the request to fail"));
    });
    req.on("error", (error) => {
      errors.push(error.code);
    });
    req.on("close", () => resolve({ errors, code: errors[0] }));
    req.end();
  });
}

const WATCHDOG = setTimeout(() => {
  console.log("not ok: test watchdog expired");
  process.exit(1);
}, 20000);
if (WATCHDOG && typeof WATCHDOG.unref === "function") WATCHDOG.unref();

async function main() {
  // --- 1. surface ---------------------------------------------------------------------------

  ok(typeof https.createServer === "function", "https.createServer is a function");
  ok(typeof https.request === "function", "https.request is a function");
  ok(https.globalAgent instanceof https.Agent, "https.globalAgent is an https.Agent");
  ok(
    typeof https.Agent.prototype.createConnection === "function",
    "https.Agent can create its own connections",
  );
  eq(tls.DEFAULT_MIN_VERSION, "TLSv1.2", "tls.DEFAULT_MIN_VERSION");
  eq(tls.DEFAULT_MAX_VERSION, "TLSv1.3", "tls.DEFAULT_MAX_VERSION");
  throwsCode(
    () => https.createServer(),
    "ERR_INVALID_ARG_VALUE",
    "https.createServer requires cert and key",
  );

  // --- 2. round trip, ALPN and the socket surface --------------------------------------------

  let serverAlpn = null;
  let serverProtocol = null;
  let serverEncrypted = null;
  const server = tlsServer((req, res) => {
    serverAlpn = req.socket.alpnProtocol;
    serverProtocol = req.socket.getProtocol();
    serverEncrypted = req.socket.encrypted;
    res.setHeader("Content-Type", "text/plain");
    res.end(`hello ${req.url.slice(1)}`);
  });
  const port = await listen(server);

  const first = await request(port, { path: "/tls", ALPNProtocols: ["http/1.1"] });
  eq(first.res.statusCode, 200, "status is 200");
  eq(first.body, "hello tls", "the body round-trips");
  eq(first.socket.encrypted, true, "the client socket is encrypted");
  eq(first.socket.authorized, true, "the fixture CA verifies the server");
  eq(first.socket.authorizationError, null, "no authorization error");
  eq(first.socket.alpnProtocol, "http/1.1", "ALPN negotiated http/1.1");
  ok(
    typeof first.socket.getProtocol() === "string" && first.socket.getProtocol().startsWith("TLSv"),
    "getProtocol() reports a TLS version",
  );
  eq(typeof first.socket.getPeerCertificate(), "object", "getPeerCertificate() returns an object");
  // No X.509 parser is linked in (D41): the shape is empty, not a parsed certificate.
  eq(Object.keys(first.socket.getPeerCertificate()).length, 0, "getPeerCertificate() is empty (D41)");
  eq(first.req.protocol, "https:", "the request protocol is https:");
  eq(serverEncrypted, true, "the server socket is encrypted");
  eq(serverAlpn, "http/1.1", "the server sees the negotiated ALPN");
  ok(
    typeof serverProtocol === "string" && serverProtocol.startsWith("TLSv"),
    "the server reports a TLS version",
  );

  // --- 3. keep-alive: an Agent pools TLS sockets and reuses them -----------------------------

  const agent = new https.Agent({ keepAlive: true, maxSockets: 4 });
  const reuse = [];
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await request(port, { path: `/reuse-${i}`, agent, ALPNProtocols: ["http/1.1"] });
    reuse.push(result.req.reusedSocket);
  }
  eq(reuse[0], false, "the first pooled request opens a socket");
  eq(reuse[1], true, "the second pooled request reuses it");
  eq(reuse[2], true, "the third pooled request reuses it");
  agent.destroy();

  // --- 4. rejectUnauthorized: false completes the handshake without the CA -------------------

  const unverified = await request(port, { path: "/unverified", rejectUnauthorized: false, agent: false });
  eq(unverified.res.statusCode, 200, "an unverified handshake still gets a response");
  eq(unverified.socket.encrypted, true, "the socket is still encrypted");
  eq(unverified.socket.authorized, false, "it is not authorized");
  ne(unverified.socket.authorizationError, null, "it carries an authorization error");

  // --- 5. an untrusted CA fails verification ------------------------------------------------

  const untrusted = await requestError(port, { ca: otherCa, agent: false });
  eq(untrusted.code, "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "an untrusted chain is rejected");
  eq(untrusted.errors.length, 1, "exactly one error is reported");

  // --- 6. a name mismatch is ERR_TLS_CERT_ALTNAME_INVALID -----------------------------------

  const mismatched = await requestError(port, { ca, servername: "wrong.example", agent: false });
  eq(mismatched.code, "ERR_TLS_CERT_ALTNAME_INVALID", "a wrong servername is reportable");

  // --- 7. https.get is request + end --------------------------------------------------------

  const got = await new Promise((resolve, reject) => {
    const req = https.get({ host: "127.0.0.1", port, path: "/get", ca }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
  });
  eq(got, "hello get", "https.get round-trips");

  // --- 8. tls.createServer / tls.connect ----------------------------------------------------

  let secureConnections = 0;
  const echo = tls.createServer({ key: serverKey, cert: serverCert, ALPNProtocols: ["echo"] }, (socket) => {
    socket.on("data", (chunk) => socket.write(chunk));
  });
  echo.on("secureConnection", (socket) => {
    secureConnections += 1;
    eq(socket.alpnProtocol, "echo", "the server-side socket knows its ALPN");
  });
  const echoPort = await listen(echo);
  const echoed = await new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host: "127.0.0.1", port: echoPort, ca, ALPNProtocols: ["echo"], servername: "localhost" },
      () => socket.write("ping"),
    );
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      socket.end();
      resolve(chunk);
    });
    socket.on("error", reject);
  });
  eq(echoed, "ping", "tls.connect echoes over TLS");
  eq(secureConnections, 1, "the server emitted secureConnection once");
  await closeServer(echo);

  // --- 9. a plaintext client against a TLS listener is a handshake error --------------------

  const rejected = await new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
    });
    socket.setEncoding("latin1");
    socket.on("data", () => {});
    socket.on("close", () => resolve("closed"));
    socket.on("error", () => resolve("error"));
  });
  eq(rejected, "closed", "a plaintext client is disconnected by the TLS listener");

  await closeServer(server);
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
