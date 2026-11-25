// `node:sqlite`: the tag store's LRU cache and template binding.

const { Database } = require("node:sqlite");

const db = new Database(":memory:");
db.exec("CREATE TABLE users(id INTEGER, name TEXT)");
const store = db.createTagStore();

store.run`INSERT INTO users VALUES (${1}, ${"Alice"})`;
store.run`INSERT INTO users VALUES (${2}, ${"Bob"})`;
console.log("rows:", JSON.stringify(store.all`SELECT * FROM users ORDER BY id`));
console.log("get:", JSON.stringify(store.get`SELECT * FROM users WHERE name = ${"Alice"}`));

console.log("size after two shapes:", store.size);
store.get`SELECT * FROM users WHERE name = ${"Bob"}`;
console.log("same shape reuses:", store.size);
store.get`select * from users where name = ${"Bob"}`;
console.log("case sensitive:", store.size);
console.log("capacity:", store.capacity, "db:", store.db === db);

const small = db.createTagStore(2);
small.all`SELECT 1`;
small.all`SELECT 2`;
small.all`SELECT 3`;
console.log("eviction:", small.size, small.capacity);
small.clear();
console.log("clear:", small.size);

store.clear();
console.log("store clear:", store.size);
