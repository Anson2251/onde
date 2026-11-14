// lite rejects require() of an ES module; Node 22+ can require synchronous ESM graphs.
try {
  require("./fixtures/esm.mjs");
} catch (error) {
  console.log(error.code);
  console.log(error.message.split("\n")[0].includes("require() of ES Module"));
}
