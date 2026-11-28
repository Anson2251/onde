// Divergence D68: a worker's `resourceLimits.maxOldGenerationSizeMb` is that runtime's own limit, and
// hitting it kills the worker, not the process. Node throws ERR_MEMORY_LIMIT_EXCEEDED, which a
// caller can catch; an engine OOM unwinds nothing, so it surfaces as the worker's `error` + `exit`.
const { Worker } = require("worker_threads");

const source =
    "const held = [];\nfor (let i = 0; i < 32; i += 1) held.push(new Array(1024 * 1024).fill(i));";
const worker = new Worker(source, {
    eval: true,
    resourceLimits: { maxOldGenerationSizeMb: 8 },
});
worker.on("error", (error) => console.log("worker error", error.name));
worker.on("exit", (code) => {
    // The parent's heap is untouched by the worker's limit: this allocation must still succeed.
    const block = new Array(1024 * 1024).fill(1);
    console.log("parent ok", block.length === 1048576);
    console.log("exit", code);
});
