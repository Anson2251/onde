# `node:sqlite` — implementation plan

This is the working contract for `node:sqlite`: where the code lives, what the host boundary is,
what the JavaScript surface promises, and what is deliberately left out. It follows the split
`node:zlib` uses — an engine-free crate, a host primitive file, and a JS module — with one
difference: SQLite is a stateful C library, so the host boundary is handle-based instead of one
function per operation.

Status: **implemented, 2026-11-24.** WP0–WP7 landed: `crates/ln-sqlite`, the
`__ln_host.sqlite` facade, `js/lib/sqlite.js`, the `node-sqlite` feature (default on, one-line off),
thirteen Node-recorded conformance cases, `test/js/lib/sqlite.test.js` and the docs. WP5
(`function`, `aggregate`, `setAuthorizer`), WP6 (`Session`/changesets, `createModule` virtual
tables, `loadExtension`) are in; the only Node surface left out is `diagnostics_channel`'s
`'sqlite.db.query'` events, which onde does not implement. This was a standalone work package, not
a renumbered milestone: the zlib module landed the same way after the M4 contract had frozen
([m4-plan.md](m4-plan.md) §9.1).

Sources: [research/node-sqlite-api.md](research/node-sqlite-api.md) is the API capture — Node
v26.13.1 documentation, Node v26.12.1 oracle, SQLite 3.54.1. Where this document and the code
disagree later, this document is the intent and the code is the truth; update both together.

---

## 1. What ships, in one table

| area | shipped | not shipped |
|---|---|---|
| `Database` | open/close/exec/prepare/location/isOpen/isTransaction/limits/serialize/deserialize/enableDefensive, `function`, `aggregate`, `setAuthorizer`, `createSession`/`applyChangeset`, `loadExtension`/`enableLoadExtension`, `createModule`, `[Symbol.dispose]` | async database; `backup` to a live connection object (only to a path) |
| `Statement` | run/get/all/iterate/columns/stat/resetStats/set*(…)/sourceSQL/expandedSQL/close/`[Symbol.dispose]` | — |
| Binder | anonymous `?`, `?NNN`, named `$`/`:`/`@`, bare names, unknown-name policy, all six value types | — |
| Other exports | `DatabaseSync`/`StatementSync` aliases, `Session`, `SQLTagStore`, `constants` (45 values), `backup()` | `diagnostics_channel` `'sqlite.db.query'` events, VFS hooks |
| Platform | macOS and Linux, the two CI targets | Windows (untested, expected to work through `cc`), musl-static (untested) |

Every shipped row has a corpus case or a stdlib test behind it; the one documented gap is the
`diagnostics_channel` trace event.

---

## 2. Crate graph changes

### 2.1 A new engine-free crate

```
crates/ln-sqlite/          SQLite wrapper: connections, statements, values, sessions,
                           engine-free and tokio-free (like ln-zlib/ln-crypto)
crates/ln-runtime/src/host/sqlite.rs
                           the `__ln_host.sqlite` facade: id registries, value conversion,
                           error mapping; owns no SQLite code
js/lib/sqlite.js           the Node surface: classes, validation, result shaping
```

`ln-sqlite` is a workspace member and is listed in `crates/ln-runtime/Cargo.toml`. The crate is
engine-free for the same reason `ln-zlib` is: the whole API can be tested with `cargo test -p
ln-sqlite`, with no QuickJS in the loop.

### 2.2 Dependency choice

| option | verdict |
|---|---|
| **`rusqlite` + bundled SQLite** | **chosen.** Maintained bindings, MIT, pinned `libsqlite3-sys` 0.38.2 with SQLite 3.53.2 compiled by `cc` in the crate — no system SQLite, no new toolchain (quickjs already builds C). Features give `session`, `backup`, `serialize`, `limits`, `column_metadata`, `functions`, `vtab`, `window`, `load_extension`. |
| raw `libsqlite3-sys` only | rejected as the base: it would hand-write `open`/`exec`/`backup`/`session`/`serialize` wrappers that rusqlite already tests. Still used directly for statements (§2.3). |
| system `libsqlite3` | rejected: Apple's and glibc distros' versions differ, the feature set differs (`session` is often compiled out), and the project's promise is one self-contained binary. |
| pure-Rust SQLite (`limbo`/`sqlite3-parser`) | rejected: not the same engine, not compatible with real database files, and the module's value is fidelity. |

Version policy: pin `rusqlite = "=0.40.2"` (it pairs with `libsqlite3-sys` 0.38.2; both are in the
local cargo cache). `rusqlite` states no `rust-version` and its README says the MSRV is "latest
stable at the time of release", so the workspace's old 1.80 floor was never a tested claim; the
floor is raised to **1.89** (the current rusqlite generation's minimum) rather than pinning an
older `rusqlite` or shipping a false MSRV. The bundled SQLite is **3.53.2**, one minor
release behind the Node 26.12.1 oracle (3.54.1); the plan's conformance rules (§7.5) never assert
version-specific behaviour, and `process.versions.sqlite` reports the runtime's real version.

`deny.toml` needs no change: `rusqlite` and `libsqlite3-sys` are MIT, the SQLite amalgamation is
public domain, and the existing allow-list already covers MIT. `cargo deny check` is part of the
WP's exit check, including the advisories pass (the bundled C code is not covered by RustSec; the
crate pin is the update channel and the plan records that).

### 2.3 Why statements are not `rusqlite::Statement`

`Statement<'conn>` borrows its `Connection`. onde needs a registry that owns both and hands out
stable integer ids, and `rusqlite` exposes no way to store a statement beside its connection
without erasing the lifetime. The plan uses `rusqlite` for the connection and for
open/config/exec/backup/session/serialize, and calls `rusqlite::ffi` directly for the statement
layer (`sqlite3_prepare_v3`, `_bind_*`, `_step`, `_column_*`, `_reset`, `_finalize`,
`_stmt_status`, `_expanded_sql`, `_sql`). This is the same class of unsafe the project already
contains in `ln-engine` and `vendor/`: pointer validity is an invariant of one module, documented
at the call site, and every public method of `ln-sqlite` is safe.

