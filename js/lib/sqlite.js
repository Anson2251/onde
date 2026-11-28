"use strict";

// `node:sqlite` — SQLite connections and prepared statements, synchronously.
//
// The host exposes `__ln_host.sqlite` (`crates/ln-runtime/src/host/sqlite.rs`), a handle-based
// facade over `ln-sqlite`; this file is the Node surface over it. It never requires
// `node:sqlite`, so it can be loaded under plain Node for a host shim.
//
// Implemented (`docs/sqlite-plan.md` §1):
//   * `Database`: open/close/exec/prepare/location/isOpen/isTransaction/limits/serialize/
//     deserialize/enableDefensive, the constructor options, and the deprecated `DatabaseSync`
//     alias.
//   * `Statement`: run/get/all/iterate/columns/stat/resetStats/setReadBigInts/setReturnArrays/
//     setAllowBareNamedParameters/setAllowUnknownNamedParameters/sourceSQL/expandedSQL/close/
//     [Symbol.dispose], and the deprecated `StatementSync` alias.
//   * The 45 `constants`, `SQLTagStore`, and `backup()`.
//   * `function()`/`aggregate()`/`setAuthorizer()` (user-defined functions and the authorizer).
//   * `createSession()`/`Session`/`applyChangeset()`, `createModule()` (JavaScript-backed
//     virtual tables), `loadExtension()` and `enableLoadExtension()`.
//
// Not implemented (recorded in docs/compat.md):
//   * `diagnostics_channel` `'sqlite.db.query'` events.
//
// Fidelity notes:
//   * A database or statement that is never closed stays open until the isolate tears down; there
//     is no GC finalizer (QuickJS 0.17 does not deliver them reliably, and SQLite calls must not
//     run from one). `using` / `[Symbol.dispose]` closes deterministically.
//   * Results are null-prototype objects, like Node's, so `Object.keys` and `console.log` match.
//   * `backup()` yields to the event loop between page batches instead of using a thread pool: a
//     connection must stay on its isolate thread.

const { Buffer } = require("buffer");
const {
  isAnyArrayBuffer,
  isArrayBufferView,
} = require("./internal/bytes.js");
const {
  coded,
  invalidArgType,
  invalidArgValue,
  invalidPropertyType,
  outOfRange,
} = require("./internal/errors.js");

const MAX_INT32 = 2147483647;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

// The order Node documents and `Object.keys(database.limits)` shows.
const LIMIT_NAMES = [
  "length",
  "sqlLength",
  "column",
  "exprDepth",
  "compoundSelect",
  "vdbeOp",
  "functionArg",
  "attach",
  "likePatternLength",
  "variableNumber",
  "triggerDepth",
];

const STAT_NAMES = new Set([
  "fullscanStep",
  "sort",
  "autoindex",
  "vmStep",
  "reprepare",
  "run",
  "filterMiss",
  "filterHit",
  "memused",
]);

