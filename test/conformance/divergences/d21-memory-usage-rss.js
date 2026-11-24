// Divergence D21 (narrowed by M7): `rss` is the operating system's resident size, while
// `heapTotal`/`heapUsed` are the engine's accounting; `external`/`arrayBuffers` are still 0 because
// the engine reports no external-buffer count.
const memory = process.memoryUsage();
console.log("rss positive", memory.rss > 0);
console.log("rss at least heapUsed", memory.rss >= memory.heapUsed);
console.log("external zero", memory.external === 0 && memory.arrayBuffers === 0);
