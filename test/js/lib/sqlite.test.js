"use strict";

// Self-check for js/lib/sqlite.js. Like zlib.test.js it is runtime-agnostic: under plain Node the
// lite host (`__ln_host.sqlite`) is absent, so it prints one skip line; the lite run asserts.
//
// The input-output fidelity is pinned by test/conformance/sqlite (recorded from Node). This file
// covers the surface we own: validation, error codes, class shape, and the documented divergences.

if (typeof globalThis.__ln_host !== "object") {
  console.log("skip: lite host unavailable");
  process.exit(0);
}

const sqlite = require("../../../js/lib/sqlite.js");
const os = require("os");
const path = require("path");
const fs = require("fs");

let passed = 0;
let failed = 0;
const failures = [];

function record(condition, detail) {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(detail);
  }
}

function eq(actual, expected, message) {
  record(
    actual === expected,
    `${message} (expected ${String(expected)}, got ${String(actual)})`,
  );
}

function throwsCode(fn, code, message) {
  try {
    fn();
    record(false, `${message} (expected a throw)`);
    return undefined;
  } catch (error) {
    record(
      error !== null && error !== undefined && error.code === code,
      `${message} (code was ${error && error.code})`,
    );
    return error;
  }
}

// ---------------------------------------------------------------------------------------------
// Module shape
// ---------------------------------------------------------------------------------------------

eq(typeof sqlite.Database, "function", "Database is a class");
eq(typeof sqlite.Statement, "function", "Statement is a class");
eq(sqlite.DatabaseSync, sqlite.Database, "DatabaseSync aliases Database");
eq(sqlite.StatementSync, sqlite.Statement, "StatementSync aliases Statement");
eq(Object.keys(sqlite.constants).length, 45, "45 constants");
eq(sqlite.constants.SQLITE_RECURSIVE, 33, "SQLITE_RECURSIVE");
eq(typeof sqlite.Session, "function", "Session is a class");
eq(typeof sqlite.backup, "function", "backup is a function");

// ---------------------------------------------------------------------------------------------
// Database lifecycle
// ---------------------------------------------------------------------------------------------

const db = new sqlite.Database(":memory:");
eq(db.isOpen, true, "isOpen after construction");
eq(db.isTransaction, false, "not in a transaction");
eq(db.location(), null, "in-memory location is null");

db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)");
const insert = db.prepare("INSERT INTO t(name) VALUES (?)");
const inserted = insert.run("a");
eq(inserted.changes, 1, "insert changes");
eq(inserted.lastInsertRowid, 1, "insert rowid");
eq(Object.getPrototypeOf(inserted), null, "run() result is null-prototype");

const select = db.prepare("SELECT id, name FROM t");
const row = select.get();
eq(row.id, 1, "row id");
eq(row.name, "a", "row name");
eq(Object.getPrototypeOf(row), null, "row is null-prototype");

// ---------------------------------------------------------------------------------------------
// Validation and errors
// ---------------------------------------------------------------------------------------------

throwsCode(() => new sqlite.Database(42), "ERR_INVALID_ARG_TYPE", "path type");
throwsCode(
  () => new sqlite.Database(":memory:", { readOnly: 1 }),
  "ERR_INVALID_ARG_TYPE",
  "boolean option type",
);
throwsCode(
  () => new sqlite.Database(":memory:", { timeout: -1 }),
  "ERR_OUT_OF_RANGE",
  "negative timeout",
);
throwsCode(() => db.prepare(), "ERR_INVALID_ARG_TYPE", "prepare needs a string");
throwsCode(() => db.prepare(""), "ERR_INVALID_ARG_VALUE", "empty SQL");
throwsCode(() => db.prepare("SELECT FROM"), "ERR_SQLITE_ERROR", "syntax error");

const syntax = throwsCode(() => db.prepare("SELECT FROM"), "ERR_SQLITE_ERROR", "syntax error code");
if (syntax !== undefined) {
  eq(syntax.errcode, 1, "syntax errcode");
  eq(syntax.errstr, "SQL logic error", "syntax errstr");
  eq(typeof syntax.message, "string", "syntax message");
}

const named = db.prepare("SELECT :a AS a, $b AS b");
const unknown = throwsCode(() => named.get({ a: 1, z: 2 }), "ERR_INVALID_STATE", "unknown name");
if (unknown !== undefined) eq(unknown.message, "Unknown named parameter 'z'", "unknown message");