// `sqlite.constants`, captured from Node v26.12.1's `node:sqlite`.
const constants = {
  SQLITE_CHANGESET_OMIT: 0,
  SQLITE_CHANGESET_REPLACE: 1,
  SQLITE_CHANGESET_ABORT: 2,
  SQLITE_CHANGESET_DATA: 1,
  SQLITE_CHANGESET_NOTFOUND: 2,
  SQLITE_CHANGESET_CONFLICT: 3,
  SQLITE_CHANGESET_CONSTRAINT: 4,
  SQLITE_CHANGESET_FOREIGN_KEY: 5,
  SQLITE_OK: 0,
  SQLITE_DENY: 1,
  SQLITE_IGNORE: 2,
  SQLITE_CREATE_INDEX: 1,
  SQLITE_CREATE_TABLE: 2,
  SQLITE_CREATE_TEMP_INDEX: 3,
  SQLITE_CREATE_TEMP_TABLE: 4,
  SQLITE_CREATE_TEMP_TRIGGER: 5,
  SQLITE_CREATE_TEMP_VIEW: 6,
  SQLITE_CREATE_TRIGGER: 7,
  SQLITE_CREATE_VIEW: 8,
  SQLITE_DELETE: 9,
  SQLITE_DROP_INDEX: 10,
  SQLITE_DROP_TABLE: 11,
  SQLITE_DROP_TEMP_INDEX: 12,
  SQLITE_DROP_TEMP_TABLE: 13,
  SQLITE_DROP_TEMP_TRIGGER: 14,
  SQLITE_DROP_TEMP_VIEW: 15,
  SQLITE_DROP_TRIGGER: 16,
  SQLITE_DROP_VIEW: 17,
  SQLITE_INSERT: 18,
  SQLITE_PRAGMA: 19,
  SQLITE_READ: 20,
  SQLITE_SELECT: 21,
  SQLITE_TRANSACTION: 22,
  SQLITE_UPDATE: 23,
  SQLITE_ATTACH: 24,
  SQLITE_DETACH: 25,
  SQLITE_ALTER_TABLE: 26,
  SQLITE_REINDEX: 27,
  SQLITE_ANALYZE: 28,
  SQLITE_CREATE_VTABLE: 29,
  SQLITE_DROP_VTABLE: 30,
  SQLITE_FUNCTION: 31,
  SQLITE_SAVEPOINT: 32,
  SQLITE_COPY: 0,
  SQLITE_RECURSIVE: 33,
};

// A module-private accessor for the connection id. `backup()` is the only function outside the
// class that needs it, and a symbol method keeps the field itself private.
const kConnectionId = Symbol("ln.sqlite.connectionId");

function hostSqlite() {
  const host = globalThis.__ln_host;
  const sqlite = host === undefined || host === null ? undefined : host.sqlite;
  if (sqlite === undefined || sqlite === null) {
    // Not a Node error: this only happens when the module runs outside onde without the
    // differential oracle's host shim.
    throw new Error("sqlite is unavailable: __ln_host.sqlite is not installed");
  }
  return sqlite;
}

// ---------------------------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------------------------

function checkPath(value) {
  if (typeof value === "string") {
    if (value.includes("\0")) {
      throw invalidArgType(
        "path",
        "a string, Uint8Array, or URL without null bytes",
        value,
      );
    }
    return value;
  }
  if (value instanceof URL) {
    return require("url").fileURLToPath(value);
  }
  if (isAnyArrayBuffer(value) || isArrayBufferView(value)) {
    const bytes =
      isAnyArrayBuffer(value) ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const text = Buffer.from(bytes).toString("utf8");
    if (text.includes("\0")) {
      throw invalidArgType(
        "path",
        "a string, Uint8Array, or URL without null bytes",
        value,
      );
    }
    return text;
  }
  throw invalidArgType("path", "a string, Uint8Array, or URL", value);
}

/** Node rejects a BigInt that does not fit a signed 64-bit integer at bind time. */
function checkBindable(value) {
  if (typeof value === "bigint" && (value < INT64_MIN || value > INT64_MAX)) {
    throw coded(TypeError, "ERR_INVALID_ARG_VALUE", "BigInt value is too large to bind.");
  }
  return value;
}

/** A byte view over any accepted blob source, without copying the `Uint8Array` case. */
function bytesOf(value, name) {
  if (isAnyArrayBuffer(value)) return new Uint8Array(value);
  if (isArrayBufferView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw invalidArgType(
    name,
    "an instance of Buffer, TypedArray, DataView, ArrayBuffer, or SharedArrayBuffer",
    value,
  );
}

function booleanField(options, name, fallback) {
  const value = options[name];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw invalidPropertyType(`options.${name}`, "boolean", value);
  }
  return value;
}

function booleanArgument(name, value) {
  if (typeof value !== "boolean") throw invalidArgType(name, "boolean", value);
  return value;
}

