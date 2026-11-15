// `process.exit` must not be observable as a failure by user code: like Node, it unwinds without
// running `catch` blocks (and without running `finally`).
try {
  process.exit(3);
} catch (error) {
  console.log("caught");
} finally {
  console.log("finally");
}
console.log("after");
