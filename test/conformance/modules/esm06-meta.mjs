console.log(import.meta.url.startsWith("file://"));
console.log(import.meta.filename.endsWith("/esm06-meta.mjs"));
console.log(import.meta.dirname.endsWith("/modules"));
console.log(import.meta.resolve("node:path"));
console.log(import.meta.resolve("./fixtures/live.mjs").endsWith("/fixtures/live.mjs"));
