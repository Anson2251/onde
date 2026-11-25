# `node:sqlite` — API capture

Reference capture of Node's SQLite module, used by
[`../sqlite-plan.md`](../sqlite-plan.md). It records what the module *is*; the plan records what
onde will build and where it deliberately differs.

- **Documentation:** <https://nodejs.org/api/sqlite.html>, rendered for Node **v26.13.1**
  (the `sqlite.json` variant of the same doc set was used to keep the nested option lists).
- **Oracle:** the machine's Node **v26.12.1** (`process.versions.sqlite` = **3.54.1**). Every
  "observed" line below was produced by running the code in this note, not inferred from prose.
- **Captured:** 2026-11-24.

Stability in the docs is **1.2, release candidate**. The module is available only under the
`node:` scheme; there is no `--experimental-sqlite` flag any more (that was removed in
v23.4.0/v22.13.0).

---

## 1. Module shape

```
require("node:sqlite") ->
  Database          class (v22.5.0; the only name before v24)
  DatabaseSync      deprecated alias, === Database (DEP0210)
  Statement         class
  StatementSync     deprecated alias, === Statement (DEP0211)
  Session           class (v23.3.0)
  constants         frozen enum object, 45 keys
  backup            async function (v23.8.0)
```

Observed on the oracle:

| expression | result |
|---|---|
| `Object.keys(require("node:sqlite"))` | `["Database","DatabaseSync","Statement","StatementSync","Session","constants","backup"]` |
| `DatabaseSync === Database` | `true` |
| `StatementSync === Statement` | `true` |
| `Database.name` / `Statement.name` / `Session.name` | `"Database"` / `"Statement"` / `"Session"` |
| `require("sqlite")` | `MODULE_NOT_FOUND` (not a builtin alias) |
| `module.builtinModules.includes("sqlite")` | `false` (node:-only modules are not listed) |
| `module.isBuiltin("sqlite")` / `("node:sqlite")` | `false` / `true` |
| `process.versions.sqlite` | `"3.54.1"` |

`Database.prototype`: `open`, `close`, `prepare`, `exec`, `function`, `createTagStore`, `location`,
`aggregate`, `createSession`, `applyChangeset`, `enableLoadExtension`, `enableDefensive`,
`loadExtension`, `serialize`, `deserialize`, `setAuthorizer`, `createModule`, `constructor`.

`Statement.prototype`: `iterate`, `all`, `get`, `run`, `columns`, `stat`, `resetStats`,
`setAllowBareNamedParameters`, `setAllowUnknownNamedParameters`, `setReadBigInts`,
`setReturnArrays`, `close`, `constructor`.

`Session.prototype`: `changeset`, `patchset`, `close`, `constructor`.

`Symbol.dispose` exists on both `Database` and `Statement` (and `Session`); for the Database and
Session it is a no-op when already closed, for a Statement it is a no-op when already finalized.

---

## 2. Type conversion

| storage class | JS to SQLite | SQLite to JS |
|---|---|---|
| `NULL` | `<null>` or `<undefined>` | `<null>` |
| `INTEGER` | `<number>`, `<bigint>`, `<boolean>` | `<number>` or `<bigint>` (when reading BigInts) |
| `REAL` | `<number>` | `<number>` |
| `TEXT` | `<string>` | `<string>` |
| `BLOB` | `<TypedArray>`, `<DataView>`, `<ArrayBuffer>`, `<SharedArrayBuffer>` | `<Uint8Array>` (not a Buffer) |

Details observed on the oracle:

- `true` binds as `INTEGER 1` (`typeof` in SQL is `integer`); it reads back as `1`, or as `1n`
  with BigInt reads enabled.
- A JS `number` binds as `REAL`, including an integral one: `SELECT typeof(?)` with `1` reports
  `real`. `INTEGER` storage comes from a `bigint`/`boolean` binding or from column affinity, not
  from the number's shape. `NaN` binds `NULL`; `Infinity` and `-0` bind as `REAL`.
- `undefined` binds as `NULL`. A **named** `{ $a: undefined }` is the same as omitting the key,
  because the named-parameter object is not "an anonymous value".
- A `<bigint>` outside signed 64-bit throws
  `TypeError [ERR_INVALID_ARG_VALUE]: BigInt value is too large to bind.`
- Reading an `INTEGER` outside `Number.MAX_SAFE_INTEGER` without BigInt reads throws
  `RangeError [ERR_OUT_OF_RANGE]: Value is too large to be represented as a JavaScript number: 9007199254740993`.
