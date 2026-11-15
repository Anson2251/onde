"use strict";

// Integration tests for `dist/lib/registry.js` against the in-process fixture registry. Plain
// CommonJS, runnable under both `node` and `lite`, with the same `ok registry <N> assertions`
// contract as the other tuckbox suites.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { getPackument, getTarball } = require("../dist/lib/registry.js");
const { start } = require("./fixtures/registry-server.js");

let passed = 0;
const failures = [];

function ok(condition, message) {
  if (condition) {
    passed += 1;
  } else {
    failures.push(message);
  }
}

function eq(actual, expected, message) {
  ok(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function deepEq(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, `${message} (expected ${b}, got ${a})`);
}

/**
 * Await a promise that is expected to reject, recording one failure if it resolves. The returned
 * error is then asserted on field by field, so each property is its own assertion count.
 */
async function caught(promise, label) {
  try {
    await promise;
    failures.push(`${label}: expected the promise to reject`);
    return null;
  } catch (error) {
    return error;
  }
}

function errorCode(error, code, message) {
  ok(error !== null && error !== undefined && error.code === code, `${message} (code was ${error && error.code}, error ${error && error.message})`);
}

function errorMessage(error, includes, message) {
  const text = String(error && error.message);
  ok(includes.every((part) => text.includes(part)), `${message} (message was ${JSON.stringify(text)})`);
}

const watchdog = setTimeout(() => {
  console.error("not ok registry: watchdog expired");
  process.exit(1);
}, 30000);
if (typeof watchdog.unref === "function") watchdog.unref();

async function run() {
  const server = await start();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tuckbox-registry-"));

  try {
    // --- 1. packument parse and request headers ---------------------------------------------

    const packument = await getPackument("left-pad", { registry: server.url });
    eq(packument.name, "left-pad", "packument name");
    eq(packument["dist-tags"].latest, "1.3.0", "dist-tags.latest");
    deepEq(Object.keys(packument.versions), ["1.0.0", "1.3.0"], "packument versions");
    eq(packument.versions["1.3.0"].version, "1.3.0", "version entry");
    deepEq(packument.versions["1.3.0"].dependencies, {}, "version dependencies");

    eq(server.requests.length, 1, "one packument request served");
    const request = server.requests[0];
    eq(request.method, "GET", "request method");
    eq(request.url, "/left-pad", "request path");
    eq(request.headers.accept, "application/vnd.npm.install-v1+json", "accept header");
    eq(request.headers["user-agent"], "tuckbox/0.1.0 (onde)", "default user-agent header");

    const tarballPath = "/left-pad/-/left-pad-1.3.0.tgz";
    eq(
      packument.versions["1.3.0"].dist.tarball,
      `${server.url}${tarballPath}`,
      "dist.tarball is absolute and fixture-relative",
    );

    // --- 2. user-agent override -------------------------------------------------------------

    server.reset();
    await getPackument("left-pad", { registry: server.url, userAgent: "custom-agent/9.9" });
    eq(server.requests.length, 1, "override call served");
    eq(server.requests[0].headers["user-agent"], "custom-agent/9.9", "user-agent can be overridden");

    // --- 3. redirects -----------------------------------------------------------------------

    server.reset();
    const redirected = await getPackument("left-pad", { registry: `${server.url}/redirect` });
    eq(redirected.name, "left-pad", "redirected packument parsed");
    deepEq(
      server.requests.map((entry) => entry.url),
      ["/redirect/left-pad", "/left-pad"],
      "redirect chain is followed in order",
    );

    server.reset();
    const redirectError = await caught(
      getPackument("redirect-loop", { registry: server.url }),
      "redirect loop",
    );
    errorCode(redirectError, "EREDIRECT", "redirect loop is EREDIRECT");
    ok(server.requests.length >= 2, "redirect loop made more than one request");
    ok(server.requests.length <= 7, `redirect loop is capped (made ${server.requests.length} requests)`);

    // --- 4. scoped name encoding ------------------------------------------------------------

    server.reset();
    const scoped = await getPackument("@scope/thing", { registry: server.url });
    eq(scoped.name, "@scope/thing", "scoped packument name");
    eq(scoped.versions["1.0.0"].version, "1.0.0", "scoped packument version");
    eq(server.requests[0].url, "/%40scope%2Fthing", "scoped name is percent-encoded in the URL path");

    // --- 5. error mapping -------------------------------------------------------------------

    server.reset();
    const missing = await caught(getPackument("not-a-package", { registry: server.url }), "404 packument");
    errorCode(missing, "ETARGET", "404 packument is ETARGET");
    eq(missing && missing.status, 404, "ETARGET carries status 404");
    errorMessage(missing, ["not-a-package", "404"], "ETARGET message names the package and the status");

    const broken = await caught(getPackument("broken", { registry: server.url }), "bad JSON packument");
    errorCode(broken, "EBADPACKUMENT", "invalid JSON packument is EBADPACKUMENT");
    errorMessage(broken, ["broken"], "EBADPACKUMENT message names the package");

    const unsupported = await caught(
      getPackument("left-pad", { registry: "ftp://registry.example" }),
      "unsupported protocol",
    );
    errorCode(unsupported, "EHTTP", "a non-http registry URL is EHTTP");

    const invalid = await caught(
      getPackument("left-pad", { registry: "not a url" }),
      "invalid registry URL",
    );
    errorCode(invalid, "EHTTP", "an unparseable registry URL is EHTTP");

    // --- 6. tarball bytes -------------------------------------------------------------------

    server.reset();
    const expectedTarball = server.tarballs.get(tarballPath);
    ok(expectedTarball !== undefined, "fixture served a tarball body");
    const bytes = await getTarball(packument.versions["1.3.0"].dist.tarball, { registry: server.url });
    eq(bytes.toString("hex"), expectedTarball.toString("hex"), "tarball bytes survive the round trip");
    eq(bytes[0], 0x1f, "tarball body is gzip (magic byte 1)");
    eq(bytes[1], 0x8b, "tarball body is gzip (magic byte 2)");
    eq(server.requests.length, 1, "tarball download made one request");
    eq(server.requests[0].url, tarballPath, "tarball request path");
    eq(server.requests[0].headers["user-agent"], "tuckbox/0.1.0 (onde)", "tarball sends user-agent");

    const digest = crypto.createHash("sha512").update(bytes).digest("base64");
    eq(
      packument.versions["1.3.0"].dist.integrity,
      `sha512-${digest}`,
      "advertised integrity is the sha512 of the served bytes",
    );

    const missingTarball = await caught(
      getTarball(`${server.url}/left-pad/-/left-pad-9.9.9.tgz`, { registry: server.url }),
      "404 tarball",
    );
    errorCode(missingTarball, "ETARBALL", "404 tarball is ETARBALL");
    eq(missingTarball && missingTarball.status, 404, "ETARBALL carries status 404");
    errorMessage(missingTarball, ["9.9.9.tgz", "404"], "ETARBALL message names the URL and status");

    // --- 7. verbose logging -----------------------------------------------------------------

    const originalWrite = process.stderr.write;
    let logged = "";
    process.stderr.write = (chunk) => {
      logged += String(chunk);
      return true;
    };
    try {
      await getPackument("left-pad", { registry: server.url, verbose: true });
    } finally {
      process.stderr.write = originalWrite;
    }
    const logLines = logged.split("\n").filter((line) => line.length > 0);
    eq(logLines.length, 1, "verbose logs exactly one line per request");
    ok(logLines[0].includes("GET") && logLines[0].includes(`${server.url}/left-pad`), `verbose line names the request (${logLines[0]})`);

    // --- 8. packument cache -----------------------------------------------------------------

    const cacheDir = path.join(root, "cache-packument");
    server.reset();
    const firstCached = await getPackument("left-pad", { registry: server.url, cacheDir });
    eq(server.count("/left-pad"), 1, "first cached packument call hits the server once");
    eq(firstCached.name, "left-pad", "first cached value is correct");

    const secondCached = await getPackument("left-pad", { registry: server.url, cacheDir });
    eq(server.count("/left-pad"), 1, "second packument call is served from cache");
    eq(secondCached["dist-tags"].latest, "1.3.0", "cached packument value is correct");

    const cacheFile = path.join(cacheDir, "packuments", "left-pad.json");
    ok(fs.existsSync(cacheFile), "packument cache lives at packuments/<encoded-name>.json");
    eq(JSON.parse(fs.readFileSync(cacheFile, "utf8")).name, "left-pad", "cache file holds the packument");

    const scopedCache = path.join(cacheDir, "packuments", "%40scope%2Fthing.json");
    await getPackument("@scope/thing", { registry: server.url, cacheDir });
    ok(fs.existsSync(scopedCache), "scoped cache file uses the encoded name");

    // A stale entry is refetched.
    const stale = new Date(Date.now() - 6 * 60 * 1000);
    fs.utimesSync(cacheFile, stale, stale);
    server.reset();
    await getPackument("left-pad", { registry: server.url, cacheDir });
    eq(server.count("/left-pad"), 1, "a packument older than five minutes is refetched");

    // A corrupt entry is refetched, not fatal.
    fs.writeFileSync(cacheFile, "{ definitely not json", "utf8");
    server.reset();
    const afterCorrupt = await getPackument("left-pad", { registry: server.url, cacheDir });
    eq(afterCorrupt.name, "left-pad", "a corrupt cache entry still yields a packument");
    eq(server.count("/left-pad"), 1, "a corrupt cache entry is refetched");

    // A cache directory that cannot be created is not fatal either.
    const cacheAsFile = path.join(root, "cache-is-a-file");
    fs.writeFileSync(cacheAsFile, "not a directory", "utf8");
    const uncacheable = await getPackument("left-pad", { registry: server.url, cacheDir: cacheAsFile });
    eq(uncacheable.name, "left-pad", "an unwritable cache directory does not fail the fetch");

    // --- 9. tarball cache -------------------------------------------------------------------

    const tarballCache = path.join(root, "cache-tarball");
    server.reset();
    const firstTarball = await getTarball(`${server.url}${tarballPath}`, { cacheDir: tarballCache });
    eq(server.count(tarballPath), 1, "first cached tarball call hits the server once");
    eq(firstTarball.toString("hex"), expectedTarball.toString("hex"), "first cached tarball bytes");

    server.reset();
    const secondTarball = await getTarball(`${server.url}${tarballPath}`, { cacheDir: tarballCache });
    eq(server.count(tarballPath), 0, "second tarball call is served from cache");
    eq(secondTarball.toString("hex"), expectedTarball.toString("hex"), "cached tarball bytes are unchanged");
    ok(
      fs.existsSync(path.join(tarballCache, "tarballs", "left-pad-1.3.0.tgz")),
      "tarball cache lives at tarballs/<basename of url path>",
    );
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().then(
  () => {
    clearTimeout(watchdog);
    if (failures.length > 0) {
      for (const failure of failures) console.error(`not ok registry: ${failure}`);
      console.error(`not ok registry ${failures.length} failure(s), ${passed} assertion(s) passed`);
      process.exit(1);
    }
    console.log(`ok registry ${passed} assertions`);
  },
  (error) => {
    clearTimeout(watchdog);
    console.error(`not ok registry: unexpected exception: ${error && error.stack ? error.stack : String(error)}`);
    process.exit(1);
  },
);
