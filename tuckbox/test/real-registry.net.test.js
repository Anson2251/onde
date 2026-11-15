"use strict";

// The real thing: resolve and install actual packages from the real npm registry, then require
// them out of the tree we built. Opt-in (`TUCKBOX_NET=1`) because it needs the network and the
// registry's contents change; everything else in this directory runs offline.
//
// Calls the library the way the CLI does (resolve, then materialize) instead of spawning the
// binary, because onde has no child_process yet and this file has to run on both runtimes.

if (process.env.TUCKBOX_NET !== "1") {
  console.log("skip: set TUCKBOX_NET=1 to run the real-registry suite");
  process.exit(0);
}

const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { resolve } = require("../dist/lib/resolve.js");
const { materializeLock } = require("../dist/lib/install.js");

let passed = 0;
const failures = [];

function record(condition, detail) {
  if (condition) passed += 1;
  else failures.push(detail);
}

async function installInto(name, dependencies) {
  const dir = mkdtempSync(join(tmpdir(), `tuckbox-${name}-`));
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name, private: true, dependencies }, null, 2)}\n`);
  const lock = await resolve(dir, { dev: false });
  await materializeLock(lock, { dir });
  return { dir, lock };
}

async function main() {
  // 1. No dependencies at all: the simplest possible tarball.
  {
    const { dir, lock } = await installInto("plain", { "left-pad": "^1.3.0" });
    record(lock.packages["node_modules/left-pad"] !== undefined, "left-pad is in the lockfile");
    record(
      Object.keys(lock.packages).length === 1,
      `left-pad pulls nothing else (saw ${Object.keys(lock.packages).length})`,
    );
    const leftPad = require(join(dir, "node_modules", "left-pad"));
    record(leftPad("x", 3) === "  x", `left-pad pads (got ${JSON.stringify(leftPad("x", 3))})`);
    // package.json read out of the installed tree, with the version the lockfile names.
    const installed = JSON.parse(readFileSync(join(dir, "node_modules", "left-pad", "package.json"), "utf8"));
    record(installed.version === lock.packages["node_modules/left-pad"].version, "installed version matches the lockfile");
    rmSync(dir, { recursive: true, force: true });
  }

  // 2. One dependency edge: debug -> ms, hoisted to the root.
  {
    const { dir, lock } = await installInto("withdep", { debug: "^4.3.0" });
    record(lock.packages["node_modules/debug"] !== undefined, "debug is installed");
    record(lock.packages["node_modules/ms"] !== undefined, "ms is hoisted to the root");
    const debug = require(join(dir, "node_modules", "debug"));
    record(typeof debug === "function", "debug is a function");
    // `enabled` is a lazy getter in debug@4 (undefined until the namespace is loaded), so assert
    // the stable part of the API instead: a debug instance carries its own namespace.
    const instance = debug("onde:tuckbox");
    record(typeof instance === "function", "debug builds an instance per namespace");
    record(instance.namespace === "onde:tuckbox", `the instance reports its namespace (got ${JSON.stringify(instance.namespace)})`);
    const ms = require(join(dir, "node_modules", "ms"));
    record(ms(1000) === "1s", `ms formats (got ${JSON.stringify(ms(1000))})`);
    rmSync(dir, { recursive: true, force: true });
  }

  // 3. A deeper tree with a scoped package and a real encoder: chalk@4.
  {
    const { dir, lock } = await installInto("chalky", { "chalk": "^4.1.2" });
    for (const name of ["chalk", "ansi-styles", "supports-color", "has-flag", "color-convert", "color-name"]) {
      record(lock.packages[`node_modules/${name}`] !== undefined, `${name} is installed`);
    }
    const chalk = require(join(dir, "node_modules", "chalk"));
    // Loaded with no TTY, chalk still exposes the builder and the identity chain.
    record(typeof chalk === "function" || typeof chalk === "object", "chalk loads");
    record(typeof chalk.red === "function", "chalk has the colour chain");
    const painted = chalk.red("onde");
    record(typeof painted === "string" && painted.includes("onde"), "chalk returns the text");
    rmSync(dir, { recursive: true, force: true });
  }

  for (const failure of failures) console.log(`not ok: ${failure}`);
  if (failures.length > 0) {
    console.log(`\n${failures.length} of ${passed + failures.length} assertions failed`);
    process.exitCode = 1;
    return;
  }
  console.log(`ok real-registry ${passed} assertions`);
}

main().catch((error) => {
  console.error(`FAIL real-registry: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