The alternative — `mem::transmute` of `Statement<'conn>` to `'static` with a registry that
finalizes before dropping the connection — was rejected: it turns an ownership bug into UB while
looking like safe code, and the raw calls are about 250 lines.

### 2.4 Feature wiring and size

**Decided (2026-11-24):** both modules are **default features**, named for what they enable —
`node-sqlite` and `node-zlib` — not for the library underneath. `ln-runtime`:

```toml
[features]
default = ["node-sqlite", "node-zlib"]
node-sqlite = ["dep:ln-sqlite"]
node-zlib = []
```

`ln-cli` and `ln-embed` mirror them (`node-sqlite = ["ln-runtime/node-sqlite"]`,
`node-zlib = ["ln-runtime/node-zlib"]`); `ln-cli` and `ln-embed` no longer take `ln-runtime`'s
defaults, so the SDK keeps both unless a caller asks otherwise. Turning `node-sqlite` off drops
the bundled SQLite. `node-zlib` only removes the module surface: `ln-zlib` (and flate2 under it)
is a transitive dependency of the payload decoder, so it stays linked whether or not the feature
is on, and a `--no-default-features` build still inflates `--compress zlib` payloads.

A module that a build leaves out must read as a build choice, not a typo. `modules::
builtin_unavailable_message` produces the same text for CommonJS and ESM:

> `node:sqlite` is not available: the `node-sqlite` feature is not enabled in this build. Rebuild
> without `--no-default-features` (or with `--features node-sqlite`) to include it.

The error code stays Node's `ERR_UNKNOWN_BUILTIN_MODULE`, and `builtinModules`/`isBuiltin` do not
advertise a module that cannot load (the default-on build advertises `node:zlib` in
`builtinModules`, `node:sqlite` only through `isBuiltin("node:sqlite")`, matching Node's node:-only
rule).

Size, measured 2026-11-24 (release, macOS arm64, no strip): **5,496,752 bytes with neither
module feature**, **7,595,296 with `node-sqlite` only**, **5,534,352 with `node-zlib` only**, and
**7,648,576 with both**. The `node-sqlite` delta (~2.0 MB) is the bundled SQLite; the `node-zlib`
delta (~38 KB) is the embedded module and host binding, because the inflater is already linked
through the payload decoder. The sqlite delta (+2.15 MB, +39%) is above the plan's original 1.5 MB
target and is recorded rather than hidden; the features are the documented opt-out. An `ondec` hello-world link measured 6,892,976 bytes with SQLite (6.6 MiB) and 4,627,480
bytes with a slim archive (4.4 MiB).

## 3. The host boundary

### 3.1 Handles, not JS values in Rust

`zlib` passes whole buffers through a stateless function. SQLite is a graph of live objects, so the
host keeps two registries per isolate:

```rust
pub(crate) struct SqliteState {
    connections: RefCell<Slab<ConnectionEntry>>,  // id -> connection + its statements
    statements:  RefCell<Slab<StmtEntry>>,        // id -> (connection id, raw stmt, generation)
    next_id:     Cell<u32>,
}
```

- A `Database` JS object holds `#handle: number`; a `Statement` holds `#handle` and its `#db`.
- Ids are per isolate, never reused within an isolate (a stale id fails loudly).
- Nothing in the registry is reachable from another isolate or thread.
- `Connection` must outlive its statements; the registry enforces it (§3.6) and `ln-sqlite` keeps
  the pointer validity invariant private.

### 3.2 `ln-sqlite` public sketch

```rust
pub struct Database { /* rusqlite::Connection + statement slots */ }

impl Database {
    pub fn open(path: &Path, options: &OpenOptions) -> Result<Self, Error>;
    pub fn exec(&self, sql: &str) -> Result<(), Error>;
    pub fn prepare(&mut self, sql: &str, persistent: bool) -> Result<StmtId, Error>;
    pub fn finalize(&mut self, id: StmtId) -> Result<(), Error>;
    pub fn bind(&mut self, id: StmtId, params: &Params) -> Result<(), Error>;
    pub fn run(&mut self, id: StmtId, big_ints: bool) -> Result<RunResult, Error>;
    pub fn query(&mut self, id: StmtId, big_ints: bool) -> Result<Vec<Vec<Value>>, Error>;
    pub fn first(&mut self, id: StmtId, big_ints: bool) -> Result<Option<Vec<Value>>, Error>;
    pub fn begin(&mut self, id: StmtId, big_ints: bool) -> Result<(Generation, Option<Vec<Value>>), Error>;
    pub fn next(&mut self, id: StmtId, generation: Generation, big_ints: bool) -> Result<Option<Vec<Value>>, Error>;
    pub fn finish(&mut self, id: StmtId, generation: Generation) -> Result<(), Error>;
    pub fn columns(&self, id: StmtId) -> Result<Vec<Column>, Error>;
    pub fn stat(&self, id: StmtId, counter: Stat) -> Result<i64, Error>;
    pub fn reset_stats(&mut self, id: StmtId) -> Result<(), Error>;
    pub fn source_sql(&self, id: StmtId) -> Result<String, Error>;
    pub fn expanded_sql(&self, id: StmtId) -> Result<String, Error>;
    pub fn limit(&self, limit: Limit) -> i32;
    pub fn set_limit(&mut self, limit: Limit, value: i32) -> Result<i32, Error>;
    pub fn is_transaction(&self) -> bool;
    pub fn location(&self, db: &str) -> Option<String>;
    pub fn serialize(&self, db: &str) -> Result<Vec<u8>, Error>;
    pub fn deserialize(&mut self, db: &str, bytes: Vec<u8>) -> Result<(), Error>;
    ...
}
```

