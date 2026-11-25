// `node:sqlite`: type conversion in both directions, BigInt reads and array rows.
// SQLite's storage classes are printed through `typeof()`, so the result does not depend on the
// JavaScript-side type name of the value.

const { Database } = require("node:sqlite");

const db = new Database(":memory:");
db.exec("CREATE TABLE t(v)");
const insert = db.prepare("INSERT INTO t VALUES (?)");

const values = [null, undefined, true, false, 42, -1.5, "text", Buffer.from([1, 2, 255]), 2n ** 40n, NaN, Infinity];
for (const value of values) insert.run(value);

const select = db.prepare("SELECT v, typeof(v) AS kind FROM t");
for (const row of select.all()) {
  const rendered = row.v instanceof Uint8Array ? "bytes" : JSON.stringify(row.v);
  console.log("row:", rendered, row.kind);
}

const range = db.prepare("SELECT 9007199254740993 AS v");
try {
  range.get();
} catch (error) {
  console.log("range:", error.name, error.code);
}
range.setReadBigInts(true);
const big = range.get();
console.log("bigint read:", typeof big.v, JSON.stringify(big, (key, value) => (typeof value === "bigint" ? `${value}n` : value)));

const run = db.prepare("INSERT INTO t VALUES (1)");
run.setReadBigInts(true);
const result = run.run();
console.log("bigint run:", typeof result.changes, typeof result.lastInsertRowid);

select.setReturnArrays(true);
console.log("arrays:", JSON.stringify(select.all().slice(0, 3)));
select.setReturnArrays(false);

insert.close();
console.log("expression columns:", JSON.stringify(db.prepare("SELECT 1 AS one, NULL AS none").columns()));