const ambiguous = db.prepare("SELECT $k AS a, @k AS b");
const conflict = throwsCode(() => ambiguous.get({ k: 1 }), "ERR_INVALID_STATE", "ambiguous name");
if (conflict !== undefined) {
  eq(
    conflict.message,
    "Cannot create bare named parameter 'k' because of conflicting names '$k' and '@k'.",
    "ambiguous message",
  );
}

const big = db.prepare("SELECT ? AS v");
const tooLarge = throwsCode(() => big.get(2n ** 64n), "ERR_INVALID_ARG_VALUE", "bigint range");
if (tooLarge !== undefined) {
  eq(tooLarge.message, "BigInt value is too large to bind.", "bigint message");
}

eq(db.prepare("SELECT ? AS v").get(null).v, null, "null binds NULL");
eq(db.prepare("SELECT ? AS v").get(undefined).v, null, "undefined binds NULL");

// ---------------------------------------------------------------------------------------------
// Statement flags and metadata
// ---------------------------------------------------------------------------------------------

select.setReturnArrays(true);
const arrays = select.all();
record(Array.isArray(arrays[0]), "returnArrays yields arrays");
eq(arrays[0][1], "a", "array row value");
select.setReturnArrays(false);

const bigInts = db.prepare("SELECT 1 AS one");
bigInts.setReadBigInts(true);
eq(typeof bigInts.get().one, "bigint", "readBigInts yields a bigint");
bigInts.setReadBigInts(false);

eq(select.sourceSQL, "SELECT id, name FROM t", "sourceSQL");
eq(select.expandedSQL, "SELECT id, name FROM t", "expandedSQL");
eq(select.columns().length, 2, "columns length");
eq(Object.getPrototypeOf(select.columns()[0]), null, "column is null-prototype");
eq(select.columns()[0].type, "INTEGER", "column type");
const stat = select.stat("fullscanStep");
record(typeof stat === "number" && stat >= 0, "stat returns a number");
eq(select.stat("memused") > 0, true, "memused is positive");
select.resetStats();
eq(select.stat("fullscanStep"), 0, "resetStats zeroes counters");
throwsCode(() => select.stat("autoIndex"), "ERR_INVALID_ARG_VALUE", "stat name is case-sensitive");

// ---------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------

eq(Object.keys(db.limits).join(","),
  "length,sqlLength,column,exprDepth,compoundSelect,vdbeOp,functionArg,attach,likePatternLength,variableNumber,triggerDepth",
  "limit names");
record(db.limits.length >= 1_000_000, "default length limit");
db.limits.sqlLength = 100000;
eq(db.limits.sqlLength, 100000, "set limit");
db.limits.sqlLength = Infinity;
record(db.limits.sqlLength >= 100000, "Infinity resets");
throwsCode(() => { db.limits.column = -1; }, "ERR_OUT_OF_RANGE", "negative limit");

// ---------------------------------------------------------------------------------------------
// Transactions, serialization, tag store
// ---------------------------------------------------------------------------------------------

eq(db.isTransaction, false, "autocommit before BEGIN");
db.exec("BEGIN");
eq(db.isTransaction, true, "inside a transaction");
db.exec("COMMIT");
eq(db.isTransaction, false, "after COMMIT");

const bytes = db.serialize();
record(bytes instanceof Uint8Array, "serialize returns a Uint8Array");
record(!Buffer.isBuffer(bytes), "serialize is not a Buffer");
const clone = new sqlite.Database(":memory:");
clone.deserialize(bytes);
eq(clone.prepare("SELECT COUNT(*) AS n FROM t").get().n, 1, "deserialize round trip");
clone.close();

const store = db.createTagStore(2);
store.run`INSERT INTO t(name) VALUES (${"tagged"})`;
eq(store.get`SELECT name FROM t WHERE name = ${"tagged"}`.name, "tagged", "tag store binds");
eq(store.capacity, 2, "tag store capacity");
eq(store.db, db, "tag store db");
store.all`SELECT 1`;
store.all`SELECT 2`;
store.all`SELECT 3`;
eq(store.size, 2, "tag store evicts");
store.clear();
eq(store.size, 0, "tag store clears");

// ---------------------------------------------------------------------------------------------
// user-defined functions and aggregates
// ---------------------------------------------------------------------------------------------