function stringArgument(name, value) {
  if (typeof value !== "string") throw invalidArgType(name, "string", value);
  return value;
}

function normalizeLimits(limits) {
  const pairs = [];
  if (limits === undefined || limits === null) return pairs;
  if (typeof limits !== "object") {
    throw invalidArgType("options.limits", "Object", limits);
  }
  for (const name of LIMIT_NAMES) {
    const value = limits[name];
    if (value === undefined) continue;
    if (typeof value !== "number") {
      throw invalidPropertyType(`options.limits.${name}`, "number", value);
    }
    if (value !== Infinity && (!Number.isInteger(value) || value < 0)) {
      throw outOfRange(`options.limits.${name}`, ">= 0", value);
    }
    pairs.push([name, value === Infinity ? MAX_INT32 : value]);
  }
  return pairs;
}

function normalizeDatabaseOptions(options) {
  if (options === undefined || options === null) options = {};
  if (typeof options !== "object") {
    throw invalidArgType("options", "Object", options);
  }
  let timeout = 0;
  if (options.timeout !== undefined) {
    if (typeof options.timeout !== "number") {
      throw invalidPropertyType("options.timeout", "number", options.timeout);
    }
    if (!Number.isInteger(options.timeout) || options.timeout < 0) {
      throw outOfRange("options.timeout", ">= 0", options.timeout);
    }
    timeout = options.timeout;
  }
  return {
    open: booleanField(options, "open", true),
    readOnly: booleanField(options, "readOnly", false),
    enableForeignKeyConstraints: booleanField(options, "enableForeignKeyConstraints", true),
    enableDoubleQuotedStringLiterals: booleanField(
      options,
      "enableDoubleQuotedStringLiterals",
      false,
    ),
    allowExtension: booleanField(options, "allowExtension", false),
    timeout,
    readBigInts: booleanField(options, "readBigInts", false),
    returnArrays: booleanField(options, "returnArrays", false),
    allowBareNamedParameters: booleanField(options, "allowBareNamedParameters", true),
    allowUnknownNamedParameters: booleanField(options, "allowUnknownNamedParameters", false),
    defensive: booleanField(options, "defensive", true),
    limits: normalizeLimits(options.limits),
  };
}

/** The subset of the options the host needs when a connection is opened. */
function hostOpenOptions(settings) {
  return {
    readOnly: settings.readOnly,
    foreignKeys: settings.enableForeignKeyConstraints,
    doubleQuotedStrings: settings.enableDoubleQuotedStringLiterals,
    defensive: settings.defensive,
    allowExtension: settings.allowExtension,
    timeout: settings.timeout,
    limits: settings.limits,
  };
}

function normalizeStatementOptions(databaseDefaults, options) {
  if (options === undefined || options === null) {
    return { ...databaseDefaults, persistent: false };
  }
  if (typeof options !== "object") {
    throw invalidArgType("options", "Object", options);
  }
  return {
    readBigInts: booleanField(options, "readBigInts", databaseDefaults.readBigInts),
    returnArrays: booleanField(options, "returnArrays", databaseDefaults.returnArrays),
    allowBareNamedParameters: booleanField(
      options,
      "allowBareNamedParameters",
      databaseDefaults.allowBareNamedParameters,
    ),
    allowUnknownNamedParameters: booleanField(
      options,
      "allowUnknownNamedParameters",
      databaseDefaults.allowUnknownNamedParameters,
    ),
    persistent: booleanField(options, "persistent", false),
  };
}

function normalizeFunctionOptions(options, fn) {
  if (options === undefined || options === null) options = {};
  if (typeof options !== "object") {
    throw invalidArgType("options", "Object", options);
  }
  const varargs = booleanField(options, "varargs", false);
  const arity = varargs ? -1 : fn.length;
  return {
    arity,
    varargs,
    deterministic: booleanField(options, "deterministic", false),
    directOnly: booleanField(options, "directOnly", false),
    useBigIntArguments: booleanField(options, "useBigIntArguments", false),
  };
}

