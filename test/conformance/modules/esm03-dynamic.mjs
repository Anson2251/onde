const ns = await import("./fixtures/live.mjs");
console.log(ns.counter, typeof ns.increment, ns.default);

try {
  await import("./fixtures/does-not-exist.mjs");
} catch (error) {
  console.log(error.code);
}

const path = await import("node:path");
console.log(typeof path.join, path.join("a", "b"));