- BLOBs come back as `Uint8Array` with the exact byte length (`Buffer.isBuffer(...) === false`).
  Node writes the buffer's current contents at bind time (`SQLITE_TRANSIENT` semantics): detaching
  or mutating the JS buffer afterwards does not change what was stored.
- Unsupported JS values (a plain object, a function, a symbol) throw `ERR_INVALID_ARG_TYPE`.
  A plain object passed where an anonymous value is expected was observed to bind `NULL`, because
  Node treats a non-`undefined` object in first position as the *named-parameters* object and
  finds no matching parameter.

---

## 3. `Database`

### 3.1 `new Database(path[, options])`

`path`: `string | Buffer | URL`. A file path, `":memory:"`, or a `file:` URI (URI filenames are
enabled; observed `new Database("file:memdb1?mode=memory&cache=shared")` opening a named in-memory
database). `location()` for that database is `null`.

`options` (defaults as documented):

| option | type | default | effect |
|---|---|---|---|
| `open` | boolean | `true` | when `false`, open later with `open()` |
| `readOnly` | boolean | `false` | `SQLITE_OPEN_READONLY`; a missing file fails |
| `enableForeignKeyConstraints` | boolean | `true` | `PRAGMA foreign_keys` is on after open |
| `enableDoubleQuotedStringLiterals` | boolean | `false` | `SQLITE_DBCONFIG_DQS_DML`/`DDL` |
| `allowExtension` | boolean | `false` | enables `loadExtension()`/the SQL function |
| `timeout` | number | `0` | busy timeout, milliseconds |
| `readBigInts` | boolean | `false` | default for every statement prepared from this db |
| `returnArrays` | boolean | `false` | default result shape for statements from this db |
| `allowBareNamedParameters` | boolean | `true` | default for statements from this db |
| `allowUnknownNamedParameters` | boolean | `false` | default for statements from this db |
| `defensive` | boolean | `true` (v25.5.0+) | `SQLITE_DBCONFIG_DEFENSIVE` |
| `limits` | object | SQLite defaults | the 11 `sqlite3_limit` values, same names as `database.limits` |

Observed validation: a non-path throws
`TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be a string, Uint8Array, or URL without null bytes.`;
a non-boolean option throws
`TypeError [ERR_INVALID_ARG_TYPE]: The "options.readOnly" argument must be a boolean.`
Unknown option keys are ignored.

### 3.2 Methods

| method | returns | notes |
|---|---|---|
| `open()` | `undefined` | throws `ERR_INVALID_STATE` (`database is already open`) if open |
| `close()` | `undefined` | finalizes the connection's statements; later statement calls throw `statement has been finalized`; double close throws `ERR_INVALID_STATE` (`database is not open`) |
| `prepare(sql[, options])` | `Statement` | `options`: `readBigInts`, `returnArrays`, `allowBareNamedParameters`, `allowUnknownNamedParameters`, `persistent`; empty SQL throws `ERR_INVALID_ARG_VALUE` (`The SQL query contains no statements.`) |
| `exec(sql)` | `undefined` | runs every statement up to the first error; statements executed before the error stay applied |
| `function(name[, options], fn)` | `undefined` | scalar UDF; `options`: `deterministic`, `directOnly`, `useBigIntArguments`, `varargs` |
| `aggregate(name, options)` | `undefined` | `start`, `step`, `result`, `inverse`; `sqlite3_create_window_function` |
| `createTagStore([maxSize])` | `SQLTagStore` | default capacity 1000 |
| `location([dbName])` | `string \| null` | `sqlite3_db_filename`; `null` for in-memory; the observed path was the OS-resolved one (`/private/tmp/...` for `/tmp/...`) |
| `serialize([dbName])` | `Uint8Array` | `sqlite3_serialize`; observed to work for both in-memory and file databases |
| `deserialize(buffer[, options])` | `undefined` | `options`: `{ dbName }`; finalizes existing statements first, even on failure |
| `createSession([options])` | `Session` | `options`: `table`, `db` |
| `applyChangeset(changeset[, options])` | `boolean` | `filter(table)`, `onConflict(type)` |
| `setAuthorizer(callback \| null)` | `undefined` | callback `(action, arg1, arg2, dbName, triggerOrView)` returns `SQLITE_OK`/`DENY`/`IGNORE` |
| `enableDefensive(active)` | `undefined` | |
| `enableLoadExtension(allow)` | `undefined` | cannot enable when constructed with `allowExtension: false` |
| `loadExtension(path[, entryPoint])` | `undefined` | |
| `createModule(name, options)` | `undefined` | virtual table: `columns`, `rows`, `directOnly`, `useBigIntArguments` |
| `[Symbol.dispose]()` | `undefined` | closes; no-op when already closed |