`Value` is a five-arm enum (`Null`, `Integer(i64)`, `Real(f64)`, `Text(String)`, `Blob(Vec<u8>)`).
`Params` carries an optional named map and an ordered anonymous list, already converted from JS by
the host.

### 3.3 Primitive list (`__ln_host.sqlite`)

All synchronous. Every function validates its own arguments, as `host/zlib.rs` does; the JS layer
validates the Node-shaped surface on top.

| primitive | signature | notes |
|---|---|---|
| `open` | `(path, options) => id` | flags, busy timeout, FK/DQS/defensive config, limits |
| `close` | `(id) => undefined` | finalizes every statement of that connection first |
| `exec` | `(id, sql) => undefined` | `sqlite3_exec` |
| `prepare` | `(id, sql, persistent) => stmtId` | first statement only; empty SQL is `ERR_INVALID_ARG_VALUE` |
| `finalize` | `(stmtId) => undefined` | idempotent only through the JS `[Symbol.dispose]`; direct double finalize is a state error |
| `bind` | `(stmtId, named, anonymous, allowBare, allowUnknown) => undefined` | clears previous bindings first |
| `run` | `(stmtId, bigInts) => { changes, lastInsertRowid }` | both `number` or `bigint` |
| `all` | `(stmtId, bigInts) => Array<Array<value>>` | one crossing, rows as value arrays |
| `first` | `(stmtId, bigInts) => Array<value> \| null` | steps once |
| `begin` | `(stmtId, bigInts) => { generation, row }` | first step of an iterator |
| `next` | `(stmtId, generation, bigInts) => Array<value> \| null` | stale generation → `ERR_INVALID_STATE` |
| `finish` | `(stmtId, generation) => undefined` | resets only when the generation matches |
| `columns` | `(stmtId) => Array<{name,column,table,database,type}>` | metadata calls; `null`s for expressions |
| `stat` | `(stmtId, name) => number` | name validated in Rust |
| `resetStats` | `(stmtId) => undefined` | |
| `sourceSQL` / `expandedSQL` | `(stmtId) => string` | `sqlite3_sql` / `sqlite3_expanded_sql` |
| `isOpen` | `(id) => boolean` | |
| `isTransaction` | `(id) => boolean` | |
| `location` | `(id, dbName) => string \| null` | |
| `serialize` | `(id, dbName) => Uint8Array` | copy out of SQLite's buffer |
| `deserialize` | `(id, dbName, bytes) => undefined` | finalizes statements first |
| `limit` / `setLimit` | `(id, name[, value]) => number` | `Infinity` sentinel handled in JS |
| `busyTimeout` | `(id, ms) => undefined` | |
| `enableDefensive` | `(id, active) => undefined` | |
| `backupInit` / `backupStep` / `backupFinish` | see §4.5 | the async loop lives in JS |
| `version` | `() => string` | `sqlite3_libversion()`, for `process.versions.sqlite` |

The re-entrant primitives (`createFunction`, `createAggregate`, `setAuthorizer`) and the
session/extension ones (`createSession`, `sessionChangeset`, `sessionPatchset`, `sessionClose`,
`applyChangeset`, `createModule`, `enableLoadExtension`, `loadExtension`) are installed on the same
host object; §3.7 and §4 describe them.

### 3.4 Values

Conversion happens in Rust, once, because that is where `i64`/`f64` and byte copies are cheap and
where the error messages can be exact:

