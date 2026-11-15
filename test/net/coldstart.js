"use strict";

// Cold-start measurement for the M4 exit criterion: 25 release runs of `lite -e <expr>`, median
// wall time. Spawning the process is part of the measurement (that is what "cold start" means),
// and each run is independent: no warm process is reused.
//
//   node test/net/coldstart.js <lite> [runs]
//   NET_BENCH_SOFT=1 node test/net/coldstart.js <lite>   # thresholds informational
//
// Thresholds: `1+1` median <= 14 ms, `require("http")` median <= 25 ms.

const { spawnSync } = require("child_process");

const lite = process.argv[2];
const runs = Number(process.argv[3] || 25);
const soft = process.env.NET_BENCH_SOFT === "1";

const cases = [
  { expr: "1+1", limit: 14 },
  { expr: 'require("http")', limit: 25 },
];

function measure(expr) {
  // Two discarded warm-up spawns page the binary in, so the median measures runtime startup rather
  // than first-touch disk I/O (the roadmap's ~13 ms number is the runtime, not the filesystem).
  for (let i = 0; i < 2; i += 1) {
    spawnSync(lite, ["-e", expr], { stdio: "ignore" });
  }
  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    const started = process.hrtime.bigint();
    const result = spawnSync(lite, ["-e", expr], { stdio: "ignore" });
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    if (result.error) {
      console.error(`coldstart: ${result.error.message}`);
      process.exit(2);
    }
    if (result.status !== 0) {
      console.error(`coldstart: '${expr}' exited ${result.status}`);
      process.exit(2);
    }
    samples.push(elapsed);
  }
  samples.sort((a, b) => a - b);
  return {
    median: samples[Math.floor(samples.length / 2)],
    min: samples[0],
    max: samples[samples.length - 1],
    p95: samples[Math.min(samples.length - 1, Math.ceil(0.95 * samples.length) - 1)],
  };
}

let failures = 0;
for (const { expr, limit } of cases) {
  const stats = measure(expr);
  const met = stats.median <= limit;
  if (!met) failures += 1;
  console.log(
    `RESULT expr=${JSON.stringify(expr)} runs=${runs} median_ms=${stats.median.toFixed(2)} ` +
      `min_ms=${stats.min.toFixed(2)} p95_ms=${stats.p95.toFixed(2)} max_ms=${stats.max.toFixed(2)} ` +
      `limit_ms=${limit} ${met ? "met" : "missed"}${soft ? " (soft)" : ""}`,
  );
}

if (failures !== 0 && !soft) {
  process.exit(1);
}
console.log(`SUMMARY: ${runs} runs per expression, ${failures === 0 ? "thresholds met" : "thresholds missed"}`);
