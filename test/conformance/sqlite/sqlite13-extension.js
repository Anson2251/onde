// `node:sqlite`: extension loading is opt-in at construction and reports its own error code.
// The loader's message is platform-specific, so only the code is printed.

const { Database } = require("node:sqlite");

const closed = new Database(":memory:");
try {
  closed.enableLoadExtension(true);
} catch (error) {
  console.log("not allowed:", error.code, "|", error.message);
}

const db = new Database(":memory:", { allowExtension: true });
db.enableLoadExtension(true);
console.log("enabled:", true);
try {
  db.loadExtension("/definitely-not-a-real-extension.dylib");
} catch (error) {
  console.log("missing library:", error.code);
}
db.enableLoadExtension(false);
try {
  db.loadExtension("/definitely-not-a-real-extension.dylib");
} catch (error) {
  console.log("disabled:", error.code, "|", error.message);
}