const functions = new sqlite.Database(":memory:");
functions.function("twice", (value) => value * 2);
eq(functions.prepare("SELECT twice(21) AS v").get().v, 42, "scalar function");
functions.function("identity", (value) => value);
eq(functions.prepare("SELECT typeof(identity(1)) AS t").get().t, "real", "number returns REAL");
functions.function("big", () => 2n ** 40n);
eq(functions.prepare("SELECT typeof(big()) AS t").get().t, "integer", "bigint returns INTEGER");
functions.function("bad", () => true);
throwsCode(() => functions.prepare("SELECT bad()").get(), "ERR_SQLITE_ERROR", "boolean return is rejected");
functions.function("boom", () => {
  throw new TypeError("function failed");
});
const thrown = throwsCode(() => functions.prepare("SELECT boom()").get(), undefined, "function throw");
if (thrown !== undefined) {
  eq(thrown.name, "TypeError", "function throw keeps the error type");
  eq(thrown.message, "function failed", "function throw keeps the message");
}
functions.function("type_of_arg", { useBigIntArguments: true }, (value) => typeof value);
eq(functions.prepare("SELECT type_of_arg(42) AS v").get().v, "bigint", "useBigIntArguments");
functions.function("arg_count", { varargs: true }, (...args) => args.length);
eq(functions.prepare("SELECT arg_count(1, 2, 3) AS v").get().v, 3, "varargs");

functions.aggregate("my_sum", { start: 0, step: (state, value) => state + value });
eq(
  functions.prepare("SELECT my_sum(x) AS v FROM (SELECT 1 AS x UNION ALL SELECT 2)").get().v,
  3,
  "aggregate",
);
functions.aggregate("window_sum", {
  start: 0,
  step: (state, value) => state + value,
  result: (state) => state,
  inverse: (state, value) => state - value,
});
eq(
  functions
    .prepare(
      "SELECT window_sum(x) OVER (ORDER BY x ROWS BETWEEN CURRENT ROW AND CURRENT ROW) AS v FROM (SELECT 1 AS x UNION ALL SELECT 2)",
    )
    .all()
    .map((row) => row.v)
    .join(","),
  "1,2",
  "window function",
);
functions.close();

// ---------------------------------------------------------------------------------------------
// authorizer
// ---------------------------------------------------------------------------------------------

