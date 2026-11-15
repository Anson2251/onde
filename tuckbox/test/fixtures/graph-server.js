"use strict";

// A registry that serves REAL npm-shaped tarballs, for the end-to-end install test.
//
// The registry workstream's fixture serves gzip of a string, which is enough for the fetch layer
// but not for anything that has to be unpacked. This one writes ustar archives containing a
// package.json and an index.js, so an installed tree can be `require`d and the layout can be
// proven by real module resolution rather than by comparing path strings alone.
//
// The graph is chosen to force every placement decision in one small install:
//
//   root -> a@^1  -> b@^1
//   root -> c@^1  -> b@^2      (conflict: root b is taken by a's b@1.5.0, so c gets a nested b@2)
//
// Expected tree: node_modules/{a,b,c}, plus node_modules/c/node_modules/b.

const { createHash } = require("node:crypto");
const { createServer } = require("node:http");
const { gzipSync } = require("node:zlib");

// ---------------------------------------------------------------------------------------------
// A minimal ustar writer. Only what npm tarballs need: names under 100 bytes, regular files.
// ---------------------------------------------------------------------------------------------

function octal(value, length) {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function header(name, size, type) {
  const block = Buffer.alloc(512, 0);
  block.write(name, 0, 100, "utf8");
  block.write(octal(0o644, 8), 100, 8, "ascii");
  block.write(octal(0, 8), 108, 8, "ascii");
  block.write(octal(0, 8), 116, 8, "ascii");
  block.write(octal(size, 12), 124, 12, "ascii");
  block.write(octal(0, 12), 136, 12, "ascii");
  block.write("        ", 148, 8, "ascii"); // the checksum is computed over spaces here
  block.write(type, 156, 1, "ascii");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");

  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

function tarFile(path, content) {
  const data = Buffer.from(content, "utf8");
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512, 0);
  return Buffer.concat([header(path, data.length, "0"), data, padding]);
}

/** Build a `.tgz` whose entries live under `package/`, exactly as `npm pack` does. */
function makeTarball(files) {
  const parts = files.map((file) => tarFile(`package/${file.path}`, file.content));
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024, 0)]));
}

// ---------------------------------------------------------------------------------------------
// The fixture graph
// ---------------------------------------------------------------------------------------------

/** name -> version -> dependencies (ranges). */
const GRAPH = {
  a: { "1.0.0": { b: "^1.0.0" }, "2.0.0": { b: "^2.0.0" } },
  b: { "1.5.0": {}, "2.0.0": {} },
  c: { "1.0.0": { b: "^2.0.0" } },
};

function buildPackage(name, version, dependencies) {
  const manifest = {
    name,
    version,
    main: "index.js",
    ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
  };
  // index.js reports the version of `b` it can actually see, so requiring it from the installed
  // tree proves where the resolver placed things.
  const index = [
    `"use strict";`,
    `exports.name = ${JSON.stringify(name)};`,
    `exports.version = ${JSON.stringify(version)};`,
    `exports.seesB = () => { try { return require("b").version; } catch (_) { return null; } };`,
    ``,
  ].join("\n");

  return makeTarball([
    { path: "package.json", content: `${JSON.stringify(manifest, null, 2)}\n` },
    { path: "index.js", content: index },
  ]);
}

/**
 * Start the fixture registry on an ephemeral port.
 *
 * Returns `{ url, requests, close() }`; `close` is async and also drops keep-alive sockets so a
 * test can never hang on exit.
 */
async function start() {
  const requests = [];
  const tarballs = new Map();

  for (const [name, versions] of Object.entries(GRAPH)) {
    for (const [version, dependencies] of Object.entries(versions)) {
      tarballs.set(`${name}-${version}`, buildPackage(name, version, dependencies));
    }
  }

  let baseUrl = "";

  const server = createServer((request, response) => {
    const path = request.url || "/";
    requests.push({ method: request.method, path, headers: request.headers });

    const tarball = /^\/([^/]+)\/-\/([^/]+)\.tgz$/.exec(path);
    if (tarball !== null) {
      // The file name is already `<name>-<version>`, which is the key the tarballs map uses.
      const body = tarballs.get(tarball[2]);
      if (body === undefined) {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("not found");
        return;
      }
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(body);
      return;
    }

    const name = decodeURIComponent(path.slice(1));
    const versions = GRAPH[name];
    if (versions === undefined) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    const published = {};
    for (const [version, dependencies] of Object.entries(versions)) {
      const body = tarballs.get(`${name}-${version}`);
      published[version] = {
        name,
        version,
        ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
        dist: {
          tarball: `${baseUrl}/${name}/-/${name}-${version}.tgz`,
          integrity: `sha512-${createHash("sha512").update(body).digest("base64")}`,
        },
      };
    }

    const highest = Object.keys(versions).sort().at(-1);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ name, "dist-tags": { latest: highest }, versions: published }),
    );
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });

  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    url: baseUrl,
    requests,
    /** The bytes served for one package version, for integrity comparisons. */
    tarball: (name, version) => tarballs.get(`${name}-${version}`),
    async close() {
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

module.exports = { start };
