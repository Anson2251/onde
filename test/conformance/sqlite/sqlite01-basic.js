// `node:sqlite`: the core path — open, exec, prepare, run, all/get, metadata, close.
// Deterministic: in-memory only, no timing, no version strings.

const { Database } = require("node:sqlite");

const db = new Database(":memory:");
console.log(`open: ${db.isOpen} tx: ${db.isTransaction} location: ${db.location()}`);

db.exec(`
  CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT);
  INSERT INTO t(name) VALUES ('seed');
`);

const insert = db.prepare("INSERT INTO t(name) VALUES (?)");
console.log("insert:", JSON.stringify(insert.run("a")), JSON.stringify(insert.run("b")));

const select = db.prepare("SELECT id, name FROM t ORDER BY id");
console.log("all:", JSON.stringify(select.all()));
console.log("get:", JSON.stringify(select.get()));
console.log("row prototype is null:", Object.getPrototypeOf(select.get()) === null);
console.log("run on select:", JSON.stringify(select.run()));
console.log("source:", JSON.stringify(select.sourceSQL));
console.log("expanded:", JSON.stringify(select.expandedSQL));

const empty = db.prepare("SELECT id FROM t WHERE id = -1");
console.log("empty get:", empty.get(), "empty all:", JSON.stringify(empty.all()));

console.log("columns:", JSON.stringify(select.columns()));
console.log("column prototype is null:", Object.getPrototypeOf(select.columns()[0]) === null);

select.close();
try {
  select.all();
} catch (error) {
  console.log("closed statement:", error.code, error.message);
}

db.close();
console.log("closed database open:", db.isOpen);
try {
  db.exec("SELECT 1");
} catch (error) {
  console.log("closed database use:", error.code, error.message);
}
try {
  db.close();
} catch (error) {
  console.log("close twice:", error.code, error.message);
}