### 3.3 Properties

| property | type | notes |
|---|---|---|
| `isOpen` | boolean | false after `close()` |
| `isTransaction` | boolean | `sqlite3_get_autocommit() === 0`; observed true between `BEGIN` and `COMMIT` |
| `limits` | object | 11 enumerable accessors: `length`, `sqlLength`, `column`, `exprDepth`, `compoundSelect`, `vdbeOp`, `functionArg`, `attach`, `likePatternLength`, `variableNumber`, `triggerDepth`; assigning `Infinity` resets to the compile-time maximum; a negative value throws `ERR_OUT_OF_RANGE` (`Limit value must be non-negative.`); an unknown property reads `undefined` |

---

## 4. `Statement`

Instances come only from `database.prepare()`. All methods are synchronous.

| member | notes |
|---|---|
| `run([named][, ...anonymous])` | `{ changes, lastInsertRowid }`; both are `number`, or `bigint` when `readBigInts` is on. On a `SELECT` SQLite reports `changes: 1` and the last rowid, matching Node. |
| `get(...)` | first row, or `undefined` |
| `all(...)` | array of rows (empty when none) |
| `iterate(...)` | iterable iterator; `next()` returns `{ done, value }`; `return()` drains it; running the same statement again while an iterator is live throws `ERR_INVALID_STATE` (`iterator was invalidated`) on the stale iterator's next call |
| `columns()` | array of `{ name, column, table, database, type }`; `column`/`table`/`database`/`type` are `null` for expressions (`NULL AS n`, `1 AS one`) |
| `close()` | finalizes; double close throws `ERR_INVALID_STATE` (`statement has been finalized`) |
| `[Symbol.dispose]()` | no-op when already finalized |
| `stat(counter)` | `sqlite3_stmt_status`; no reset. Valid names: `fullscanStep`, `sort`, `autoindex` (all lower case), `vmStep`, `reprepare`, `run`, `filterMiss`, `filterHit`, `memused`. `autoIndex` and `fullscanLookup` throw `ERR_INVALID_ARG_VALUE` (`The "counter" argument is not a valid statistic name.`) |
| `resetStats()` | zeroes every counter except `memused` |
| `setReadBigInts(enabled)` | `INTEGER` → `bigint` for reads and for `run()`'s two fields |
| `setReturnArrays(enabled)` | rows become arrays in column order |
| `setAllowBareNamedParameters(enabled)` | default `true`; with `false`, only prefixed keys bind |
| `setAllowUnknownNamedParameters(enabled)` | default `false`; otherwise unknown keys throw `ERR_INVALID_STATE` (`Unknown named parameter 'x'`) |
| `sourceSQL` | the SQL text used to prepare, including a trailing `;` when one was supplied |
| `expandedSQL` | the last execution's SQL with values substituted; before any execution it is the SQL with `NULL` substituted (`SELECT NULL AS x`); numbers print like SQLite does (`1.0`) |

### 4.1 Binding parameters

- Anonymous `?`: bound in order from the variadic arguments. `?NNN` sets a 1-based parameter index;
  mixing named and numbered is discouraged because they share the index space.
- Named `$name`, `:name`, `@name`: bound from the object in first position. A key may include the
  prefix (`{ ":a": 1 }`) or, with bare names enabled (default), omit it (`{ a: 1 }`).
- Ambiguous bare names (`$k` and `@k` in one statement) are an error.
- Never-bound parameters are `NULL`; `undefined` has the same effect.
- Unknown keys throw `ERR_INVALID_STATE` unless `setAllowUnknownNamedParameters(true)`.
- Extra anonymous arguments reach SQLite's binder and produce
  `ERR_SQLITE_ERROR`, `errcode: 25` (`column index out of range`).

---

## 5. `SQLTagStore`

`database.createTagStore([maxSize = 1000])` returns an LRU cache of prepared statements keyed by the
query text, including the placeholder positions:

```js
sql.run`INSERT INTO users VALUES (${id}, ${name})`;   // == prepare("INSERT INTO users VALUES (?, ?)").run(id, name)
```

- The same literal shape reuses one cached statement even when the interpolated values change;
  a different shape (literal value inline instead of `${}`) is a different key, and case matters.
- Members: `get`, `all`, `iterate`, `run` (template-tag methods), `clear()`, `size`, `capacity`,
  `db`.
- `size` counts cached statements (observed 1 after two executions of the same shape, 2 after an
  `INSERT` and a `SELECT`).

---

## 6. `Session` and changesets

`database.createSession({ table?, db? })` wraps `sqlite3session_create` + `sqlite3session_attach`.
A session records changes made after it is created:

