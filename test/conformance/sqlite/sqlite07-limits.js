// `node:sqlite`: limits, transactions, serialization and file locations.

const { Database } = require("node:sqlite");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const db = new Database(":memory:");
console.log("limit names:", Object.keys(db.limits).join(","));
console.log("default length:", db.limits.length >= 1000000);
db.limits.sqlLength = 100000;
console.log("set:", db.limits.sqlLength);
db.limits.sqlLength = Infinity;
console.log("reset:", db.limits.sqlLength >= 100000);
try {
    db.limits.column = -1;
} catch (error) {
    console.log("negative:", error.name, error.code);
}

console.log("transaction before:", db.isTransaction);
db.exec("BEGIN");
console.log("transaction inside:", db.isTransaction);
db.exec("COMMIT");
console.log("transaction after:", db.isTransaction);

db.exec("CREATE TABLE t(v)");
db.exec("INSERT INTO t VALUES (1), (2)");
const bytes = db.serialize();
console.log("serialize:", bytes instanceof Uint8Array, Buffer.isBuffer(bytes), bytes.length > 0);
const copy = new Database(":memory:");
copy.deserialize(bytes);
console.log("round trip:", JSON.stringify(copy.prepare("SELECT v FROM t ORDER BY v").all()));
copy.prepare("SELECT 1").close();

const location = path.join(os.tmpdir(), `onde-sqlite-location-${process.pid}.db`);
const file = new Database(location);
console.log("file location:", path.basename(file.location()).startsWith("onde-sqlite-location-"));
file.close();
fs.rmSync(location, { force: true });
