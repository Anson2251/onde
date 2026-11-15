"use strict";

// A tiny in-process npm registry for `test/registry.test.js`.
//
// It uses `node:http` only, plus `crypto` for real `sha512-` integrity values and `zlib` for gzip
// bodies, and it runs under both `node` and `lite`. `start()` is async because a listening port is
// only knowable after the server's `listening` event:
//
//   const registry = await start();
//   // registry.url       "http://127.0.0.1:<port>"
//   // registry.requests  [{ method, url, headers }] for every request served, in order
//   // registry.tarballs  { "<url path>": Buffer } the exact bytes served for each tarball
//   // registry.close()   Promise that resolves once the listener is closed
//
// Routes:
//   GET /left-pad                        packument: 1.0.0, 1.3.0; dist-tags.latest = 1.3.0
//   GET /left-pad/-/left-pad-<v>.tgz     gzipped body for each of those versions
//   GET /redirect/left-pad               302 -> /left-pad
//   GET /redirect-loop                   302 -> /redirect-loop (exercises the redirect cap)
//   GET /broken                          200 with invalid JSON
//   GET /@scope%2Fthing                  scoped packument (the encoded form of @scope/thing)
//   GET /@scope/thing/-/thing-1.0.0.tgz  gzipped body for the scoped package
//   anything else                        404 JSON
//
// The tarball bodies are gzip of a small string, not a real ustar archive: this fixture tests the
// transport and its bytes, while unpacking belongs to the store layer.

const crypto = require("crypto");
const http = require("http");
const zlib = require("zlib");

function tarballPath(name, version) {
  const shortName = name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
  return `/${name}/-/${shortName}-${version}.tgz`;
}

function integrityOf(bytes) {
  return `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`;
}

function jsonBytes(value) {
  return Buffer.from(JSON.stringify(value), "utf8");
}

async function start() {
  /** @type {Map<string, Buffer>} url path -> body served */
  const files = new Map();
  /** @type {Map<string, string>} url path -> sha512-... of that body */
  const integrities = new Map();
  /** @type {Array<{ method: string, url: string, headers: Record<string, string | string[] | undefined> }>} */
  const requests = [];

  function addTarball(name, version) {
    const path = tarballPath(name, version);
    const bytes = zlib.gzipSync(Buffer.from(`tuckbox fixture: ${name}@${version}\n`, "utf8"));
    files.set(path, bytes);
    integrities.set(path, integrityOf(bytes));
    return path;
  }

  // Built after listening, because `dist.tarball` must be absolute.
  let leftPad = null;
  let scoped = null;

  function buildDocuments(base) {
    const make = (name, versions, latest) => {
      const versionsRecord = {};
      for (const version of versions) {
        const path = tarballPath(name, version);
        versionsRecord[version] = {
          name,
          version,
          dependencies: {},
          dist: {
            tarball: `${base}${path}`,
            integrity: integrities.get(path),
          },
        };
      }
      return { name, "dist-tags": { latest }, versions: versionsRecord };
    };

    leftPad = make("left-pad", ["1.0.0", "1.3.0"], "1.3.0");
    scoped = make("@scope/thing", ["1.0.0"], "1.0.0");
  }

  addTarball("left-pad", "1.0.0");
  addTarball("left-pad", "1.3.0");
  addTarball("@scope/thing", "1.0.0");

  function send(res, status, headers, body) {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
    res.writeHead(status, Object.assign({ "content-length": String(bytes.length) }, headers));
    res.end(bytes);
  }

  function handler(req, res) {
    const target = req.url || "/";
    requests.push({
      method: req.method || "GET",
      url: target,
      headers: Object.assign({}, req.headers),
    });

    if (target === "/left-pad") {
      send(res, 200, { "content-type": "application/json" }, jsonBytes(leftPad));
      return;
    }
    if (target === "/@scope%2Fthing" || target === "/%40scope%2Fthing") {
      send(res, 200, { "content-type": "application/json" }, jsonBytes(scoped));
      return;
    }
    if (target === "/redirect/left-pad") {
      send(res, 302, { location: "/left-pad" }, Buffer.alloc(0));
      return;
    }
    if (target === "/redirect-loop") {
      send(res, 302, { location: "/redirect-loop" }, Buffer.alloc(0));
      return;
    }
    if (target === "/broken") {
      // Declared as JSON, deliberately truncated: the client must call this EBADPACKUMENT.
      send(res, 200, { "content-type": "application/json" }, Buffer.from('{"name": "broken",', "utf8"));
      return;
    }

    const body = files.get(target);
    if (body !== undefined) {
      send(res, 200, { "content-type": "application/octet-stream" }, body);
      return;
    }

    send(res, 404, { "content-type": "application/json" }, jsonBytes({ error: "not found" }));
  }

  const server = http.createServer(handler);

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("fixture registry: listen() did not produce a TCP address");
  }
  const url = `http://127.0.0.1:${address.port}`;
  buildDocuments(url);

  return {
    url,
    requests,
    tarballs: files,
    integrities,
    /** How many requests have hit `path` so far (redirect hops count separately). */
    count(path) {
      return requests.filter((request) => request.url === path).length;
    },
    /** Forget recorded requests, so a test can measure only what happens next. */
    reset() {
      requests.length = 0;
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // Tests finish their requests before closing; this only makes an accidentally leaked
        // keep-alive socket fail loudly instead of hanging the test run.
        if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      });
    },
  };
}

module.exports = { start, tarballPath };