```js
const session = sourceDb.createSession();
sourceDb.prepare("INSERT INTO data VALUES (?)").run(1);
const changeset = session.changeset();     // Uint8Array
targetDb.applyChangeset(changeset);        // true when applied without an abort
```

- `session.changeset()` / `session.patchset()` return `Uint8Array`, may be called repeatedly, and
  throw if the db or session is closed.
- `session.close()` frees the session; double close throws. `[Symbol.dispose]` is a no-op when
  already closed.
- `applyChangeset` returns `false` when a conflict handler aborted; `filter` can skip tables;
  `onConflict` receives one of `SQLITE_CHANGESET_*` and returns `SQLITE_CHANGESET_OMIT`,
  `REPLACE`, or `ABORT` (default `ABORT`).

---

## 7. `sqlite.backup(sourceDb, path[, options])`

Async function wrapping `sqlite3_backup_init`/`_step`/`_finish`; returns a **Promise**.

| option | default | meaning |
|---|---|---|
| `source` | `"main"` | source database name |
| `target` | `"main"` | target database name |
| `rate` | `100` | pages per step |
| `progress` | — | `({ totalPages, remainingPages }) => void` after each step |

Observed with a 2-page in-memory database and `rate: 1`: `progress` was called once with
`{ totalPages: 2, remainingPages: 1 }` and the promise resolved to `2` (pages transferred).

---

## 8. `constants`

45 keys, observed values:

```json
{"SQLITE_CHANGESET_OMIT":0,"SQLITE_CHANGESET_REPLACE":1,"SQLITE_CHANGESET_ABORT":2,
 "SQLITE_CHANGESET_DATA":1,"SQLITE_CHANGESET_NOTFOUND":2,"SQLITE_CHANGESET_CONFLICT":3,
 "SQLITE_CHANGESET_CONSTRAINT":4,"SQLITE_CHANGESET_FOREIGN_KEY":5,
 "SQLITE_OK":0,"SQLITE_DENY":1,"SQLITE_IGNORE":2,
 "SQLITE_CREATE_INDEX":1,"SQLITE_CREATE_TABLE":2,"SQLITE_CREATE_TEMP_INDEX":3,
 "SQLITE_CREATE_TEMP_TABLE":4,"SQLITE_CREATE_TEMP_TRIGGER":5,"SQLITE_CREATE_TEMP_VIEW":6,
 "SQLITE_CREATE_TRIGGER":7,"SQLITE_CREATE_VIEW":8,"SQLITE_DELETE":9,"SQLITE_DROP_INDEX":10,
 "SQLITE_DROP_TABLE":11,"SQLITE_DROP_TEMP_INDEX":12,"SQLITE_DROP_TEMP_TABLE":13,
 "SQLITE_DROP_TEMP_TRIGGER":14,"SQLITE_DROP_TEMP_VIEW":15,"SQLITE_DROP_TRIGGER":16,
 "SQLITE_DROP_VIEW":17,"SQLITE_INSERT":18,"SQLITE_PRAGMA":19,"SQLITE_READ":20,
 "SQLITE_SELECT":21,"SQLITE_TRANSACTION":22,"SQLITE_UPDATE":23,"SQLITE_ATTACH":24,
 "SQLITE_DETACH":25,"SQLITE_ALTER_TABLE":26,"SQLITE_REINDEX":27,"SQLITE_ANALYZE":28,
 "SQLITE_CREATE_VTABLE":29,"SQLITE_DROP_VTABLE":30,"SQLITE_FUNCTION":31,
 "SQLITE_SAVEPOINT":32,"SQLITE_COPY":0,"SQLITE_RECURSIVE":33}
```

Note the two overlapping sets: `SQLITE_CHANGESET_REPLACE` and `SQLITE_CHANGESET_DATA` are both `1`,
and `SQLITE_CHANGESET_ABORT` / `SQLITE_CHANGESET_NOTFOUND` are both `2`; they are different enums
that happen to share values.

---

## 9. Error shapes

| situation | observed error |
|---|---|
| bad SQL in `prepare`/`exec` | `Error`, `code: "ERR_SQLITE_ERROR"`, `errcode: 1`, `errstr: "SQL logic error"`, `message: near "FROM": syntax error` |
| read-only database that does not exist | `Error`, `code: "ERR_SQLITE_ERROR"`, `errcode: 14`, `errstr: "unable to open database file"`, same message |
| `database is not open` (use/close of a closed db, `prepare` on an unopened one) | `ERR_INVALID_STATE` |
| `statement has been finalized` | `ERR_INVALID_STATE` |
| `Unknown named parameter 'x'` | `ERR_INVALID_STATE` |
| `iterator was invalidated` | `ERR_INVALID_STATE` |
| argument type, e.g. `new Database(42)`, non-boolean option | `ERR_INVALID_ARG_TYPE` (`TypeError`) |
| empty SQL | `ERR_INVALID_ARG_VALUE` (`TypeError`) |
| BigInt out of range, integer read out of safe range, negative `limits` value | `ERR_OUT_OF_RANGE` (`RangeError`) |

