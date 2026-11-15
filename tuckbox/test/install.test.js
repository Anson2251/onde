"use strict";

// End-to-end: resolve a real graph, install it, and then prove the layout by requiring the
// installed packages. The fixture registry serves actual ustar+gzip tarballs, so this exercises
// the whole path - packument, tarball, integrity, unpack, hardlink, placement - and the final
// assertion is made by a module resolver rather than by comparing strings.

const { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { start } = require("./fixtures/graph-server.js");
const { ci } = require("../dist/commands.js");
const { materializeLock, storeDirFor } = require("../dist/lib/install.js");
const lockfile = require("../dist/lib/lockfile.js");
const { resolve } = require("../dist/lib/resolve.js");

let passed = 0;
const failures = [];

function record(condition, detail) {
  if (condition) passed += 1;
  else failures.push(detail);
}

function eq(actual, expected, message) {
  record(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
  );
}

function makeProject(dependencies, devDependencies) {
  const dir = mkdtempSync(join(tmpdir(), "tuckbox-install-"));
  const manifest = { name: "fixture-project", private: true, dependencies };
  if (devDependencies !== undefined) manifest.devDependencies = devDependencies;
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

function collect() {
  const lines = [];
  return { lines, out: (line) => lines.push(line), err: (line) => lines.push(line) };
}

async function main() {
  const server = await start();
  const cleanups = [];
  const dirs = [];

  try {
    // --- the conflict graph -------------------------------------------------------------------
    const dir = makeProject({ a: "^1.0.0", c: "^1.0.0" });
    dirs.push(dir);

    const lock = await resolve(dir, { dev: false, registry: { registry: server.url } });

    eq(
      Object.keys(lock.packages),
      [
        "node_modules/a",
        "node_modules/b",
        "node_modules/c",
        "node_modules/c/node_modules/b",
      ],
      "the conflicted b is nested under c, everything else is hoisted",
    );
    eq(lock.packages["node_modules/a"].version, "1.0.0", "a resolves to 1.0.0");
    eq(lock.packages["node_modules/b"].version, "1.5.0", "the hoisted b is a's, at 1.5.0");
    eq(lock.packages["node_modules/c/node_modules/b"].version, "2.0.0", "c's nested b is 2.0.0");

    for (const path of Object.keys(lock.packages)) {
      const entry = lock.packages[path];
      record(
        typeof entry.integrity === "string" && entry.integrity.startsWith("sha512-"),
        `${path} carries a sha512 integrity`,
      );
      record(entry.resolved.startsWith(server.url), `${path} resolved to the fixture registry`);
    }

    // --- determinism --------------------------------------------------------------------------
    const again = await resolve(dir, { dev: false, registry: { registry: server.url } });
    eq(lockfile.serialize(again), lockfile.serialize(lock), "resolving twice yields the same bytes");

    // --- lockfile round trip ------------------------------------------------------------------
    lockfile.write(dir, lock);
    const reread = lockfile.read(dir);
    record(reread !== null, "the lockfile can be read back");
    eq(lockfile.serialize(reread), lockfile.serialize(lock), "the lockfile round trips exactly");

    // --- install ------------------------------------------------------------------------------
    const installed = await materializeLock(reread, { dir });
    eq(installed, 4, "four packages are materialized");

    // --- the placements resolve, checked by two resolvers --------------------------------------
    const installedA = require(join(dir, "node_modules", "a"));
    const installedC = require(join(dir, "node_modules", "c"));
    eq(installedA.seesB(), "1.5.0", "a sees the hoisted b@1.5.0");
    eq(installedC.seesB(), "2.0.0", "c sees its nested b@2.0.0");

    // --- hardlinks, not copies ----------------------------------------------------------------
    // The store directory is named by the sha512 of the tarball, so the integrity in the lockfile
    // is what maps an install path back to its bytes. (Mapping by package name would confuse the
    // two copies of b.)
    const storeRoot = storeDirFor(dir);
    eq(readdirSync(storeRoot).length, 4, "one store directory per package");
    for (const path of Object.keys(lock.packages)) {
      const integrity = lock.packages[path].integrity;
      const hex = Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex");
      const from = join(storeRoot, hex, "index.js");
      const to = join(dir, path, "index.js");
      const source = statSync(from);
      const installedFile = statSync(to);
      record(source.ino === installedFile.ino, `${path}/index.js is a hardlink of its store copy`);
      record(installedFile.nlink >= 2, `${path}/index.js is linked, not copied`);
    }

    // --- ci agrees, then refuses ---------------------------------------------------------------
    const okContext = { dir, registry: server.url, prod: false, verbose: false, ...collect() };
    eq(await ci(okContext), 0, "ci installs from the lockfile");

    const stale = readFileSync(join(dir, "package.json"), "utf8");
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ ...JSON.parse(stale), dependencies: { a: "^2.0.0" } }, null, 2)}\n`,
    );
    const staleContext = { dir, registry: server.url, prod: false, verbose: false, ...collect() };
    eq(await ci(staleContext), 1, "ci refuses a manifest the lockfile no longer satisfies");
    record(
      staleContext.lines.some((line) => line.includes("does not satisfy")),
      "ci explains which range no longer matches",
    );

    // --- dev dependencies ---------------------------------------------------------------------
    const devDir = makeProject({ a: "^1.0.0" }, { c: "^1.0.0" });
    dirs.push(devDir);
    const prodLock = await resolve(devDir, { dev: false, registry: { registry: server.url } });
    eq(
      Object.keys(prodLock.packages),
      ["node_modules/a", "node_modules/b"],
      "--prod leaves the devDependencies out",
    );
    const devLock = await resolve(devDir, { dev: true, registry: { registry: server.url } });
    eq(
      Object.keys(devLock.packages),
      ["node_modules/a", "node_modules/b", "node_modules/c", "node_modules/c/node_modules/b"],
      "including dev dependencies adds c and its nested b",
    );
    eq(devLock.packages["node_modules/c"].dev, true, "c is marked as a dev dependency");
    eq(devLock.packages["node_modules/a"].dev, undefined, "a is not a dev dependency");

    // --- an unreachable package fails loudly ---------------------------------------------------
    const badDir = makeProject({ "no-such-thing": "^1.0.0" });
    dirs.push(badDir);
    let badCode = null;
    try {
      await resolve(badDir, { dev: false, registry: { registry: server.url } });
    } catch (error) {
      badCode = error.code;
    }
    eq(badCode, "ETARGET", "a missing package is ETARGET");
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    for (const cleanup of cleanups) cleanup();
    await server.close();
  }

  for (const failure of failures) console.log(`not ok: ${failure}`);
  if (failures.length > 0) {
    console.log(`\n${failures.length} of ${passed + failures.length} assertions failed`);
    process.exitCode = 1;
    return;
  }
  console.log(`ok install ${passed} assertions`);
}

main().catch((error) => {
  console.error(`FAIL install: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
