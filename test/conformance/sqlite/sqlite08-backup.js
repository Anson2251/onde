// `node:sqlite`: `backup()` is a promise; progress is reported after each page batch.

const { Database, backup } = require("node:sqlite");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const source = new Database(":memory:");
source.exec("CREATE TABLE t(a); INSERT INTO t VALUES (1), (2), (3)");
const target = path.join(os.tmpdir(), `onde-sqlite-backup-${process.pid}.db`);
const progress = [];

backup(source, target, {
  rate: 1,
  progress: (entry) => {
    progress.push(entry.totalPages >= entry.remainingPages);
  },
}).then((pages) => {
  console.log("resolved promise:", typeof pages, pages > 0);
  console.log("progress:", progress.length > 0, progress.every(Boolean));
  const copy = new Database(target);
  console.log("copied rows:", JSON.stringify(copy.prepare("SELECT COUNT(*) AS n FROM t").get()));
  copy.close();
  source.close();
  fs.rmSync(target, { force: true });
}).catch((error) => {
  console.log("backup failed:", error.code);
});