SQLite errors are plain `Error` objects with `errcode` (the primary result code) and `errstr`
(`sqlite3_errstr`) in addition to `code`; the `message` is `sqlite3_errmsg`.

---

## 10. Oracle observations that are easy to miss

| observation | result on the oracle |
|---|---|
| row/`run()`/`columns()` objects | **null-prototype** (`Object.getPrototypeOf(row) === null`), keys in column order; `console.log` prints them as `[Object: null prototype] { … }` |
| `prepare("SELECT 1 AS one; SELECT 2 AS two").all()` | `[{ one: 1 }]` — only the first statement is compiled |
| `prepare("SELECT 1;")` `.sourceSQL` | includes the trailing `;` |
| `exec` with a failure in the middle | earlier statements remain applied (no implicit transaction) |
| `db.close()` with live statements | succeeds; the statements are finalized; later calls on them throw `statement has been finalized` |
| closing a db while an iterator is live | succeeds |
| re-running a statement while its iterator is live | the iterator's next call throws `iterator was invalidated` |
| `statement.close()` during its own iteration | succeeds (the statement is finalized) |
| `columns()` on expressions | metadata fields are `null`, `name` is the alias |
| `get()` on a query with no rows | `undefined` |
| `all()` on a non-SELECT | `[]` |
| `run()` on a SELECT | `{ changes: 1, lastInsertRowid: <last id> }` |
| `undefined` in an anonymous slot | bound as `NULL` |
| first argument is a non-null object | always the named-parameter map, arrays included; an object against an anonymous-only statement throws `ERR_INVALID_STATE: Unknown named parameter 'a'` |
| positional arguments against `:a`/`$a`/`@a` slots | never bound positionally: `SELECT :a` with `.get(7)` throws `ERR_SQLITE_ERROR`, errcode 25; `SELECT :a, ?` binds only the `?` |
| `?` mixed with `:a` | positional arguments bind the `?` slots in SQL index order, whatever the named parameters' indices are |
| `NaN`/`Infinity` bound to a REAL | SQLite stores `NULL` for `NaN`; `Infinity` is REAL |
| foreign keys after construction | on by default (`PRAGMA foreign_keys` = 1) |
| `SELECT "abc"` with defaults | `ERR_SQLITE_ERROR`, `no such column: "abc" - should this be a string literal in single-quotes?` (double-quoted string literals off) |
| `location()` on a file db | the OS-resolved absolute path |
| `serialize()` on a file db | works (8192 bytes for one table) |
| `database.limits.length` default | `1000000000` (SQLite's compile-time default) |
| `sqlite.backup` | returns a `Promise`; `progress` gets `{ totalPages, remainingPages }` |
| implicit statement finalization on GC | **not observed here**; Node's bindings finalize on close. onde will not rely on GC finalizers (see the plan) |

---

## 11. Version notes that matter for onde

- Node's docs claim `process.version` compatibility; onde advertises Node **v22.14.0** in
  `process.version`. In v22.14 the module exported only `DatabaseSync` and `StatementSync`, and
  `serialize`, `deserialize`, `limits`, `setAuthorizer`, `createModule`, `backup` and the
  `Database`/`Statement` names did not exist. onde will ship the **v26 surface plus the two
  aliases**, which is a superset of both, and record that in `docs/compat.md`.
- The oracle bundles SQLite **3.54.1**. Any bundled build must record its own
  `sqlite3_libversion()` and not assume 3.54 behaviour; `filterMiss`/`filterHit` need 3.38+,
  `deterministic` needs 3.8.3+, `defensive` needs 3.26+.
- The docs mention `diagnostics_channel` `'sqlite.db.query'` events. onde does not implement
  `diagnostics_channel`; that is out of scope for this module and recorded as a divergence.

## 12. Not captured here

- The exact SQLite build flags Node uses (`SQLITE_ENABLE_SESSION`, FTS5, RBU, …): the plan chooses
  its own flags; behaviour that depends on an extension module is out of scope.
- The `EventEmitter`/tracing integration and the `sqlite.db.query` payload.
- `createModule`'s virtual-table call protocol beyond the documented shape.
