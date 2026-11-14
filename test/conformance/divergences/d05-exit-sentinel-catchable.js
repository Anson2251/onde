// Divergence: process.exit unwinds by throwing a private sentinel so the host can stop at the
// next boundary. A script that catches arbitrary values can observe it; Node exits immediately.
// The exit code and the no-drain rule are unaffected.
try {
  process.exit(3);
} catch (e) {
  console.log('caught');
}
console.log('after');
