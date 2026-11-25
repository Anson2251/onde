// `node:sqlite`: the authorizer callback, its arguments, and its three result codes.

const { Database, constants } = require("node:sqlite");

const db = new Database(":memory:");
db.exec("CREATE TABLE data(a)");
db.exec("INSERT INTO data VALUES (1)");

const seen = [];
db.setAuthorizer((action, arg1, arg2, database, trigger) => {
  seen.push(action);
  return constants.SQLITE_OK;
});
db.prepare("SELECT 1 AS v").get();
console.log("callback:", seen.length > 0, seen.includes(constants.SQLITE_SELECT));

db.setAuthorizer((action) => (action === constants.SQLITE_CREATE_TABLE ? constants.SQLITE_DENY : constants.SQLITE_OK));
try {
  db.exec("CREATE TABLE blocked(a)");
} catch (error) {
  console.log("deny create:", error.code, "|", error.message);
}

db.setAuthorizer((action) => (action === constants.SQLITE_READ ? constants.SQLITE_IGNORE : constants.SQLITE_OK));
console.log("ignore read:", JSON.stringify(db.prepare("SELECT a FROM data").all()));

db.setAuthorizer((action) => (action === constants.SQLITE_SELECT ? constants.SQLITE_DENY : constants.SQLITE_OK));
try {
  db.prepare("SELECT a FROM data").all();
} catch (error) {
  console.log("deny select:", error.code, "|", error.message);
}

db.setAuthorizer(null);
console.log("cleared:", JSON.stringify(db.prepare("SELECT a FROM data").all()));
db.exec("CREATE TABLE allowed(a)");
console.log("after clear create:", db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'allowed'").get().n);
