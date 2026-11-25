#!/usr/bin/env node
"use strict";

// Runs every test/*.test.js under BOTH node and onde, and requires them to agree.
//
// The modules under test are deliberately runtime-agnostic, so node is a usable oracle: if the
// same assertions pass on both engines the module is not quietly depending on onde-only behaviour,
// and if they disagree the diff points at the runtime. This harness needs child_process, which
// onde does not have yet, so it is the one file that must run under node.

const { spawnSync } = require("node:child_process");
const { readdirSync } = require("node:fs");
const { join, relative } = require("node:path");

const here = __dirname;
const root = join(here, "..");
const onde =
  process.env.TUCKBOX_ONDE || process.env.TUCKBOX_LITE || join(root, "..", "target", "debug", "onde");
const wantNetwork = process.env.TUCKBOX_NET === "1";

function run(command, file) {
  const result = spawnSync(command, [file], { encoding: "utf8", cwd: root });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error ? String(result.error.message) : undefined,
  };
}

function firstDifference(left, right) {
  const a = left.split("\n");
  const b = right.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return `  node: ${JSON.stringify(a[i])}\n  onde: ${JSON.stringify(b[i])}`;
  }
  return "  (no line differs; lengths do)";
}

const files = readdirSync(here)
  .filter((name) => name.endsWith(".test.js"))
  .sort();

let passed = 0;
let failed = 0;
let skipped = 0;

for (const name of files) {
  const file = join(here, name);
  const label = relative(root, file);

  // A `.net.` in the name marks a suite that touches the real registry.
  if (name.includes(".net.") && !wantNetwork) {
    console.log(`skip      ${label} (set TUCKBOX_NET=1 to run)`);
    skipped += 1;
    continue;
  }

  const node = run("node", file);
  if (node.error !== undefined) {
    console.log(`FAIL      ${label}: cannot spawn node: ${node.error}`);
    failed += 1;
    continue;
  }
  if (node.status !== 0) {
    console.log(`FAIL      ${label} via node (exit ${node.status})`);
    process.stdout.write(node.stdout);
    process.stdout.write(node.stderr);
    failed += 1;
    continue;
  }

  const ondeRun = run(onde, file);
  if (ondeRun.error !== undefined) {
    console.log(`FAIL      ${label}: cannot spawn ${onde}: ${ondeRun.error}`);
    failed += 1;
    continue;
  }
  if (ondeRun.status !== 0) {
    console.log(`FAIL      ${label} via onde (exit ${ondeRun.status})`);
    process.stdout.write(ondeRun.stdout);
    process.stdout.write(ondeRun.stderr);
    failed += 1;
    continue;
  }
  if (ondeRun.stdout !== node.stdout) {
    console.log(`FAIL      ${label}: node and onde disagree`);
    console.log(firstDifference(node.stdout, ondeRun.stdout));
    failed += 1;
    continue;
  }

  console.log(`ok        ${label} via node and onde`);
  passed += 1;
}

console.log(`\n${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ""}`);
process.exitCode = failed === 0 ? 0 : 1;