function normalizeAggregateOptions(options) {
  if (options === null || typeof options !== "object") {
    throw invalidArgType("options", "Object", options);
  }
  const step = options.step;
  if (typeof step !== "function") {
    throw invalidArgType("options.step", "function", step);
  }
  for (const name of ["result", "inverse"]) {
    if (options[name] !== undefined && typeof options[name] !== "function") {
      throw invalidArgType(`options.${name}`, "function", options[name]);
    }
  }
  const start = options.start;
  if (
    start !== undefined &&
    start !== null &&
    typeof start !== "object" &&
    typeof start !== "function" &&
    typeof start !== "string" &&
    typeof start !== "number"
  ) {
    throw invalidArgType("options.start", "number, string, null, Array, Object, or Function", start);
  }
  const varargs = booleanField(options, "varargs", false);
  return {
    // `step` receives the state first; the SQL arity is the remaining parameters.
    arity: varargs ? -1 : Math.max(step.length - 1, 0),
    varargs,
    deterministic: booleanField(options, "deterministic", false),
    directOnly: booleanField(options, "directOnly", false),
    useBigIntArguments: booleanField(options, "useBigIntArguments", false),
  };
}

function normalizeName(name) {
  stringArgument("name", name);
  if (name.length === 0 || name.includes("\0")) {
    throw invalidArgValue("name", JSON.stringify(name), "must be a non-empty SQL identifier");
  }
  return name;
}

// ---------------------------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------------------------

class Database {
  #path;
  #settings;
  #defaults;
  #handle;
  #open;
  #limits;

  constructor(path, options) {
    this.#path = checkPath(path);
    // Kept whole: `open()` may be called later, and it must apply the same settings.
    this.#settings = normalizeDatabaseOptions(options);
    this.#defaults = {
      readBigInts: this.#settings.readBigInts,
      returnArrays: this.#settings.returnArrays,
      allowBareNamedParameters: this.#settings.allowBareNamedParameters,
      allowUnknownNamedParameters: this.#settings.allowUnknownNamedParameters,
    };
    this.#handle = 0;
    this.#open = false;
    this.#limits = undefined;
    if (this.#settings.open) this.#openConnection();
  }

