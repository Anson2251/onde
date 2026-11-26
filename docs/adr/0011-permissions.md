# ADR-0011: Permissions — an opt-in policy, allow-lists only, enforced below the JS stdlib

- Status: accepted (M8, 2026-11-25; third draft, after two reviews). The delivery outcome is
  in [permissions-plan.md](../permissions-plan.md#12-outcome-2026-11-25).
- Date: 2026-11-25
- Supersedes: the unnumbered "permissions model" row in [roadmap.md](../roadmap.md#6-decision-log)
- Related: [0005 ops protocol](0005-ops-protocol.md), [0006 handles and events](0006-handles-and-events.md),
  [0008 processes and threads](0008-processes-and-threads.md), [0010 FFI](0010-ffi-dlopen.md),
  M8 in [roadmap.md](../roadmap.md#m8--permissions-48-w) and the delivery plan in
  [permissions-plan.md](../permissions-plan.md)

## 1. Context

onde runs CLIs, build steps, config loaders and plugin hosts. Three of those four are trusted: the user
chose the script. The fourth is not — a tool that runs *someone else's* plugin wants it to run with
less authority than the tool itself has — and that is the reason this document exists.

Node's permission model is opt-in (`--permission` plus `--allow-*`) and gates `fs`, `child_process`,
`worker_threads` and native addons. Deno's is deny-by-default and also gates network and environment.
Neither lets a project manifest grant itself permissions: the grant comes from the command line,
because the command line belongs to whoever started the process.

Three properties of this codebase decide most of the design:

1. **Capability looks like six things and is really three.** Some abilities go through an `Op` and a
   pool task; some are a Rust call that reads a file because the module loader needs it; some are a
   direct syscall (`process.kill`, `sqlite3_load_extension`, stdio). Two reviews of earlier drafts
   found bypasses of exactly the second and third kinds — a JSON module loader doing
   `fs::read_to_string`, and SQLite loading native code — while the prose inventory claimed
   completeness. So the inventory below (§5.4) is treated as a snapshot and the *tests* in §7 are the
   guarantee: a source scan for I/O primitives outside the declared chokepoints, not just a JS
   reflection list.
2. **The host boundary is reachable from user scripts.** `__ln_host` is frozen, not removed
   ([bootstrap.js](../../js/bootstrap.js)), so a script can call any of it directly. A gate written in
   `js/lib/fs.js` is decorative — a script can call `__ln_host.fsSync("readFile", …)` itself. **The
   check must live below the JS stdlib, in Rust.**
3. **Two filesystem realities defeat string comparison.** macOS and Windows are case-insensitive by
   default, `realpath` preserves the caller's spelling, and APFS opens NFC and NFD spellings of one
   name. A rule that says "this path is *not* allowed" therefore fails open. That decides §4.2.

The roadmap previously deferred this to 1.1 and described it as "deny-by-default `--allow-*`". That
sentence is the Deno shape and is not compatible with the Node-shaped runtime 1.0 claims to be. This
ADR replaces it, and schedules the work before 1.0 (M8) rather than after it; the delivery plan is
[permissions-plan.md](../permissions-plan.md).

## 2. Options

* **A. No model.** Ship 1.0 allow-all and leave sandboxing to the OS.
* **B. Deny-by-default, Deno-style.** Breaks every existing Node script in a minor release.
* **C. Opt-in, Node-style.** Off unless `--permission` is given; when given, deny-by-default with
  scoped grants.
* **D. Policy file only.** Discovered from a project file; no flags.
* **E. Opt-in, grants from the command line.** `--permission` enables a deny-all base; either
  `--permission-file=FILE` (a reviewed policy) or repeatable `--allow-*` flags (ad-hoc grants) supply
  the grants. C, with D's ergonomics and the caller's trust root.

Three sub-questions, all settled below:

* **Direction.** Allow-list ("only these") or deny-list ("anything but these")? §4.2.
* **Two grant channels.** The file and the flags are **mutually exclusive**; the CLI rejects a run
  that has both. §4.3.
* **Format.** JSON (free — `serde_json` is a direct dependency of `ln-runtime` and `ln-modules`),
  TOML (`toml` + `toml_edit` + `winnow`, ~200 KB and six crates), JSON5 (`json5` is pest-based, seven
  crates), or JSON with comments (`json_comments`: 266 lines, zero runtime dependencies, Apache-2.0,
  which the license allow-list in [deny.toml](../../deny.toml) already covers — it is a new *crate*,
  not a new licence).

## 3. Decision

**E, allow-lists only, JSON-plus-comments for the file, one grant channel per run.**

* **1.0 ships the model switched off.** `onde app.js` is unchanged: no flag, no new syscall, no
  cold-start cost, no compatibility break. `--permission` opts in. This is M8, before the 1.0
  hardening milestone, so the release documents and tests the model it ships rather than deferring
  it to a minor.
* **Enabling.** `--permission` selects a deny-all base. Then exactly one of:
  * `--permission-file=FILE` — a reviewed policy, the plugin-host case; or
  * repeatable `--allow-*` flags: `--allow-fs-read=PATH`, `--allow-fs-write=PATH`,
    `--allow-net-connect=HOST[:PORT]`, `--allow-net-listen=[HOST:]PORT`,
    `--allow-net-resolve=HOST`, `--allow-child-process=CMD`, `--allow-worker`,
    `--allow-env=NAME`, `--allow-ffi` (M10).

  One flag per capability id, so the two surfaces share one grammar. Passing both a file and a flag
  is a usage error: two grant channels with one authority is how a wrapper widens a reviewed policy
  by appending an argument. Every value-taking flag goes into `VALUED` in
  [main.rs](../../crates/ln-cli/src/main.rs) or the script path is swallowed.
* **Allow-lists only.** No `default` field, no deny-lists: a capability that lists nothing is denied.
  §4.2 records why and what would have to be true to add them.
* **Format.** JSON with `//` and `/* */` comments, stripped by `json_comments` with
  `CommentSettings::c_style()`. `#` comments are off; trailing commas are not supported. This is
  JSON-with-comments, not JSONC.
* **The file is a security input.** `realpath` it, require a regular file, cap it at 1 MiB, refuse it
  if group- or world-writable (the sudoers rule), parse with `deny_unknown_fields`. Any failure is
  fatal: no *implicit* fall back to allow-all, because a typo that silently disables a sandbox is
  worse than a refusal to start.
* **Relative grants resolve against the file's directory**, after `realpath`, never against the cwd.
* **Nine capability ids**: `fs.read`, `fs.write`, `net.connect`, `net.listen`, `net.resolve`,
  `child.spawn`, `worker.spawn`, `env.read`, `ffi.load` (M10). `ffi.load` rather than Node's `addons`
  because onde implements `dlopen`, not N-API — and it is defined as *the capability*, any route by
  which native code enters the process, not as one API: `process.dlopen`, `sqlite.loadExtension`,
  `allowExtension` at open, and whatever a future addon loader adds. One id, so a new native-code path
  inherits the grant instead of inventing `addons.load` next to it.
* **One read chokepoint.** `read_source(path, Class)` in `ln-runtime` is the only code in the runtime
  that reads a file outside an `Op`. `Class::Source` (module code) is exempt; `Class::Data` (JSON and
  other data modules) needs `fs.read`; resolution metadata (`package.json`) is exempt and enumerated.
* **Enforcement where the syscall happens.** For `fs`, that is `Op::execute` inside `ln-io`, on the
  pool thread, immediately before the call. The policy rides with the op.
* **Denial is `ERR_ACCESS_DENIED`** with `code`, `capability`, `resource`, `policy`, delivered through
  the channel a syscall failure of that form would use, in every form including callbacks.
* **`process.permission.has(scope, reference)`** exposes the matcher read-only.
* **Inheritance: workers only.** A worker's `Config` is built by a helper that copies the inheritable
  fields, so a new field cannot be forgotten; the worker cannot widen. Child processes are out of
  scope — `fork` is `spawn`, and `child.spawn` is a grant of arbitrary execution (§5.8).
* **No dormant gates in 1.0.** Everything lands in M8. Gates switched off are dead code that rots
  before anyone exercises it.
* **Compiled apps are deferred** (§11), with the mechanism designed and unscheduled.

## 4. Why

### 4.1 Why not B (deny-by-default)

`node app.js` runs with the user's full authority and every migration guide, npm script and README
assumes it. A 1.0 that refuses `fs.readFile` without a grant is a different product with the same API;
a 1.1 that introduces it breaks a minor version. If the default ever flips, it flips at a major. The
plugin host opts in, which is the case that needs it.

### 4.2 Why no deny-lists

A deny-list is only worth anything if it is right about file identity, and a path check cannot be:

* **Case.** APFS is case-insensitive and `realpath` returns the caller's spelling, so a deny of
  `/data/secrets` does not match `/data/SECRETS` — and the open succeeds. Allow-lists fail closed
  here; deny-lists fail open.
* **Normalisation.** APFS opens NFC and NFD spellings of the same name; a deny written in one form
  misses the other.
* **Hard links.** A pre-existing link to a denied file inside an allowed directory is readable and no
  `realpath` reveals it.

Each is a bypass for a deny-list and an over-denial for an allow-list, which is the right direction to
be wrong in. To add them later you would need comparison on a fold-cased, NFC-normalised key with a
per-volume `is_case_sensitive` probe, plus a decision about hard links that the model admits it cannot
make. That is a design, not a field.

### 4.3 Why the file and the flags are mutually exclusive

Both come from the caller, so a union is defensible — but in the case this ADR exists for, the
reviewed file is the trusted artifact and argv is built by a wrapper that may be taking its arguments
from somewhere less trustworthy. Union means `--allow-fs-read=/` appended by that wrapper silently
widens `ci.json`, and the denial message would name the file, not the argument that overrode it.
Intersection is worse in the other direction: the obvious way to add one path stops working. So the
run takes one grant channel; a policy that needs another path is edited, which is also what review
wants.

### 4.4 Why not D (discovery)

A discovered policy is a policy the confined code can choose: `onde ~/Downloads/x/app.js` picking up
`~/Downloads/x/permissions.json` means the app wrote its own walls. An argument moves the grant to the
caller and lets the file be reviewed, diffed and pinned.

### 4.5 Why JSON with comments

The file exists to be read during an incident; a comment-free policy loses most of that.
`json_comments` costs nothing and replaces comments with spaces rather than deleting them, so
`serde_json`'s line and column stay true — which is what makes `denied by /etc/onde/ci.json:12`
possible. TOML is nicer but ~200 KB and six crates against a published 7.6 MB binary (3.7 MB slim);
JSON5 pays a similar price for grammar this file cannot use, since hyphenated ids are not valid JSON5
identifiers. The parse is opt-in, so cold start is untouched.

### 4.6 Why below the JS stdlib

`__ln_host` is a global, and the `fs` entry point already documents that `build_op` re-validates
arguments because a direct `__ln_host.fsSync` call is possible. Enforcement inherits the argument.

### 4.7 Why resolved paths, checked late, opened resolved

A prefix check on the requested string is defeated by a symlink the script creates: with `fs.write` on
`/data`, `symlink("/etc/passwd", "/data/link")` then `readFile("/data/link")` passes a lexical check.
So the check uses the resolved path.

Resolving at submit time leaves a window the script itself can win — it is not a concurrent local
attacker, it is the script, and it controls that window. For an async op the resolution therefore
happens in the pool task, immediately before the syscall, and **the syscall opens the resolved path
with `O_NOFOLLOW`**, so what was checked is what is opened. For creates, the nearest existing ancestor
is resolved and the remaining components are `lstat`-walked from the grant root; a symlink below the
grant is refused while a policy is active.

Residual race: a directory between the grant root and the file can be renamed between the walk and the
`open`. Closing that needs to hold a dirfd across check and open (`openat`), and on Linux
`openat2(RESOLVE_BENEATH)` closes it entirely. `truncate` uses `open(O_NOFOLLOW)` + `ftruncate`;
`chmod`, `chown` and `utimes` still resolve and then call a path syscall, and closing that narrower
window needs the same dirfd hold. That is a follow-up, and §6 says so rather than implying more.

Cost: one to three extra syscalls per `fs` op in permission-enabled runs only. Default runs take an
`Option::is_none` branch and pay nothing.

## 5. The model

### 5.1 Policy value

```rust
pub struct Policy {
    capabilities: [CapabilityGrant; CAPABILITY_COUNT],
}

/// One capability: the resources it may touch. Empty means denied.
struct CapabilityGrant {
    allow: Vec<Rule>,
}
```

`Config::permissions: Option<Policy>` ([lib.rs](../../crates/ln-runtime/src/lib.rs); `Policy` lives in
the engine-free `ln-perm` crate so `ondec` can validate one without depending on the runtime) is the
embed API; the CLI is a front-end producing the same value. One type, two doors — otherwise the plugin
host, the case that pays for the feature, ends up on the untested path.

There is deliberately **no allow-all variant**. A policy whose grants are `Rule::Any` permits
everything, so a second representation would be a second code path, a second answer to "is this policy
permissive", and a second thing to serialize. `None` means the model is absent; `--permission` alone is
`Some(Policy::deny_all())`. The fast path is a property of the data — `Rule::Any` passes in O(1)
without canonicalising — so an all-allow policy costs the same as `None`.

Internally the runtime does not carry the `Option`: `HostState` holds a `Policy` (with
`Policy::deny_all()` for `None`-equivalent behaviour where nothing is checked, behind one
`enforced: bool`), so a missed copy in a worker or a fork cannot silently mean allow-all.

### 5.2 What the caller writes

```jsonc
{
  // Relative paths resolve against this file's directory, after realpath.
  "fs": {
    "read":  ["./data", "/usr/share/zoneinfo"],
    "write": ["./cache"]
  },
  "net": {
    "connect": ["api.example.com:443", "*.internal.example.com"],
    "listen":  [":8080"],
    "resolve": ["api.example.com"]
  },
  "child_process": { "spawn": ["git", "/usr/bin/make"] },
  "worker": { "spawn": true },
  "env": { "read": ["PORT", "NODE_ENV"] }
}
```

Two shapes only: an array of strings, and a boolean for `worker.spawn` and `ffi.load`. Unknown keys,
unknown capabilities, an absent key and wrong types are parse errors; an absent key denies. An empty
`{}` is `--permission` with no grants.

The same policy from the command line, one flag per capability:

```sh
onde --permission \
     --allow-fs-read=./data --allow-fs-read=/usr/share/zoneinfo \
     --allow-fs-write=./cache \
     --allow-net-connect=api.example.com:443 --allow-net-listen=:8080 \
     --allow-child-process=git --allow-env=PORT plugin.js
```

### 5.3 Grant matching

**`fs.read` / `fs.write`** — a grant is a path prefix; a path matches when the resolved target equals
the grant or begins with the grant followed by a separator. `/data` matches `/data/a`, not
`/database`. No globs in v1. `write` does not imply `read`; a call that needs both needs both grants.

**`net.connect` / `net.listen`** — `host`, `host:port`, or `:port` (listen only, any local address). A
bare host allows any port; `*.example.com` matches subdomains, not the apex. Unix-domain sockets are
matched as paths under **`net.connect` / `net.listen`** (never `fs`), resolved by the `fs` rule.

**The check runs after resolution, once per candidate endpoint, and a grant matches when either the
requested `host:port` matches a name grant or the resolved `address:port` matches a literal grant.**
That is what makes a hostname resolving to `169.254.169.254` governed by the same grant as the
literal, while `api.example.com:443` still matches by name. A name grant trusts that name's DNS,
including a rebind; a literal grant does not. The name itself is checked before the resolver runs
(`net.resolve`), so a deny-all policy issues no DNS query; a connect or listen grant for a name
implies resolve for it, while a literal-address grant does not. Denied candidates are skipped, and a run whose
candidates are all denied fails with the denial, not the last connection error. `connect` and
`listen` are built in [net.rs](../../crates/ln-runtime/src/host/net.rs) but resolved and executed in
`ln-io`.

Port 0 is matched literally and is **not** a wildcard. Granting `:0` permits an ephemeral port on every
interface, and since Node binds the unspecified address by default that is inbound connections from
anywhere on the network — real authority, not a technicality. The least-privilege spelling sits beside
it: `127.0.0.1:0`. There is no `*` port, because the interface is the dimension that matters and a
wildcard would be a second way to say "any port".

**`net.resolve`** — hostname patterns as above. A `net.connect` grant for a host implies
`net.resolve` for it. Resolving a literal IP needs no grant.

**`child.spawn`** — matched against the resolved executable path; a bare name (`"git"`) matches any
path whose basename is `git`. `fork` is covered because it is `spawn`. A bare name therefore trusts
whatever `PATH` resolves to; a full path does not. `exec`/`execFile` with a shell run `/bin/sh`,
which is the executable the grant is checked against, so a policy that grants `git` does not grant
`exec("git ...")`. `process.kill` is covered by this id but has its own entry point, because it
never passes through `host.proc`; it has no executable to match and is allowed by any
`child.spawn` grant, because a policy that grants process control has accepted signal authority.

**`env.read`** — exact variable names, not a namespace. **Writes are not gated**: a value only escapes
into a child, and `child.spawn` already gates that, so `env.write` would be a capability no policy
would deny separately. Reads are gated because env is where secrets live, which is a different reason.

**`fs.read` / `fs.write` for sqlite** — opening a database requires `fs.read` on its path, plus
`fs.write` when the open is not `readOnly` (`DatabaseSync` defaults to read-write with `CREATE`). A
write grant on the database implicitly covers exactly its three side files — `-journal`, `-wal`,
`-shm` — because SQLite creates those through its own file descriptors and no `Op` sees them. The
implication is bounded (they are the database's own names, never arbitrary paths) and it is the only
way to keep file-granular policies; requiring write on the parent directory instead would make a
single-file policy impossible. Because SQLite, not the runtime, opens the side files, `sqlite.open`
refuses when any of the three exists as a symlink. Under a policy a `file:` URI is refused: SQLite
parses that form itself, so the string the gate checked and the file SQLite opened would differ; the
checked, resolved path is what is passed to SQLite. `:memory:` is exempt, having no path.

**`worker.spawn`** — boolean; the worker inherits and cannot widen.

**`ffi.load`** — boolean; the capability is "native code enters the process", so `process.dlopen`
(M10), `sqlite.open` with `allowExtension: true`, `enableLoadExtension(true)` and `loadExtension(path)`
are one grant. The id names the authority, not the API, so a future loader extends it rather than
adding a second id that half the policies would forget.

### 5.4 Enforcement points

The table is a snapshot; §7's tests are the guarantee. Entries are grouped by how the gate is reached.

| # | Capability | Entry | Where the check runs |
|---|---|---|---|
| 1 | `fs.read`, `fs.write` | `build_op` ([ops.rs](../../crates/ln-runtime/src/ops.rs)) → `Op` | `Op::execute` in [ln-io](../../crates/ln-io/src/lib.rs), pool thread |
| 2 | `fs.read` | JSON/data modules: `load_json_module` → `read_source(path, Data)` ([modules.rs](../../crates/ln-runtime/src/modules.rs)) | inside `read_source` |
| 3 | — (exempt) | module source: `read_source(path, Source)`, CJS via the loader | enumerated exemption |
| 4 | — (exempt) | `package.json` during resolution | enumerated exemption |
| 5 | `net.connect`, `net.listen` | `host.net` command | in the connect/listen task, after resolution |
| 6 | `net.resolve` | `host.dnsAsync` ([dns.rs](../../crates/ln-runtime/src/host/dns.rs)) | in the lookup task |
| 7 | `child.spawn` | `host.proc` `"spawn"` ([proc.rs](../../crates/ln-runtime/src/host/proc.rs)) | at spawn |
| 8 | `child.spawn` | `host.kill` ([signal.rs](../../crates/ln-runtime/src/host/signal.rs)) | at signal |
| 9 | `worker.spawn` | `host.worker` `"spawn"` ([worker.rs](../../crates/ln-runtime/src/host/worker.rs)); `host.workers` is the sink registry | at spawn |
| 10 | `env.read` | `host.env` ([mod.rs](../../crates/ln-runtime/src/host/mod.rs)) | returns a filtered object |
| 11 | `fs.read`, `fs.write` | `host.sqlite` `open` (except `:memory:`, `fs.write` only when not `readOnly`, side files checked) and `backupInit` ([sqlite.rs](../../crates/ln-runtime/src/host/sqlite.rs)) | at open |
| 12 | `ffi.load` | `host.sqlite` `allowExtension`/`enableLoadExtension`/`loadExtension` | at call |
| 13 | `fs.write` | `host.writeFd`, `host.write` ([stdio.rs](../../crates/ln-runtime/src/host/stdio.rs)) | fd table (§5.6) |

Deliberately not gated, with the reason recorded in code: `host.write` to 0/1/2, `host.chdir`, the
informational getters (`cwd`, `homedir`, `tmpdir`, `hostname`, `pid`, `uid`, `osInfo`, `platform`),
timers, the `async_*` hooks, `host.exit`/`setExitCode`, `host.ipc` send, and the compute calls
(`crypto`, `text`, `buffer`, `zlib`). `host.signal` installing a process-wide handler is also exempt —
it is a denial-of-service surface, not an authority the policy grants, and it is recorded as such.

### 5.4.1 The loader leaves `__ln_host`

`host.readFile` exists so `loader.js` can read CJS and JSON modules, and it sits on the same global a
script can reach: today `require("./x.json")` returns any UTF-8 file, and the ESM path bypasses JS
entirely through `load_json_module`. Both are fixed by the same thing — **one Rust chokepoint**:

```rust
enum Class { Source, Data }
fn read_source(path: &Path, class: Class, policy: &Policy) -> Result<String>
```

* `Source`: CJS, ESM and builtins. Exempt: the interpreter must load code, and the result is executed,
  not returned.
* `Data`: JSON and other data modules. Requires `fs.read` at the resolved path.
* Metadata: `package.json` during resolution is `Source`-class by this definition and therefore
  exempt; §5.4 row 4 lists it so the exemption is visible rather than implicit.

`loader.js` calls it through an object `bootstrap.js` receives **before** `Object.freeze(host)` runs,
so the privileged functions are a separate global (`__ln_loader`) that is deleted after the loader
captures it in a closure. They cannot be properties of `__ln_host`: freezing happens first, and
`delete` on a frozen object is a no-op in sloppy code and a `TypeError` in strict. `host.realpath`
and `host.statKind` have no JS consumer at all and are deleted rather than moved.

The privileged object must carry everything the loader needs, not just the reads: `platform`,
`builtinSource`, `builtinNames`, `builtinUnavailable`, `nodeOnlyBuiltins`, `evalCjs`, `resolve`,
`metaResolve`, and the two reader functions.

### 5.5 Per-op classification

The match over `ln_io::Op` is exhaustive with no wildcard arm, so a new op fails to compile until it
is classified. `open` is classified from its **flags**, and the rule is a mask, not `O_ACCMODE`:
`O_WRONLY`, `O_RDWR`, `O_CREAT`, `O_TRUNC` and `O_APPEND` are all write bits, because
`O_RDONLY|O_CREAT` creates a file inside a read-only grant. `O_RDONLY|O_RDWR` bits determine the read
requirement; `O_CREAT` additionally checks the parent directory.

| Class | Ops |
|---|---|
| read | `ReadFile`, `Readdir`, `Stat`, `Access`, `Readlink`, `Realpath`, `Statfs`, `Open` with no write bit |
| write | `WriteFile`, `AppendFile`, `Mkdir`, `Mkdtemp`, `Rm`, `Rmdir`, `Unlink`, `Truncate`, `Chmod`, `Chown`, `Utimes`, `Symlink`, `Open` with any write bit |
| both paths | `CopyFile` (read src, write dst), `Rename` (write src and dst), `Link` (write both) |
| fd (table, §5.6) | `Read`, `Write`, `Fstat`, `Ftruncate`, `Fchmod`, `Fchown`, `Futimes`, `Fsync`, `Fdatasync`, `Close` |
| lookup | `Lookup` → `net.resolve` |

`Symlink` needs write on the link path only; `Link` needs write on both, which is stricter than
`link(2)` and safer than reasoning about link counts. Every op that takes a `follow` flag is resolved
for the path actually touched: `Stat`/`Chmod`/`Chown`/`Utimes` with `follow: false` resolve the link
itself, not its target.

### 5.6 The fd table

`Op::Read { fd }` has no path and `host.writeFd` takes an arbitrary number, so the isolate keeps a
table: 0/1/2 at boot, `host.ipcFd`, plus every fd returned by a granted `Open`, recorded with the mode
it was opened with. A bare-fd op is allowed when the fd is present and the mode permits it — `Read`
needs read mode; `Write`/`Ftruncate`/`Fchmod`/`Fchown`/`Futimes` need write mode;
`Fstat`/`Fsync`/`Fdatasync`/`Close` need membership only. `host.writeFd` consults the same table,
which is what stops `writeFd(7, …)` from being a general escape. `StdioMode::Fd(i32)` in
[ln-io/proc.rs](../../crates/ln-io/src/proc.rs) hands an fd to a child directly and is the remaining
hole: it must fail for an fd the table does not know.

### 5.7 Denial surface

`ERR_ACCESS_DENIED` with `code`, `capability`, `resource`, `policy` and a message naming the file and
line:

```
ERR_ACCESS_DENIED: fs.read is denied for '/etc/passwd' by ./ci.json:4
```

The line is the capability's key in the policy file (the `"read"` key for `fs.read`, the `"spawn"`
key for `child.spawn`). A capability that is absent from the file cites the file without a line, and
`--allow-*` cites `<command line>`.

`NodeError` ([ln-error](../../crates/ln-error/src/lib.rs)) has no field for those properties, so it
gains an optional denial payload — and the async path, which builds its error through
`node_error_object`, must carry it, or the properties exist only for the sync forms. A *nonexistent*
path still reports `ENOENT`: denial is reached after resolution, so the guarantee is that a denied
*existing* resource never reports success or a misleading errno.

### 5.8 Inheritance

Workers inherit through a `Config::child_of(parent)` helper that copies the inheritable set (budget,
`io_threads`, `max_old_space_size`, `permissions`), so a field added later cannot be forgotten the way
a field-by-field copy forgets one. The worker cannot widen.

Child processes are out of scope and the docs say so: `fork` is `spawn`
([child_process.js](../../js/lib/child_process.js)), `spawn` accepts arbitrary fds and an arbitrary
environment, and `child.spawn` is a grant of arbitrary execution. An earlier draft proposed sealing the
policy into a read-only fd for the child; it was dropped because it is unreachable when `child.spawn`
is denied and meaningless when it is granted.

### 5.9 `process.permission`

`has(scope, reference)` returns a boolean through the same matcher. Read-only: no setter, and no JS
call moves the policy.

With `None` installed the object is still there and `has` reports `true` for everything. Node makes
`process.permission` absent unless `--permission` is given (measured on v26.12.1), so this is an
onde extension, not a compatibility rule; it is kept because an `if (process.permission)`
feature-detect tells a script nothing: from inside the sandbox, "not enforced" and "allowed" are the
same answer to the only question it can ask. An embedder that needs the distinction has its own
`Config`.

## 6. Threat model and non-goals

**The adversary is the script, and it runs concurrently with the runtime.** It can create symlinks,
remove files and race its own async ops, which is why checks are resolved late, opened resolved, and
applied where the syscall happens. What it cannot get is a *transitive* boundary: `child.spawn`, once
granted, hands it a process this runtime does not control.

**Case-insensitive, normalising filesystems** are handled by failing closed: grants compare against
the resolved path, so an odd-case spelling of a granted path is simply not granted.

**Hard links** defeat path-based identity. An allow-list fails closed (the aliased path was never
granted); a script can create links only where it has `fs.write` on both ends, and `Link` requires
exactly that. Pre-existing links are outside what a path check can see, and the ADR does not claim
otherwise.

**Not in scope:** per-request or stack-scoped attenuation, network byte-level filtering, seccomp/LSM
integration, TOCTOU-free creates on macOS, and directory-rename races (the dirfd/`openat` follow-up
in §4.7).

**Windows:** the world-writable check, `realpath` semantics and case folding differ; 1.0 enforces on
macOS and Linux and treats Windows as best-effort, matching R8.

**Compiled apps** are deferred (§11).

## 7. Testing

The concrete harnesses and their owning work packages are in
[permissions-plan.md](../permissions-plan.md) §6–§7; the bullets below remain the guarantee.

* **Source scan for I/O primitives** — the test that finds the class of bug two reviews found: scan
  `crates/ln-runtime/src`, `crates/ln-io/src` and `crates/ln-sqlite/src` for `fs::read`, `fs::write`,
  `File::open`, `File::create`, `libc::open`, `libc::socket`, `Command::new`, `libc::kill` and
  `sqlite3_load_extension`, and fail when a hit is outside a declared allow-list of functions
  (the `Op` executor, `read_source`, the sqlite callbacks). `load_json_module`'s `read_to_string` and
  `sqlite3_load_extension` are both invisible to a JS reflection test; this one sees them.
* **Inventory** — a JS test enumerating `Object.getOwnPropertyNames(__ln_host)` and the privileged
  loader object's keys, failing on any name not classified gated, exempt or plumbing. Catches the
  surface growing, not the Rust paths above.
* **Matcher table** — `..` climbing, symlink escape, `/data` vs `/database`, an uppercase spelling of a
  granted path being denied, `*.host` not matching the apex, bare name vs full path for
  `child.spawn`, `open` with `O_RDONLY|O_CREAT` denied under a read-only grant, and `:0` not matching
  a request for `:8080` (or the reverse).
* **sqlite** — `readOnly: true` needs only `fs.read`; a read-write open needs `fs.write`; a symlinked
  `-wal`/`-shm`/`-journal` beside a granted database makes the open fail; `:memory:` needs nothing.
* **`deny_all` corpus** — the existing `fs`/`net`/`dns`/`child_process` corpus with a policy granting
  nothing, asserting every case fails with `ERR_ACCESS_DENIED`.
* **The loader** — `require("./secret.json")` and `await import("./secret.json")` both denied without
  a grant and allowed with one; `require("./module.js")` works with no grants at all.
* **The race** — a script that swaps a symlink continuously cannot read the target; the test asserts
  the opened path is the checked one, not merely that the submit-to-completion window is quiet.
* **Worker inheritance** — a worker spawned by a confined main thread cannot read a denied path, and a
  field added to `Config` that is not copied fails the test.
* **Denial shape** — the four properties survive the sync, callback and promise forms.
* **No-policy regression** — default runs unchanged, cold start inside the M0/M7 envelope, and the
  policy parse reported under `--timing` (a pre-digested blob is the follow-up only if it shows).

## 8. Closed questions

Five questions were open in the previous draft. They are decisions now, recorded where they apply:

1. **`net.listen` on port 0** — matched literally, never a wildcard; `:0` grants an ephemeral port on
   every interface, and `127.0.0.1:0` is the least-privilege form (§5.3).
2. **`process.env` writes** — not gated; the value only escapes into a child, which `child.spawn`
   already gates (§5.3).
3. **`sqlite`'s capability id** — `fs.read`/`fs.write` on the database path, with the side-file
   implication and the symlink refusal that come with it (§5.3, §5.4 row 11).
4. **Future native-addon paths** — `ffi.load` is defined by capability, not by API, so they inherit it
   (§5.3).
5. **`process.permission` while nothing is enforced** — present, `has` returns true (§5.9).

## 9. Consequences

* 1.0 ships the model switched off and documents it: no compatibility break, no cold-start
  regression, no dormant code in the release — every gate is exercised by the policy corpus before
  1.0 is cut.
* M8 is **≈4.8 eng-weeks** (24 days: the 22.5 below plus the schedule and docs work), up from the
  roadmap's original 1.5 for permissions. Two reviews added real work — a read chokepoint and an ESM
  loader rewrite, an fd table, eleven gated sites of the thirteen inventory rows, a source-scan
  test — and the original number was for a sketch that covered none of it.
* `ffi.load` covers every native-code route, so "one meaning per capability" stays true.
* New error codes and flags are onde extensions, not Node compat surface: a note in
  [compat.md](../compat.md) and a D-number when implemented, not before.
* The file format is a public contract from 1.0. Trailing-comma support is the likely request and is
  cheap; deny-lists are not, and §4.2 says why.

## 10. Work breakdown (M8)

Order matters: the refactors land first and are tested before any gate is wired, because both
criticals found in review were in the refactors, not in the gate calls.

| WP | Work | Est. |
|---|---|---|
| 1 | `ln-perm`: `Policy`/`Rule`/matcher, file parser, unit tables | 2.5 d |
| 2 | `read_source(path, Class)` chokepoint; move `load_json_module` and the CJS loader onto it; delete `host.readFile`/`realpath`/`statKind` | 2.5 d |
| 3 | Privileged loader object installed before the freeze, captured and deleted; loader rewrite against it | 1.5 d |
| 4 | Policy plumbing into `Op`/`Pool::submit`/`execute`; `Config::child_of`; fd table | 2 d |
| 5 | `fs` gate in `Op::execute` with the flag-mask rule; sync path; resolved-path open | 3 d |
| 6 | `net`/`dns` gates checked after resolution, in the tasks | 2 d |
| 7 | `child.spawn`, `kill`, `worker.spawn`, `env.read`, `sqlite` open/`backupInit`/extension loading/side-file checks | 3 d |
| 8 | `ERR_ACCESS_DENIED` with properties, `process.permission`, file:line in the message | 1 d |
| 9 | CLI: `--permission`, `--permission-file`, the `--allow-*` family, mutual exclusion, `VALUED` | 2 d |
| 10 | Tests: source scan, inventory, matcher, `deny_all` corpus, loader, race, inheritance | 3 d |

Total ≈ 22.5 engineering days of work packages, ≈24 with the schedule and docs delivery in
[permissions-plan.md](../permissions-plan.md) (~4.8 eng-weeks).

## 11. Deferred: compiled apps

A `ondec` binary maps argv to `process.argv` as `[exec, exec, …args]`, so it has no position for a
runtime flag, and `ln-payload` is documented as modules plus three engine facts and nothing else, so
the policy cannot ride in the payload either. The workable design is build-time: `ondec build --policy
FILE` emits the canonical policy as a byte array into the generated C launcher and `onde_main_payload`
takes it as an extra argument (`ONDE_ABI_VERSION` moves), with `NULL, 0` meaning "no policy" —
distinct from an empty array, which denies everything.

It is not scheduled: the ordinary compiled app has no untrusted code in it, so the policy protects
nothing; it earns its keep only when the binary `eval`s plugins, which is a product decision not yet
made. Two known-open details: relative grants have no meaningful base in a build-time blob (they would
be absolute at build), and `wrappe` stages files and spawns `onde`, so it would pass
`--permission-file` instead and inherits the signature caveat in
[standalone-build.md](../standalone-build.md).
