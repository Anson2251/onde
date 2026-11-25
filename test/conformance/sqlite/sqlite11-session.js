// `node:sqlite`: sessions, changesets and patchsets.

const { Database } = require("node:sqlite");

function newDatabase() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE data(key INTEGER PRIMARY KEY, value TEXT)");
  return db;
}

const source = newDatabase();
const target = newDatabase();
target.exec("INSERT INTO data VALUES (1, 'old')");

const session = source.createSession();
source.exec("INSERT INTO data VALUES (1, 'new')");

const changeset = session.changeset();
console.log("changeset:", changeset instanceof Uint8Array, changeset.length > 0);

console.log("default abort:", target.applyChangeset(changeset));
console.log("after abort:", JSON.stringify(target.prepare("SELECT * FROM data").all()));

let conflict = null;
console.log(
  "omit:",
  target.applyChangeset(changeset, {
    onConflict: (code) => {
      conflict = code;
      return 0;
    },
  }),
  conflict === 3,
);
console.log("after omit:", JSON.stringify(target.prepare("SELECT * FROM data").all()));

console.log("replace:", target.applyChangeset(changeset, { onConflict: () => 1 }));
console.log("after replace:", JSON.stringify(target.prepare("SELECT * FROM data").all()));

let filtered = null;
console.log(
  "filter:",
  target.applyChangeset(changeset, {
    filter: (table) => {
      filtered = table;
      return false;
    },
    onConflict: () => 1,
  }),
  filtered,
);

const patchset = session.patchset();
console.log("patchset:", patchset instanceof Uint8Array, patchset.length > 0);
session.close();
try {
  session.changeset();
} catch (error) {
  console.log("closed session:", error.code);
}