  #openConnection() {
    this.#handle = hostSqlite().open(this.#path, hostOpenOptions(this.#settings));
    this.#open = true;
  }

  get isOpen() {
    return this.#open;
  }

  get isTransaction() {
    return hostSqlite().isTransaction(this.#handle);
  }

  get limits() {
    if (this.#limits === undefined) {
      const database = this;
      const limits = {};
      for (const name of LIMIT_NAMES) {
        Object.defineProperty(limits, name, {
          enumerable: true,
          configurable: false,
          get() {
            return hostSqlite().limit(database.#handle, name);
          },
          set(value) {
            if (typeof value !== "number") {
              throw invalidArgType("value", "number", value);
            }
            if (value !== Infinity && (!Number.isInteger(value) || value < 0)) {
              throw outOfRange("value", ">= 0", value);
            }
            hostSqlite().setLimit(
              database.#handle,
              name,
              value === Infinity ? MAX_INT32 : value,
            );
          },
        });
      }
      this.#limits = limits;
    }
    return this.#limits;
  }

  [kConnectionId]() {
    return this.#handle;
  }

  open() {
    if (this.#open) throw coded(Error, "ERR_INVALID_STATE", "database is already open");
    this.#openConnection();
  }

  close() {
    if (!this.#open) throw coded(Error, "ERR_INVALID_STATE", "database is not open");
    hostSqlite().close(this.#handle);
    this.#open = false;
  }

  [Symbol.dispose]() {
    if (!this.#open) return;
    hostSqlite().close(this.#handle);
    this.#open = false;
  }

  exec(sql) {
    stringArgument("sql", sql);
    hostSqlite().exec(this.#handle, sql);
    return undefined;
  }

  prepare(sql, options) {
    stringArgument("sql", sql);
    const statementOptions = normalizeStatementOptions(this.#defaults, options);
    const handle = hostSqlite().prepare(
      this.#handle,
      sql,
      statementOptions.persistent,
    );
    return new Statement(handle, statementOptions);
  }

  function(name, options, fn) {
    normalizeName(name);
    if (typeof options === "function") {
      fn = options;
      options = undefined;
    }
    if (typeof fn !== "function") throw invalidArgType("fn", "function", fn);
    const settings = normalizeFunctionOptions(options, fn);
    hostSqlite().createFunction(this.#handle, name, settings, fn);
    return undefined;
  }

  aggregate(name, options) {
    normalizeName(name);
    const settings = normalizeAggregateOptions(options);
    hostSqlite().createAggregate(this.#handle, name, settings, [
      options.start,
      options.step,
      options.result,
      options.inverse,
    ]);
    return undefined;
  }

  setAuthorizer(callback) {
    if (callback !== null && typeof callback !== "function") {
      throw invalidArgType("callback", "function", callback);
    }
    hostSqlite().setAuthorizer(this.#handle, callback);
    return undefined;
  }

  createModule(name, options) {
    normalizeName(name);
    if (options === null || typeof options !== "object") {
      throw invalidArgType("options", "Object", options);
    }
    const columns = options.columns;
    if (!Array.isArray(columns) || columns.length === 0) {
      throw coded(
        TypeError,
        "ERR_INVALID_ARG_VALUE",
        'The "options.columns" array must not be empty.',
      );
    }
    const definitions = [];
    for (const column of columns) {
      if (column === null || typeof column !== "object") {
        throw invalidArgType("options.columns", "an array of column objects", column);
      }
      const columnName = stringArgument("options.columns[].name", column.name);
      const type = column.type;
      if (
        type !== "INTEGER" &&
        type !== "TEXT" &&
        type !== "REAL" &&
        type !== "BLOB" &&
        type !== "ANY"
      ) {
        throw coded(
          TypeError,
          "ERR_INVALID_ARG_VALUE",
          "The column \"type\" property must be one of 'INTEGER', 'TEXT', 'REAL', 'BLOB', or 'ANY'.",
        );
      }
      const hidden = column.hidden === undefined ? false : booleanArgument("options.columns[].hidden", column.hidden);
      definitions.push([columnName, type, hidden]);
    }
    if (typeof options.rows !== "function") {
      throw invalidArgType("options.rows", "function", options.rows);
    }
    const settings = {
      rows: options.rows,
      directOnly: booleanField(options, "directOnly", false),
      useBigIntArguments: booleanField(options, "useBigIntArguments", false),
    };
    hostSqlite().createModule(this.#handle, name, definitions, settings);
    return undefined;
  }

  createSession(options = {}) {
    if (options === null || typeof options !== "object") {
      throw invalidArgType("options", "Object", options);
    }
    let table = null;
    if (options.table !== undefined) table = stringArgument("options.table", options.table);
    let database = "main";
    if (options.db !== undefined) database = stringArgument("options.db", options.db);
    const handle = hostSqlite().createSession(this.#handle, { table, db: database });
    return new Session(handle);
  }

  applyChangeset(changeset, options = {}) {
    const bytes = bytesOf(changeset, "changeset");
    if (options === null || typeof options !== "object") {
      throw invalidArgType("options", "Object", options);
    }
    for (const name of ["filter", "onConflict"]) {
      if (options[name] !== undefined && typeof options[name] !== "function") {
        throw invalidArgType(`options.${name}`, "function", options[name]);
      }
    }
    return hostSqlite().applyChangeset(this.#handle, bytes, {
      filter: options.filter,
      onConflict: options.onConflict,
    });
  }

  enableLoadExtension(allow) {
    booleanArgument("allow", allow);
    hostSqlite().enableLoadExtension(this.#handle, allow);
    return undefined;
  }

  loadExtension(path, entryPoint) {
    stringArgument("path", path);
    let entry = null;
    if (entryPoint !== undefined) entry = stringArgument("entryPoint", entryPoint);
    hostSqlite().loadExtension(this.#handle, path, entry);
    return undefined;
  }

  createTagStore(maxSize = 1000) {
    if (typeof maxSize !== "number") {
      throw invalidArgType("maxSize", "number", maxSize);
    }
    if (!Number.isInteger(maxSize) || maxSize <= 0) {
      throw outOfRange("maxSize", "a positive integer", maxSize);
    }
    return new SQLTagStore(this, maxSize);
  }

  location(dbName = "main") {
    stringArgument("dbName", dbName);
    return hostSqlite().location(this.#handle, dbName);
  }

  serialize(dbName = "main") {
    stringArgument("dbName", dbName);
    return hostSqlite().serialize(this.#handle, dbName);
  }

  deserialize(buffer, options) {
    const bytes = bytesOf(buffer, "buffer");
    let dbName = "main";
    if (options !== undefined && options !== null) {
      if (typeof options !== "object") {
        throw invalidArgType("options", "Object", options);
      }
      if (options.dbName !== undefined) dbName = stringArgument("options.dbName", options.dbName);
    }
    hostSqlite().deserialize(this.#handle, dbName, bytes);
    return undefined;
  }

  enableDefensive(active) {
    booleanArgument("active", active);
    hostSqlite().enableDefensive(this.#handle, active);
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Statement
// ---------------------------------------------------------------------------------------------

// Node's iterator results are null-prototype and always carry `value` (`null` when done).
function iteratorResult(finished, value) {
  const object = Object.create(null);
  object.done = finished;
  object.value = value;
  return object;
}

class Statement {
  #handle;
  #settings;
  #closed = false;
  #columnNames;

  constructor(handle, settings) {
    this.#handle = handle;
    this.#settings = settings;
    this.#columnNames = undefined;
  }

  #assertUsable() {
    if (this.#closed) {
      throw coded(Error, "ERR_INVALID_STATE", "statement has been finalized");
    }
  }

  #columns() {
    return hostSqlite()
      .columns(this.#handle)
      .map((column) => {
        const object = Object.create(null);
        // SQLite reports no metadata for an expression; Node spells that `null`, not `undefined`.
        object.column = column.column === undefined ? null : column.column;
        object.database = column.database === undefined ? null : column.database;
        object.name = column.name;
        object.table = column.table === undefined ? null : column.table;
        object.type = column.type === undefined ? null : column.type;
        return object;
      });
  }

  #names() {
    if (this.#columnNames === undefined) {
      this.#columnNames = hostSqlite()
        .columns(this.#handle)
        .map((column) => column.name);
    }
    return this.#columnNames;
  }

  /** Shape one value row for the configured result form. */
  #shape(row) {
    if (this.#settings.returnArrays) return row;
    const names = this.#names();
    const object = Object.create(null);
    for (let index = 0; index < names.length; index += 1) {
      object[names[index]] = row[index];
    }
    return object;
  }

  /**
   * Node's argument split: a non-null object in first position is the named-parameter map
   * (arrays included); everything else, including `null`/`undefined`, is positional.
   */
  #split(args) {
    if (args.length === 0) return { named: null, anonymous: [] };
    const first = args[0];
    if (
      first !== null &&
      typeof first === "object" &&
      !isAnyArrayBuffer(first) &&
      !isArrayBufferView(first)
    ) {
      const named = [];
      for (const key of Object.keys(first)) named.push([key, first[key]]);
      return { named, anonymous: args.slice(1) };
    }
    return { named: null, anonymous: args };
  }

  #bind(args) {
    const { named, anonymous } = this.#split(args);
    // A BigInt outside signed 64-bit is Node's ERR_INVALID_ARG_VALUE; checking here also keeps
    // the host conversion exact (the engine truncates a too-large BigInt silently).
    if (named !== null) {
      for (const entry of named) checkBindable(entry[1]);
    }
    for (const value of anonymous) checkBindable(value);
    hostSqlite().bind(
      this.#handle,
      named,
      anonymous,
      this.#settings.allowBareNamedParameters,
      this.#settings.allowUnknownNamedParameters,
    );
  }

  run(...args) {
    this.#assertUsable();
    this.#bind(args);
    const result = hostSqlite().run(this.#handle, this.#settings.readBigInts);
    const object = Object.create(null);
    object.changes = result.changes;
    object.lastInsertRowid = result.lastInsertRowid;
    return object;
  }

  get(...args) {
    this.#assertUsable();
    this.#bind(args);
    const row = hostSqlite().first(this.#handle, this.#settings.readBigInts);
    return row === null ? undefined : this.#shape(row);
  }

  all(...args) {
    this.#assertUsable();
    this.#bind(args);
    const rows = hostSqlite().all(this.#handle, this.#settings.readBigInts);
    return rows.map((row) => this.#shape(row));
  }

  iterate(...args) {
    this.#assertUsable();
    this.#bind(args);
    const { generation, row } = hostSqlite().begin(this.#handle, this.#settings.readBigInts);
    const statement = this;
    let current = row;
    let done = row === null;
    return {
      next() {
        if (done) return iteratorResult(true, null);
        const value = statement.#shape(current);
        try {
          current = hostSqlite().next(
            statement.#handle,
            generation,
            statement.#settings.readBigInts,
          );
        } catch (error) {
          done = true;
          throw error;
        }
        if (current === null) done = true;
        return iteratorResult(false, value);
      },
      return() {
        if (!done) {
          done = true;
          // A stale generation is a no-op in the host; the iterator is simply invalidated.
          hostSqlite().finish(statement.#handle, generation);
        }
        return iteratorResult(true, null);
      },
      [Symbol.iterator]() {
        return this;
      },
    };
  }

  columns() {
    this.#assertUsable();
    return this.#columns();
  }

  stat(counter) {
    this.#assertUsable();
    if (typeof counter !== "string" || !STAT_NAMES.has(counter)) {
      throw coded(
        TypeError,
        "ERR_INVALID_ARG_VALUE",
        'The "counter" argument is not a valid statistic name.',
      );
    }
    return hostSqlite().stat(this.#handle, counter);
  }

  resetStats() {
    this.#assertUsable();
    hostSqlite().resetStats(this.#handle);
    return undefined;
  }

  setReadBigInts(enabled) {
    booleanArgument("enabled", enabled);
    this.#settings.readBigInts = enabled;
  }

  setReturnArrays(enabled) {
    booleanArgument("enabled", enabled);
    this.#settings.returnArrays = enabled;
  }

  setAllowBareNamedParameters(enabled) {
    booleanArgument("enabled", enabled);
    this.#settings.allowBareNamedParameters = enabled;
  }

  setAllowUnknownNamedParameters(enabled) {
    booleanArgument("enabled", enabled);
    this.#settings.allowUnknownNamedParameters = enabled;
  }

  get sourceSQL() {
    this.#assertUsable();
    return hostSqlite().sourceSQL(this.#handle);
  }

  get expandedSQL() {
    this.#assertUsable();
    return hostSqlite().expandedSQL(this.#handle);
  }

  close() {
    this.#assertUsable();
    hostSqlite().finalize(this.#handle);
    this.#closed = true;
  }

  [Symbol.dispose]() {
    if (this.#closed) return;
    hostSqlite().finalize(this.#handle);
    this.#closed = true;
  }
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

class Session {
  #handle;
  #closed = false;

  constructor(handle) {
    this.#handle = handle;
  }

  #assertUsable() {
    if (this.#closed) throw coded(Error, "ERR_INVALID_STATE", "session has been closed");
  }

  changeset() {
    this.#assertUsable();
    return hostSqlite().sessionChangeset(this.#handle);
  }

  patchset() {
    this.#assertUsable();
    return hostSqlite().sessionPatchset(this.#handle);
  }

  close() {
    this.#assertUsable();
    hostSqlite().sessionClose(this.#handle);
    this.#closed = true;
  }

  [Symbol.dispose]() {
    if (this.#closed) return;
    hostSqlite().sessionClose(this.#handle);
    this.#closed = true;
  }
}

// ---------------------------------------------------------------------------------------------
// SQLTagStore
// ---------------------------------------------------------------------------------------------

class SQLTagStore {
  #database;
  #capacity;
  #statements = new Map();

  constructor(database, maxSize) {
    this.#database = database;
    this.#capacity = maxSize;
  }

  #statement(strings) {
    // The cache key is the literal text and the placeholder positions; case-sensitive.
    const key = strings.join("\u0000");
    const cached = this.#statements.get(key);
    if (cached !== undefined) {
      // Refresh LRU order.
      this.#statements.delete(key);
      this.#statements.set(key, cached);
      return cached;
    }
    const statement = this.#database.prepare(strings.join("?"));
    this.#statements.set(key, statement);
    if (this.#statements.size > this.#capacity) {
      const oldest = this.#statements.keys().next().value;
      this.#statements.get(oldest).close();
      this.#statements.delete(oldest);
    }
    return statement;
  }

  run(strings, ...values) {
    return this.#statement(strings).run(...values);
  }

  get(strings, ...values) {
    return this.#statement(strings).get(...values);
  }

  all(strings, ...values) {
    return this.#statement(strings).all(...values);
  }

  iterate(strings, ...values) {
    return this.#statement(strings).iterate(...values);
  }

  clear() {
    for (const statement of this.#statements.values()) statement.close();
    this.#statements.clear();
  }

  get size() {
    return this.#statements.size;
  }

  get capacity() {
    return this.#capacity;
  }

  get db() {
    return this.#database;
  }
}

// ---------------------------------------------------------------------------------------------
// backup()
// ---------------------------------------------------------------------------------------------

async function backup(sourceDb, path, options = {}) {
  if (!(sourceDb instanceof Database)) {
    throw invalidArgType("sourceDb", "an instance of Database", sourceDb);
  }
  const targetPath = checkPath(path);
  if (options === null || typeof options !== "object") {
    throw invalidArgType("options", "Object", options);
  }
  let rate = 100;
  if (options.rate !== undefined) {
    if (typeof options.rate !== "number") {
      throw invalidPropertyType("options.rate", "number", options.rate);
    }
    if (!Number.isInteger(options.rate) || options.rate <= 0) {
      throw outOfRange("options.rate", "a positive integer", options.rate);
    }
    rate = options.rate;
  }
  let progress;
  if (options.progress !== undefined) {
    if (typeof options.progress !== "function") {
      throw invalidArgType("options.progress", "of type function", options.progress);
    }
    progress = options.progress;
  }
  const source = options.source === undefined ? "main" : stringArgument("options.source", options.source);
  const target = options.target === undefined ? "main" : stringArgument("options.target", options.target);

  const host = hostSqlite();
  const handle = host.backupInit(sourceDb[kConnectionId](), targetPath, source, target);
  try {
    for (;;) {
      const step = host.backupStep(handle, rate);
      if (progress !== undefined) {
        progress({ totalPages: step.totalPages, remainingPages: step.remainingPages });
      }
      if (step.done) return step.totalPages;
      // Let timers, I/O and other work run between batches; the connection stays on this thread.
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    host.backupFinish(handle);
  }
}

// ---------------------------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------------------------

module.exports = {
  Database,
  DatabaseSync: Database,
  Statement,
  StatementSync: Statement,
  Session,
  constants,
  backup,
};
