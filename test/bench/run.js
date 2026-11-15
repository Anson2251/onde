#!/usr/bin/env node
"use strict";

// node vs onde on the same compute script, repeated, medians reported.
//
//   node test/bench/run.js
//   BENCH_REPS=5 node test/bench/run.js
//   LITE_RELEASE=/path/to/lite node test/bench/run.js
//
// The HTTP side of the comparison is the same idea with a different harness:
//
//   NET_BENCH_NO_BUILD=1 NET_BENCH_SOFT=1 LITE_RELEASE="$(command -v node)" ./test/net/bench.sh
//   NET_BENCH_NO_BUILD=1 NET_BENCH_SOFT=1 ./test/net/bench.sh
//
// Both put the *same* script in front of the load generator, so the difference is the runtime.

const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..", "..");
const lite = process.env.LITE_RELEASE || join(root, "target", "release", "lite");
// compute.js is the engine-level comparison; codec.js is the byte-level one, and it is where the
// stdlib's own implementation (rather than the engine) used to dominate.
const scripts = ["compute.js", "codec.js", "lib.js"].map((name) => join(__dirname, name));
const reps = Number(process.env.BENCH_REPS || 3);

// A benchmark of a stale release binary is worse than no benchmark: it reports the speed of code
// that is no longer in the tree. When the default release binary is in use, rebuild it first, the
// same way test/net/bench.sh does. A caller who points LITE_RELEASE elsewhere is asserting that the
// binary is current, and BENCH_NO_BUILD=1 is the explicit escape hatch for repeat runs.
const defaultLite = process.env.LITE_RELEASE === undefined;
if (!existsSync(lite) && !defaultLite) {
  console.error(`bench: no runtime at ${lite} (from LITE_RELEASE)`);
  process.exit(2);
}
if (defaultLite && process.env.BENCH_NO_BUILD !== "1") {
  const build = spawnSync("cargo", ["build", "--release", "-p", "ln-cli"], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (build.status !== 0) {
    console.error("bench: cargo build --release failed");
    process.exit(2);
  }
}
if (!existsSync(lite)) {
  console.error(`bench: no release runtime at ${lite}`);
  process.exit(2);
}

/** Run one runtime `reps` times and return { workload: medianMs }. */
function measure(label, command, script, args = []) {
  const samples = new Map();
  for (let i = 0; i < reps; i += 1) {
    const result = spawnSync(command, [...args, script], { encoding: "utf8" });
    if (result.status !== 0) {
      console.error(`bench: ${label} failed (exit ${result.status})`);
      process.stderr.write(result.stderr || "");
      process.exit(2);
    }
    for (const line of result.stdout.split("\n")) {
      const match = /^"(.*)" ([0-9.]+)$/.exec(line.trim());
      if (match === null) continue;
      const name = match[1];
      const value = Number(match[2]);
      if (!samples.has(name)) samples.set(name, []);
      samples.get(name).push(value);
    }
  }

  const medians = new Map();
  for (const [name, values] of samples) {
    values.sort((a, b) => a - b);
    medians.set(name, values[Math.floor(values.length / 2)]);
  }
  return medians;
}

const { statSync } = require("node:fs");
const built = statSync(lite).mtime.toISOString().replace("T", " ").slice(0, 19);
console.log(`onde: ${lite}`);
console.log(`built ${built}${defaultLite ? "" : " (LITE_RELEASE, not rebuilt)"}`);

for (const script of scripts) {
  const node = measure("node", process.execPath, script);
  const onde = measure("onde", lite, script);

  const names = [...node.keys()];
  const width = Math.max(...names.map((name) => name.length)) + 2;

  console.log(`\n${script.split("/").pop()}`);
  console.log(
    `${"workload".padEnd(width)}${"node".padStart(10)}${"onde".padStart(10)}${"onde/node".padStart(12)}`,
  );
  const ratios = [];
  for (const name of names) {
    const a = node.get(name);
    const b = onde.get(name);
    const ratio = b / a;
    ratios.push(ratio);
    console.log(
      `${name.padEnd(width)}${a.toFixed(1).padStart(10)}${b.toFixed(1).padStart(10)}${`${ratio.toFixed(1)}x`.padStart(12)}`,
    );
  }

  ratios.sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)];
  console.log(`median ratio ${median.toFixed(1)}x across ${names.length} workloads, ${reps} repetitions each`);
}