| JS value | binding |
|---|---|
| `null`, `undefined` | `NULL` |
| `number` | `REAL` always (`sqlite3_bind_double`), even for an integral value; `NaN` → `NULL`; `±Infinity` and `-0` are `REAL`. Column affinity, not the binder, decides whether an `INTEGER` column stores it as `INTEGER`. |
| `bigint` | `INTEGER`; out of `i64` → `ERR_INVALID_ARG_VALUE` (`BigInt value is too large to bind.`) |
| `boolean` | `INTEGER 1`/`0` |
| `string` | `TEXT`, UTF-8 (a string with unpaired surrogates follows `args::string`'s rule) |
| `Uint8Array`/other `TypedArray`/`DataView`/`ArrayBuffer`/`SharedArrayBuffer` | `BLOB`, copied with `SQLITE_TRANSIENT` |

Reading: `INTEGER` → `number` (or `bigint` when the statement/database asks for BigInts);
out-of-safe-range without BigInts → `ERR_OUT_OF_RANGE` (`Value is too large to be represented as
a JavaScript number: …`); `REAL` → `number`; `TEXT` → `string`; `BLOB` → a fresh `Uint8Array` (not
a `Buffer`, matching Node); `NULL` → `null`.

The byte-source normalisation for `SharedArrayBuffer` and non-`u8` typed arrays happens in
`js/lib/sqlite.js` (build a `Uint8Array` view over the same bytes) so the Rust side only has to
accept a `Uint8Array` or `ArrayBuffer`; the binding copies immediately, so no JS value outlives the
call.

### 3.5 Errors

Two families, both already tested elsewhere in the runtime:

- **SQLite results** become `Error` with `code: "ERR_SQLITE_ERROR"`, `errcode` (primary result
  code), `errstr` (`sqlite3_errstr`) and `message` (`sqlite3_errmsg`). The host builds this object
  directly instead of going through `NodeError`, which has no `errcode` slot; `host_error.rs` gains
  one small helper, `error_object_with(ctx, name, code, message, extras)`.
- **State and arguments** reuse `NodeError`/`internal/errors.js`: `ERR_INVALID_STATE`
  (`database is not open`, `statement has been finalized`, `iterator was invalidated`,
  `Unknown named parameter 'x'`), `ERR_INVALID_ARG_TYPE`, `ERR_INVALID_ARG_VALUE`,
  `ERR_OUT_OF_RANGE`.

The exact strings are pinned in `test/js/lib/sqlite.test.js`; the conformance corpus prints codes
and `errcode` only, so a message-level improvement does not break the corpus.

### 3.6 Lifetime and teardown

- No GC finalization. QuickJS 0.17 does not deliver `FinalizationRegistry` cleanup callbacks
  reliably (compat.md §1), and a file descriptor closed by a GC rumour is worse than a documented
  leak. `db.close()` and `statement.close()` are explicit, and `[Symbol.dispose]` is the
  `using`-friendly spelling. Nodes that are never closed are closed when the isolate tears down:
  `HostState` drops `SqliteState`, whose `Drop` finalizes every statement and closes every
  connection, statements first.
- `database.close()` finalizes the connection's statements (matching the oracle) and removes them
  from the registry; their JS objects keep their ids and every later call throws
  `statement has been finalized`.
- `serialize`/`deserialize` copy bytes; no SQLite-owned pointer escapes the call.
- A statement that is mid-iteration is reset by `close()`/`db.close()`; the JS iterator's next call
  sees a dead id and throws `ERR_INVALID_STATE`. Re-running a statement increments its generation,
  which is what makes a live iterator throw `iterator was invalidated` (the oracle's behaviour).

### 3.7 Re-entrant callbacks

Scalar functions, aggregates, the authorizer and changeset handlers are where SQLite calls back
into JavaScript while a host primitive is on the stack. The implementation is split in two:

* `ln-sqlite/src/function.rs`, `session.rs` and `vtab.rs` own the C trampolines and user-data
  blocks. They call engine-free traits (`ScalarFunction`, `AggregateFunction`, `Authorizer`,
  `VirtualTableModule`, `ChangesetHandler`) and catch panics before they can unwind through C.
* `host/sqlite/callbacks.rs` implements those traits over `Persistent<Function>` values. A host
  call that can execute SQL sets a thread-local `*mut JSContext` (`CallbackScope`); the trait
  implementation rebuilds a `Ctx` with `Ctx::from_raw`, restores the persistent and calls it. A
  JavaScript exception stays pending and the host primitive returns `js::Error::Exception`, so
  user code sees its own error rather than a synthetic `ERR_SQLITE_ERROR`. A JavaScript value
  SQLite cannot store (a boolean return, an object) is a coded `ERR_SQLITE_ERROR`.

Invariants, held by construction and exercised by the tests: the pointer is set only on the
isolate thread and only while a host primitive is active (nested calls restore the previous
value); no callback outlives the host call; every `Persistent` lives in SQLite's user data and is
released by `xDestroy` when the connection closes, which `SqliteState::shutdown` does before the
engine is dropped; aggregate state handles are dropped on `xFinal` and on a failing step/inverse;
a panic becomes a callback error, never unwinding through C.

`createModule` materializes the JavaScript `rows()` iterable in `xFilter` through `Array.from`, so
no JavaScript runs during `xNext`/`xColumn`; the cursor is plain Rust data.

---

## 4. The JavaScript surface

### 4.1 Layout

`js/lib/sqlite.js` is one file, like `js/lib/zlib.js`, with a private host accessor:

```js
function hostSqlite() {
  const host = globalThis.__ln_host;
  const sqlite = host === undefined || host === null ? undefined : host.sqlite;
  if (sqlite === undefined || sqlite === null) {
    throw new Error("sqlite is unavailable: __ln_host.sqlite is not installed");
  }
  return sqlite;
}
```

It requires `./internal/errors.js` for the coded-error vocabulary and `./internal/bytes.js` for the
byte-source check. It does **not** require `node:sqlite`, so the file can be loaded under Node for
the host-shim path (WP4 stretch) without recursion.

Exports:

```js
module.exports = {
  Database, DatabaseSync: Database,
  Statement, StatementSync: Statement,
  constants, backup,
  // Session is exported alongside the others.
};
```

### 4.2 `Database`

- Constructor: validate `path` (string, or `Buffer`/`Uint8Array`, or `URL` → `fileURLToPath`, no
  `\0`), validate every option, then `host.open` unless `open: false`.
- Getters: `isOpen` (JS flag, backed by the host), `isTransaction` (host), `limits` (a plain object
  with 11 enumerable accessors that call `host.limit`/`host.setLimit`; `Infinity` resets).
- `prepare` returns a `Statement` bound to this database; `exec` is a straight host call.
- `close()`/`[Symbol.dispose]()`; double close is `ERR_INVALID_STATE` for `close()`, a no-op for
  dispose.
- `serialize`/`deserialize`, `location`, `enableDefensive` as one-liners over the host.
- The class is named `Database` and the alias is the same constructor object, so
  `DatabaseSync === Database` (the oracle's shape).

Statement options inheritance: the database stores the four `readBigInts`/`returnArrays`/
`allowBareNamedParameters`/`allowUnknownNamedParameters` defaults and every statement copies them
at prepare time; `prepare(sql, options)` overrides per statement. Statement setters flip only that
statement's flags.

### 4.3 `Statement`

- Flags: `readBigInts`, `returnArrays`, `allowBareNamedParameters`, `allowUnknownNamedParameters`.
- `run(...args)`:
  1. split `named`/`anonymous`: a non-null object in first position is the named-parameter map
     (arrays included); any other value — `null` and `undefined` included — is positional;
  2. `host.bind` then `host.run`;
  3. return a **null-prototype** `{ changes, lastInsertRowid }`.
- `all(...)` → `host.all` (value arrays) → shape rows with the cached column names.
- `get(...)` → `host.first` → one row or `undefined`.
- `iterate(...)` → `host.begin`; the returned iterator holds `{ stmtId, generation }`; `next()`
  calls `host.next`, `return()` calls `host.finish` and is a no-op when the generation is stale.
- `columns()` → host metadata, shaped into null-prototype `{ column, database, name, table, type }`
  objects. Node's key order is `column, database, name, table, type`; match it.
- `sourceSQL`/`expandedSQL` are prototype getters.
- Row shaping: `Object.create(null)`, assigned in column order; duplicate column names follow
  SQLite's order, last write wins (Node assigns the same way).
- `stat(name)` validates the nine names; `resetStats()` calls the host.

### 4.4 `SQLTagStore`

A JavaScript LRU over `Statement` objects, not a host structure:

```js
class SQLTagStore {
  #db; #capacity; #map = new Map();   // Map keeps insertion order; re-insert on hit
  get(strings, ...values) { … }
  all/iterate/run similarly
  clear() { for (const stmt of this.#map.values()) stmt.close(); this.#map.clear(); }
  get size() { return this.#map.size; }
  get capacity() { return this.#capacity; }
  get db() { return this.#db; }
}
```

The cache key is the template's `strings.join("\u0000")` — the same literal text and placeholder
positions, case-sensitive. On eviction the statement is closed. `get`/`all`/`run`/`iterate` build
the SQL by joining `strings` with `?` and pass `values` as anonymous parameters (the documented
tag-store contract).

### 4.5 `backup`

The async part is the loop, not a thread:

```js
async function backup(sourceDb, path, options = {}) {
  // validate sourceDb/instance, path, rate/progress
  const handle = host.backupInit(sourceId, path, options.source ?? "main", options.target ?? "main");
  try {
    for (;;) {
      const { done, totalPages, remainingPages } = host.backupStep(handle, rate);
      if (progress !== undefined) progress({ totalPages, remainingPages });
      if (done) return totalPages;
      await new Promise((resolve) => setImmediate(resolve));  // let the loop breathe
    }
  } finally {
    host.backupFinish(handle);
  }
}
```

`backupFinish` destroys the `sqlite3_backup` object and returns the page count; the JS loop owns
the promise. A synchronous `backupStep` per turn keeps the connection on the isolate thread
(SQLite objects must not move threads) while still allowing timers and I/O to run between batches —
a smaller divergence than "do it all inline", and one the docs can state precisely.

### 4.6 `constants`, aliases, and `node:`-only

- `constants` is a plain object with the 45 values from the research note; not frozen (the oracle's
  is not frozen either).
- `DatabaseSync`/`StatementSync` are the same constructor objects as `Database`/`Statement`.
- `node:sqlite` is available **only** with the `node:` prefix, like Node. This needs a small
  resolver/loader change:
  - `ln-modules/src/builtin.rs`: a `NODE_ONLY: &[&str] = &["sqlite"]`; `lookup("sqlite")` returns
    `None`, `lookup("node:sqlite")` returns `Some("sqlite")`.
  - `js/lib/loader.js`: `isBuiltin("sqlite")` is `false`, `isBuiltin("node:sqlite")` is `true`;
    `builtinNames()` filters node-only names so `Module.builtinModules` matches Node.
  - `resolve.rs` already branches on `is_node_prefixed` first, so no change there.
  - `require("sqlite")` then falls through to `node_modules` and ends as `MODULE_NOT_FOUND`, as in
    Node. (`test` stays onde's existing recorded divergence; this plan does not sweep it.)

### 4.7 `process.versions.sqlite`

`js/lib/process.js` adds `sqlite: host.sqlite.version()` to `process.versions` (the host reads
`sqlite3_libversion()`), matching Node's field. The value is the runtime's SQLite, not Node's
3.54.1; a conformance case may print the key's presence, never its value.

---

## 5. Semantics that are easy to get wrong

| # | rule (from the oracle) | where it is pinned |
|---|---|---|
| S1 | Rows, `run()` results and `columns()` entries are **null-prototype** objects, in column/key order | `sqlite01`, `sqlite02`, js test |
| S2 | Bindings are cleared before every execution; `expandedSQL` reflects the last execution's values (`NULL` for unbound), not the previous call's | `sqlite02`, `sqlite03` |
| S3 | `undefined` binds `NULL`; a named key with `undefined` is an omitted key, not a NULL | `sqlite02` |
| S4 | A JS `number` binds as `REAL` even when integral (`typeof(?)` is `real` for `1`); `INTEGER` comes from `bigint`/`boolean` or from column affinity. Booleans bind `1`/`0` and read back as numbers/bigints, never booleans. | `sqlite02` |
| S5 | BLOBs read back as `Uint8Array`, never `Buffer`; binding copies the bytes | `sqlite02` |
| S6 | BigInt out of range and out-of-safe-range integer reads are `ERR_OUT_OF_RANGE`/`ERR_INVALID_ARG_VALUE` with Node's messages | `sqlite02` |
| S7 | Bare named parameters are on by default; disabling them requires the prefix; an ambiguous `$k`/`@k` pair makes a bare name unbindable | `sqlite03` |
| S8 | Unknown named keys throw `ERR_INVALID_STATE` unless allowed; extra anonymous args reach SQLite and fail with `errcode: 25` | `sqlite03` |
| S9 | Positional arguments bind the `?`/`?NNN` slots in index order (`SELECT ?2, ?1` maps argument 1 to `?1`); `:a`/`$a`/`@a` slots are never bound positionally, and an argument with no slot left is `ERR_SQLITE_ERROR` (errcode 25) | `sqlite03` |
| S10 | `prepare` compiles only the first statement (`sourceSQL` includes a trailing `;`); `exec` runs all of them and leaves earlier work applied when a later one fails | `sqlite01`, `sqlite04` |
| S11 | `run()` on a `SELECT` returns `changes: 1` and the statement's last rowid | `sqlite01` |
| S12 | `get()` on no rows is `undefined`; `all()` on a non-SELECT is `[]` | `sqlite01` |
| S13 | `db.close()` finalizes its statements; later calls on them say `statement has been finalized`; a second `close()` is `ERR_INVALID_STATE` | `sqlite04`, `sqlite05` |
| S14 | Re-running a statement invalidates a live iterator; `return()` on that iterator is a no-op; closing mid-iteration is legal | `sqlite05` |
| S15 | `stat` names are exact (`autoindex`, not `autoIndex`); `memused` cannot be reset | `sqlite06` |
| S16 | Tag-store keys are the literal text plus placeholder positions, case-sensitive; capacity defaults to 1000 and eviction finalizes | `sqlite06` |
| S17 | `limits` has 11 enumerable names, `Infinity` resets, negatives are `ERR_OUT_OF_RANGE` | `sqlite07` |
| S18 | `serialize`/`deserialize` round-trip a database; deserialize finalizes existing statements first | `sqlite07` |
| S19 | `isTransaction` follows autocommit; `location()` is `null` for in-memory and the OS-resolved path for files | `sqlite07` |
| S20 | Foreign keys are on by default, double-quoted string literals are off by default, defensive is on by default | `sqlite01`, `sqlite04` |
| S21 | SQLite failures carry `code: "ERR_SQLITE_ERROR"`, `errcode`, `errstr`, and the `errmsg` message | `sqlite04` |
| S22 | `backup()` returns a promise for the page count; `progress` gets `{ totalPages, remainingPages }` after each step | `sqlite08` |

Each of these gets one line in the conformance corpus and, where the rule is about our own
validation, one assertion in `test/js/lib/sqlite.test.js`.

---

## 6. Work packages

Sizes are engineering days for one person who knows the codebase.

### WP0 — Build, registration, and the `node:`-only seam (0.5 d)

- [x] `crates/ln-sqlite/{Cargo.toml,src/lib.rs}` skeleton; workspace member; `ln-runtime` dependency.
- [x] Feature/version pin; the MSRV floor was raised to 1.89 instead of testing the old 1.80
      (rusqlite's policy is "latest stable at release"; stable 1.100 built and tested the graph).
- [x] `builtin.rs` entry + `NODE_ONLY`; `modules.rs::builtin_source("sqlite")` (a stub module that
      exports the host accessor); `loader.js` `isBuiltin`/`builtinNames`; `process.versions.sqlite`.
- [x] Tests: `lookup("sqlite") == None`, `lookup("node:sqlite") == Some`, `isBuiltin` truth table,
      `builtinModules` excludes it.
- **Exit:** `cargo build`, `./target/debug/lite -e 'require("node:sqlite")'` works;
  `./target/debug/lite -e 'require("sqlite")'` is `MODULE_NOT_FOUND`; size delta measured.

### WP1 — `ln-sqlite`: the synchronous core (3 d)

- [x] Open/close with flags, busy timeout, FK/DQS/defensive config, limits.
- [x] Statements: prepare (persistent flag), bind (named resolution + bare/unknown policy),
      run/all/first/begin/next/finish with generations, columns metadata, stat/resetStats,
      sourceSQL/expandedSQL.
- [x] `exec`, `location`, `is_transaction`, `serialize`/`deserialize`, backup init/step/finish.
- [x] `Error` type carrying `errcode`/`errstr`; value conversion.
- [x] Unit tests in the crate: every format/edge in §5 that does not need the engine, plus a
      10k open/close loop with no growth.
- **Exit:** `cargo test -p ln-sqlite` green; no `unsafe` outside the statement module; the crate
  has no quickjs/tokio dependency.

### WP2 — The host primitive (2 d)

- [x] `SqliteState` in `HostState`, `host/sqlite.rs` with the §3.3 table.
- [x] `error_object_with` helper in `host_error.rs`; value/row conversion.
- [x] Teardown `Drop` (statements → connections) and the id-reuse rule.
- **Exit:** a host-level smoke test through `lite -e` for open/exec/prepare/run/all/close; no panic
  on a stale id.

### WP3 — `js/lib/sqlite.js` v1 (2.5 d)

- [x] Classes, aliases, `constants`, `backup`, `limits`, `[Symbol.dispose]`.
- [x] Argument validation and statement-option inheritance; row/result shaping (null prototypes).
- [x] `node:`-only documentation in the module header; no `require("node:sqlite")`.
- **Exit:** the §5 S1–S22 behaviours pass by hand under `lite`; `test/js/lib/sqlite.test.js` green
  (skips under Node like `zlib.test.js`).

### WP4 — Verification and docs for v1 (2 d)

- [x] `test/conformance/sqlite/sqlite01..08` + `.expected` (WP4); `sqlite09..13` were added with
      WP5/WP6. All recorded with `REGEN=1 RUN=node ./test/conformance/run.sh SUITES=sqlite` on
      Node 26.12.1.
- [x] `sqlite` added to `default_suites` in `test/conformance/run.sh` and to
      `test/conformance/README.md`.
- [x] `test/js/lib/sqlite.test.js`; optional host-shim `sqlite` for running the JS layer under Node
      (stretch: it would let `test/js/run.sh` assert the surface twice).
- [x] `docs/compat.md` row + divergence rows D76+; `docs/internals.md` §1/§2/§3; `README.md`
      "What's in the box" and the size table; `js/README.md` host-contract row and layout.
- **Exit:** CI's existing jobs cover the module; `cargo test --all`, `cargo clippy --all-targets
  -- -D warnings`, `cargo fmt --all -- --check`, `cargo deny check`, `test/conformance/run.sh`,
  `test/js/run.sh` all green.

### WP5 — Re-entrant callbacks (2 d)

- [x] Trampoline (§3.7) + `function`, `aggregate`, `setAuthorizer`.
- [x] Tests: scalar/varargs/deterministic, aggregate + window, authorizer allow/deny/ignore and the
      re-entrancy guard (`ERR_INVALID_STATE` inside the callback).
- [x] `sqlite09-functions.js`, `sqlite10-authorizer.js`; compat.md rows updated.
- **Exit:** the unsafe invariants are documented at the trampoline and exercised by tests that
  throw, recurse, and close.

### WP6 — Sessions, modules, extensions (2 d)

- [x] `createSession`/`Session.changeset`/`patchset`/`close`, `applyChangeset` with `filter` and
      `onConflict`; `createModule` virtual tables; `loadExtension`/`enableLoadExtension`.
- [x] Tests: source→target changeset round trip, conflict policy, a JS virtual table, extension
      gating (skip when no test `.dylib`/`.so` can be built).
- **Exit:** the remaining compat.md rows move from ⚪ to 🟡, or are recorded as deliberate gaps.

### WP7 — Package-wide polish (0.5 d)

- [x] Size/performance measurement in README; `docs/internals.md` counts; roadmap note if the
      module is to be advertised.
- [x] Review: no new `unwrap` on the host path, no leaked ids in the corpus, docs links.

---

## 7. Verification

### 7.1 Unit tests (`cargo test -p ln-sqlite`)

The crate is engine-free, so the whole synchronous contract can be tested without QuickJS: open
modes, bind policies, value round trips, metadata, limits, serialize/deserialize, backup stepping,
and error codes. These tests never touch `js/` or the host.

### 7.2 Conformance corpus

`test/conformance/run.sh` is the differential: a case is run under `lite` and compared with a
`.expected` recorded from Node. The new suite follows the zlib rules — assert round trips and
shapes, never encoder/version-specific bytes.

| case | covers |
|---|---|
| `sqlite01-basic.js` | open/exec/prepare/run/all/get, changes/lastInsertRowid, `sourceSQL`, close |
| `sqlite02-types.js` | all six storage classes in and out, BigInt reads, returnArrays, out-of-range |
| `sqlite03-bindings.js` | `?`, `?NNN`, `$`/`:`/`@`, bare/unknown policy, extra/missing args |
| `sqlite04-errors.js` | `ERR_SQLITE_ERROR`/`errcode`/`errstr`, invalid state, invalid args, empty SQL |
| `sqlite05-iterate.js` | iteration, early `return()`, invalidation, close mid-iteration |
| `sqlite06-tagstore.js` | cache hits/misses, `size`/`capacity`, `clear`, eviction |
| `sqlite07-limits.js` | serialize/deserialize, limits, location, isTransaction |
| `sqlite08-backup.js` | backup page count and progress shape (temp path printed as a basename) |
| `sqlite09-functions.js` | scalar functions, aggregates, window functions, argument conversion, throws |
| `sqlite10-authorizer.js` | authorizer arguments, OK/DENY/IGNORE, clearing the callback |
| `sqlite11-session.js` | changeset/patchset, abort/omit/replace conflicts, table filter |
| `sqlite12-vtab.js` | JavaScript virtual tables, hidden arguments, storage classes, validation |
| `sqlite13-extension.js` | extension opt-in, enable/disable, coded load failures |

### 7.3 Stdlib test

`test/js/lib/sqlite.test.js` is runtime-agnostic like `zlib.test.js`: it prints
`skip: lite host unavailable` under Node and asserts under `lite`. It covers our own validation
(messages and codes), the statement-option inheritance, and the divergences in Appendix B. A
`sqlite.oracle.js` is deliberately not proposed: the corpus already is the Node differential, and
a shim-backed oracle would test the shim.

### 7.4 CI

No new job: the module is picked up by `cargo test --all`, `test/conformance/run.sh` (once
`sqlite` is in `default_suites`) and `test/js/run.sh` (glob). WP4 adds the suite and the test; the
existing macOS/Ubuntu matrix builds the bundled C on both. `cargo deny check` stays in the release
checklist.

### 7.5 Determinism rules

- In-memory databases only; file-backed cases use `mkdtemp`-style paths and print basenames.
- Never print `process.versions.sqlite`, `sqlite3_libversion()`, `memused`, timings, absolute
  paths, or the number of pages a file-backed database happens to use.
- `columns()` `type` strings come from declared types, which the schema controls; expressions print
  `null`.
- The corpus is recorded from Node, never from `lite`.

### 7.6 Oracle version policy

The oracle is Node 26.12.1 (SQLite 3.54.1) on this machine. The runtime bundles 3.53.2. A case that
fails after a future SQLite/Node bump is a corpus bug if it depended on a version-specific
behaviour; the fix is to narrow the case, not to change onde's output to match a newer Node unless
the behaviour is documented. Record the oracle and SQLite versions in the suite README.

---

## 8. Size and performance

- **Size, measured 2026-11-24** (release, macOS arm64, no strip): `lite` grows from
  **5,533,968 to 7,648,208 bytes — +2,114,240 B (+2.11 MB, +38%)**, after WP5/WP6 added the
  session/preupdate extension, functions and virtual-table support. That is above the plan's
  1.5 MB target; the measured number is recorded rather than hidden, and the 2026-11-24 decision
  (default-on for Node parity, one-line off switch) stands. `--no-default-features` reproduces the
  5.5 MB binary. An `ondec` hello-world link measured 6,892,976 bytes with SQLite (6.6 MiB) and
  4,627,480 bytes with a slim archive (4.4 MiB); `ln-embed` exposes the same `node-sqlite` feature.
- **Cold start** was re-measured with `test/net/coldstart.js` after the change: `-e '1+1'` 10.98 ms
  against 11.6 ms in the README (load average 16.5), `require("http")` 17.63 ms against 18.4 ms —
  no regression, because `sqlite3_initialize` is lazy and the module's JS is only compiled when
  required.
- **Startup** should not move: `sqlite3_initialize` is lazy and the module's JS is only compiled if
  required. WP0 checks `test/net/coldstart.js` is unchanged.
- **Hot path**: no benchmark gate. The one design rule is that a query crossing is per call, not
  per row for `all`/`get` (rows are built in one host call), and `iterate` is per row by contract.

---

## 9. Risks and open decisions

| id | risk / decision | proposal |
|---|---|---|
| R1 | **Binary size** | measured +2.11 MB (+38%), including WP5/WP6; default-on per the 2026-11-24 decision, with the `node-sqlite` feature and `--no-default-features` as the documented opt-out. The 1.5 MB target was missed and is recorded above |
| R2 | **Unsafe re-entry for callbacks** (WP5) | landed with the invariants written at the trampolines and exercised by tests that throw, recurse and close; the fallback (ship without UDFs) was not needed |
| R3 | **SQLite version skew** (3.53.2 vs 3.54.1) | no version-dependent corpus cases; `process.versions.sqlite` reports the truth |
| R4 | **MSRV** (rusqlite 0.40 vs workspace 1.80) | resolved: the workspace floor is raised to 1.89 (rusqlite 0.43's declared minimum and the current generation's floor), documented in `Cargo.toml`; all testing runs on stable 1.100 |
| R5 | **Bundled C build** | already required by quickjs; CI covers macOS/Ubuntu; Windows is untested (recorded) |
| R6 | **No GC finalization** | documented divergence; teardown closes everything; file descriptors are not leaked by GC timing |
| R7 | **`node:`-only change touches the resolver** | smallest possible change (`NODE_ONLY` + loader filter); tests pin `require("sqlite")`/`isBuiltin`/`builtinModules` |
| O1 | **Should standalone apps pay for SQLite by default?** | **decided:** yes, default-on everywhere; `--no-default-features` (or `node-sqlite` feature off) removes it without a refactor |
| O2 | **Should WP5/WP6 be in this landing or a follow-up?** | **resolved:** WP5/WP6 landed in the same work package on 2026-11-24; only `diagnostics_channel` remains |
| O3 | **Milestone placement** | **decided:** standalone work package (zlib precedent); no roadmap renumbering |

---

## 10. Exit criteria

1. `require("node:sqlite")` and `import { Database } from "node:sqlite"` work under `lite`;
   `require("sqlite")` and bare `sqlite` imports fail exactly like Node.
2. The thirteen conformance cases produce byte-identical stdout to the Node 26.12.1 recording, with
   the existing corpus still green.
3. `test/js/lib/sqlite.test.js` passes under `lite` and skips cleanly under Node.
4. `cargo test --all`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --all -- --check`
   and `cargo deny check` are green.
5. The release-binary size delta is recorded in `README.md` (7.5 MB against 5.5 MB) and the
   `node-sqlite` feature is the documented opt-out; the 1.5 MB target is recorded as missed, not hidden.
6. `docs/compat.md`, `docs/internals.md`, `README.md` and `js/README.md` describe exactly what
   shipped, including the divergences (no GC finalization, no `diagnostics_channel`, backup's
   chunked loop, the bundled SQLite version).
7. No `unwrap`/`expect` on user-controlled input in `ln-sqlite` or `host/sqlite.rs`; every SQLite
   error path produces a JS `Error` with `errcode`/`errstr`.

---

## Appendix A — files created or changed

| path | change |
|---|---|
| `Cargo.toml` | workspace member `crates/ln-sqlite` |
| `crates/ln-sqlite/Cargo.toml`, `src/lib.rs` (+ modules) | new: connection, statement, value, error, backup, session |
| `crates/ln-runtime/Cargo.toml` | `ln-sqlite` dependency |
| `crates/ln-runtime/src/host/mod.rs` | `mod sqlite`, `sqlite::install`, `SqliteState` field |
| `crates/ln-runtime/src/host/sqlite.rs` | new: `__ln_host.sqlite` |
| `crates/ln-runtime/src/host_error.rs` | `error_object_with` helper |
| `crates/ln-runtime/src/modules.rs` | `builtin_source("sqlite")` arm |
| `crates/ln-modules/src/builtin.rs` | `sqlite` in `BUILTINS`, `NODE_ONLY` |
| `js/lib/sqlite.js` | new |
| `js/lib/loader.js` | `isBuiltin`/`builtinNames` node-only filter |
| `js/lib/process.js` | `versions.sqlite` |
| `js/README.md` | layout row + host-contract row |
| `test/conformance/sqlite/*` | new suite + expected |
| `test/conformance/run.sh` | `sqlite` in `default_suites` |
| `test/conformance/README.md` | suite list |
| `test/js/lib/sqlite.test.js` | new |
| `docs/sqlite-plan.md` | this file |
| `docs/research/node-sqlite-api.md` | new |
| `docs/compat.md` | module row + D76+ divergences |
| `docs/internals.md` | inventory, repo layout, test counts |
| `README.md` | "What's in the box", footprint |

## Appendix B — divergences to record in `compat.md`

| id | divergence | rationale |
|---|---|---|
| D76 | `node:sqlite` is synchronous and whole-call: `Database`/`Statement` never touch a thread pool. `backup()` is a promise whose loop yields through `setImmediate` between batches instead of stepping on a libuv thread. | SOP: onde has no SQLite thread pool, and a connection must stay on its isolate thread; yielding between batches is visible only in timing, not in results. |
| D77 | No `diagnostics_channel` `'sqlite.db.query'` events. | `diagnostics_channel` is not implemented at all, so there is no channel to publish them on. |
| D78 | A `Database`/`Statement` that is never closed is closed at isolate teardown, not by a GC finalizer; a GC'd-but-unclosed object stays open until then. | QuickJS 0.17 does not deliver `FinalizationRegistry` callbacks reliably, and a finalizer must not run SQLite calls. |
| D79 | The bundled SQLite is 3.53.2, not Node 26's 3.54.1; `process.versions.sqlite` reports the bundled version. | one self-contained binary; no system libsqlite3; version-dependent behaviour is not asserted. |
