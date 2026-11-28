"use strict";

// Cold-start measurement for the M7 exit criteria: 25 release runs of `onde -e <expr>`, median wall
// time. Spawning the process is part of the measurement (that is what "cold start" means), and each
// run is independent: no warm process is reused.
//
//   node test/net/coldstart.js <onde> [runs]
//   NET_BENCH_SOFT=1 node test/net/coldstart.js <onde>   # thresholds informational
//   NET_BENCH_FORCE=1 node test/net/coldstart.js <onde>  # measure even in low-power mode
//
// Thresholds: `1+1` median <= 14 ms, `require("http")` median <= 25 ms, and the difference between
// them (what importing the http stack costs) <= 8 ms.
//
// Since M7 the harness records the machine state with every number. macOS `lowpowermode` caps CPU
// frequency and roughly doubles the reading (m7-plan §2: 12.2/19.0 ms on AC against 19.1/30.8 ms
// under low-power), so a run in that mode reports and skips instead of failing a gate it cannot
// honour. The `http − eval` delta is the second, machine-independent number: it is a property of
// the runtime's module compile, not of the clock.

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");

const onde = process.argv[2];
const runs = Number(process.argv[3] || 25);
const soft = process.env.NET_BENCH_SOFT === "1";
const force = process.env.NET_BENCH_FORCE === "1";

const cases = [
    { expr: "1+1", limit: 14 },
    { expr: 'require("http")', limit: 25 },
];
const DELTA_LIMIT = 8;

function powerMode() {
    if (process.platform === "darwin") {
        const probe = spawnSync("pmset", ["-g"], { encoding: "utf8" });
        const match = /lowpowermode\s+([01])/.exec(probe.stdout || "");
        if (!match) return "unknown";
        return match[1] === "1" ? "low" : "off";
    }
    try {
        const governor = fs
            .readFileSync("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor", "utf8")
            .trim();
        return governor === "powersave" ? "low" : "unknown";
    } catch {
        return "unknown";
    }
}

const mode = powerMode();
const load = os.loadavg()[0].toFixed(2);
const throttled = mode === "low" && !force;
console.log(`MACHINE lowpowermode=${mode} load=${load}${force ? " forced=1" : ""}`);
if (throttled) {
    console.log(
        "SKIP: low-power mode is on; every number would be the power policy's. " +
            "Set NET_BENCH_FORCE=1 to measure anyway, or record the run on the reference machine.",
    );
}

function measure(expr) {
    // Two discarded warm-up spawns page the binary in, so the median measures runtime startup rather
    // than first-touch disk I/O (the roadmap's ~13 ms number is the runtime, not the filesystem).
    for (let i = 0; i < 2; i += 1) {
        spawnSync(onde, ["-e", expr], { stdio: "ignore" });
    }
    const samples = [];
    for (let i = 0; i < runs; i += 1) {
        const started = process.hrtime.bigint();
        const result = spawnSync(onde, ["-e", expr], { stdio: "ignore" });
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

if (throttled && !soft) {
    console.log(`SUMMARY: skipped (lowpowermode=${mode}); thresholds not evaluated`);
    process.exit(0);
}

let failures = 0;
const medians = {};
for (const { expr, limit } of cases) {
    const stats = measure(expr);
    medians[expr] = stats.median;
    const met = stats.median <= limit;
    if (!met) failures += 1;
    console.log(
        `RESULT expr=${JSON.stringify(expr)} runs=${runs} median_ms=${stats.median.toFixed(2)} ` +
            `min_ms=${stats.min.toFixed(2)} p95_ms=${stats.p95.toFixed(2)} max_ms=${stats.max.toFixed(2)} ` +
            `limit_ms=${limit} ${met ? "met" : "missed"}${soft ? " (soft)" : ""}`,
    );
}

// The import cost, which is what a stdlib snapshot can move (m7-plan §4.3, §8).
const delta = medians['require("http")'] - medians["1+1"];
const deltaMet = delta <= DELTA_LIMIT;
if (!deltaMet) failures += 1;
console.log(
    `RESULT expr="http-eval-delta" median_ms=${delta.toFixed(2)} limit_ms=${DELTA_LIMIT} ` +
        `${deltaMet ? "met" : "missed"}${soft ? " (soft)" : ""}`,
);

if (failures !== 0 && !soft) {
    process.exit(1);
}
console.log(
    `SUMMARY: ${runs} runs per expression, ${failures === 0 ? "thresholds met" : "thresholds missed"}`,
);