const authorized = new sqlite.Database(":memory:");
authorized.exec("CREATE TABLE data(a)");
authorized.exec("INSERT INTO data VALUES (1)");
const actions = [];
authorized.setAuthorizer((action) => {
  actions.push(action);
  return sqlite.constants.SQLITE_OK;
});
authorized.prepare("SELECT 1 AS v").get();
record(actions.includes(sqlite.constants.SQLITE_SELECT), "authorizer observes SELECT");
authorized.setAuthorizer((action) =>
  action === sqlite.constants.SQLITE_READ ? sqlite.constants.SQLITE_IGNORE : sqlite.constants.SQLITE_OK,
);
eq(authorized.prepare("SELECT a FROM data").get().a, null, "authorizer IGNORE");
authorized.setAuthorizer((action) =>
  action === sqlite.constants.SQLITE_CREATE_TABLE ? sqlite.constants.SQLITE_DENY : sqlite.constants.SQLITE_OK,
);
throwsCode(() => authorized.exec("CREATE TABLE blocked(a)"), "ERR_SQLITE_ERROR", "authorizer DENY");
authorized.setAuthorizer(null);
authorized.exec("CREATE TABLE allowed(a)");
eq(authorized.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'allowed'").get().n, 1, "authorizer cleared");
authorized.close();

// ---------------------------------------------------------------------------------------------
// sessions and changesets
// ---------------------------------------------------------------------------------------------

const sessionSource = new sqlite.Database(":memory:");
const sessionTarget = new sqlite.Database(":memory:");
for (const database of [sessionSource, sessionTarget]) {
  database.exec("CREATE TABLE data(key INTEGER PRIMARY KEY, value TEXT)");
}
sessionTarget.exec("INSERT INTO data VALUES (1, 'old')");
const session = sessionSource.createSession();
sessionSource.exec("INSERT INTO data VALUES (1, 'new')");
const changeset = session.changeset();
record(changeset instanceof Uint8Array, "changeset is a Uint8Array");
eq(sessionTarget.applyChangeset(changeset), false, "default conflict aborts");
eq(sessionTarget.applyChangeset(changeset, { onConflict: () => sqlite.constants.SQLITE_CHANGESET_OMIT }), true, "conflict OMIT");
eq(
  sessionTarget.applyChangeset(changeset, { onConflict: () => sqlite.constants.SQLITE_CHANGESET_REPLACE }),
  true,
  "conflict REPLACE",
);
eq(sessionTarget.prepare("SELECT value FROM data").get().value, "new", "replaced row");
record(session.patchset() instanceof Uint8Array, "patchset is a Uint8Array");
session.close();
throwsCode(() => session.changeset(), "ERR_INVALID_STATE", "closed session");
const disposable = sessionSource.createSession();
disposable[Symbol.dispose]();
record(true, "session dispose is idempotent");
sessionSource.close();
sessionTarget.close();

// ---------------------------------------------------------------------------------------------
// virtual tables
// ---------------------------------------------------------------------------------------------

const virtual = new sqlite.Database(":memory:");
virtual.createModule("series", {
  columns: [
    { name: "value", type: "INTEGER" },
    { name: "start", type: "INTEGER", hidden: true },
    { name: "stop", type: "INTEGER", hidden: true },
  ],
  *rows(start, stop) {
    start ??= 1;
    stop ??= 3;
    for (let value = start; value <= stop; value += 1) yield [value];
  },
});
eq(
  virtual.prepare("SELECT value FROM series(2, 4)").all().map((row) => row.value).join(","),
  "2,3,4",
  "virtual table with hidden arguments",
);
virtual.createModule("counter", {
  columns: [{ name: "value", type: "INTEGER" }],
  *rows() {
    yield [1];
    yield [2n];
  },
});
eq(virtual.prepare("SELECT typeof(value) AS t FROM counter").all()[1].t, "integer", "virtual table bigint");
throwsCode(
  () => virtual.createModule("empty", { columns: [], rows() { return []; } }),
  "ERR_INVALID_ARG_VALUE",
  "empty column list",
);
throwsCode(
  () => virtual.createModule("bad_type", { columns: [{ name: "x", type: "WEIRD" }], rows() { return []; } }),
  "ERR_INVALID_ARG_VALUE",
  "invalid column type",
);
virtual.close();

// ---------------------------------------------------------------------------------------------
// extension loading
// ---------------------------------------------------------------------------------------------

const closedExtensions = new sqlite.Database(":memory:");
throwsCode(() => closedExtensions.enableLoadExtension(true), "ERR_INVALID_STATE", "extension loading is opt-in");
closedExtensions.close();
const extensions = new sqlite.Database(":memory:", { allowExtension: true });
extensions.enableLoadExtension(true);
throwsCode(
  () => extensions.loadExtension("/definitely-not-a-real-extension.dylib"),
  "ERR_LOAD_SQLITE_EXTENSION",
  "missing extension",
);
extensions.enableLoadExtension(false);
throwsCode(
  () => extensions.loadExtension("/definitely-not-a-real-extension.dylib"),
  "ERR_INVALID_STATE",
  "disabled extension loading",
);
extensions.close();

// ---------------------------------------------------------------------------------------------
// close() / [Symbol.dispose]
// ---------------------------------------------------------------------------------------------

insert.close();
throwsCode(() => insert.run("x"), "ERR_INVALID_STATE", "closed statement");
insert[Symbol.dispose]();
record(true, "double dispose is a no-op");

db.close();
eq(db.isOpen, false, "closed database");
throwsCode(() => db.exec("SELECT 1"), "ERR_INVALID_STATE", "closed database use");
throwsCode(() => db.close(), "ERR_INVALID_STATE", "second close");
db[Symbol.dispose]();
record(true, "dispose after close is a no-op");

// ---------------------------------------------------------------------------------------------
// backup (async)
// ---------------------------------------------------------------------------------------------

(async () => {
  const source = new sqlite.Database(":memory:");
  source.exec("CREATE TABLE t(a); INSERT INTO t VALUES (1), (2)");
  const target = path.join(os.tmpdir(), `ln-sqlite-test-${process.pid}.db`);
  const progress = [];
  try {
    const pages = await sqlite.backup(source, target, {
      rate: 1,
      progress: (entry) => progress.push(entry.totalPages >= entry.remainingPages),
    });
    record(typeof pages === "number" && pages > 0, "backup resolves with a page count");
    record(progress.length > 0 && progress.every(Boolean), "backup reports progress");
    const copy = new sqlite.Database(target);
    eq(copy.prepare("SELECT COUNT(*) AS n FROM t").get().n, 2, "backup copies rows");
    copy.close();
  } finally {
    source.close();
    fs.rmSync(target, { force: true });
  }

  console.log(`${passed} passed, ${failed} failed`);
  if (failed !== 0) {
    for (const failure of failures) console.log(`  fail: ${failure}`);
    process.exitCode = 1;
  }
})();
