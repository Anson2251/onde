"use strict";

// Compute benchmarks, sized to the work onde is meant for rather than to peak FLOPS: call
// overhead, JSON, collection churn, string building. Run through test/bench/run.sh, which
// repeats it and takes medians; running it directly prints one line per workload.
//
// Every workload is fixed-size and allocation-light on purpose. A benchmark where node wins by
// 50x because V8's garbage collector has a nursery would say nothing useful about a CLI.

const workloads = [
    [
        "fib(30)",
        3,
        () => {
            // Recursive call overhead: the shape of a build script's hot loop.
            const fib = (n) => (n < 2 ? n : fib(n - 1) + fib(n - 2));
            return fib(30);
        },
    ],

    [
        "json 5x100k",
        3,
        () => {
            const rows = [];
            for (let i = 0; i < 100_000; i += 1) {
                rows.push({
                    id: i,
                    name: `row-${i}`,
                    tags: ["a", "b"],
                    nested: { ok: i % 2 === 0 },
                });
            }
            let total = 0;
            for (let i = 0; i < 5; i += 1) {
                const text = JSON.stringify(rows);
                total += JSON.parse(text).length;
            }
            return total;
        },
    ],

    [
        "sort 200k",
        2,
        () => {
            const values = new Array(200_000);
            let seed = 12345;
            for (let i = 0; i < values.length; i += 1) {
                // A deterministic LCG: Math.random() would make the work depend on the RNG, not the sort.
                seed = (seed * 1103515245 + 12345) & 0x7fffffff;
                values[i] = seed % 100_000;
            }
            values.sort((a, b) => a - b);
            return values[0] + values[values.length - 1];
        },
    ],

    [
        "strings 200k",
        2,
        () => {
            const parts = [];
            for (let i = 0; i < 200_000; i += 1) {
                parts.push(`key-${i}=${(i * 2654435761) % 1000}`);
            }
            return parts.join("&").length;
        },
    ],

    [
        "objects 300k",
        2,
        () => {
            let total = 0;
            for (let i = 0; i < 300_000; i += 1) {
                const record = { id: i, label: `r${i}`, weight: i * 0.5 };
                total += record.weight;
            }
            return total;
        },
    ],
];

function nowMs() {
    return Number(process.hrtime.bigint()) / 1e6;
}

const results = [];
for (const [name, repeats, run] of workloads) {
    // One warm-up pass: both engines optimize differently on a cold first run, and the point is
    // the steady state of a script that has been running for a while.
    run();
    const samples = [];
    for (let i = 0; i < repeats; i += 1) {
        const started = nowMs();
        run();
        samples.push(nowMs() - started);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    results.push([name, median]);
}

for (const [name, median] of results) {
    console.log(`${JSON.stringify(name)} ${median.toFixed(1)}`);
}
