// `node:sqlite`: iterator shape, early return, invalidation and statement close.

const { Database } = require("node:sqlite");

const db = new Database(":memory:");
db.exec("CREATE TABLE t(a)");
db.exec("INSERT INTO t VALUES (1), (2), (3)");

const select = db.prepare("SELECT a FROM t ORDER BY a");
const iterator = select.iterate();
console.log("self:", iterator[Symbol.iterator]() === iterator);
console.log("first:", JSON.stringify(iterator.next()));
console.log("result prototype is null:", Object.getPrototypeOf(iterator.next()) === null);
console.log("return:", JSON.stringify(iterator.return()));
console.log("after return:", JSON.stringify(iterator.next()));

const again = select.iterate();
console.log("again:", JSON.stringify(again.next()));
select.all();
try {
  again.next();
} catch (error) {
  console.log("invalidated:", error.code, error.message);
}

const closed = select.iterate();
closed.next();
select.close();
try {
  closed.next();
} catch (error) {
  console.log("closed statement:", error.code, error.message);
}
db.close();
