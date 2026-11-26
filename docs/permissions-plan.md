# Permissions (`--permission`) — implementation plan

This is the working contract for the opt-in permission model decided in
[ADR-0011](adr/0011-permissions.md): what it consists of, where each gate lives, in what order it
lands, and how it is tested. The ADR is the decision record; this document is the delivery plan and
the interface sketch the implementation is held to.

Status: **complete, 2026-11-25. Target: M8, before 1.0.** Phases 0–8 landed; §12 records what
shipped, where the implementation disagreed with this plan, and the evidence. ADR-0011 is accepted.
Where this document and the code disagree later, this document is the intent and the code is the
truth; update this file with the code in the same change.

The one change from the ADR is scheduling: the model moves from M9 (1.1) to M8, which lands before
the 1.0 hardening milestone. §2 records what that costs and which documents move with it. The model
itself is unchanged. Four points the ADR leaves under-specified are settled in §4 (D7, D8, D11,
D12) and listed for confirmation in §11.

## 1. What ships, in one table

| Area | Ships | Does not ship (documented) |
|---|---|---|
| Enabling | `--permission` (deny-all base), `--permission-file=FILE`, repeatable `--allow-*`; the file and the flags are mutually exclusive | deny-by-default, policy discovery, a `default` field |
| Capabilities | `fs.read`, `fs.write`, `net.connect`, `net.listen`, `net.resolve`, `child.spawn`, `worker.spawn`, `env.read`, `ffi.load` | per-request attenuation, stack-scoped grants, network byte filtering |
| Policy file | JSON with `//` and `/* */` comments, allow-lists only, rooted and realpathed, 1 MiB cap, group/world-writable refused | TOML, JSON5, trailing commas, deny-lists |
| Enforcement | 11 gated sites (ADR §5.4): `Op::execute`, `read_source(Data)`, net connect/listen after resolution, dns lookup, spawn, kill, worker spawn, env, sqlite open/backup/extension, stdio `writeFd` | seccomp/LSM, byte-level filtering, compiled apps ([§11](adr/0011-permissions.md#11-deferred-compiled-apps)) |
| Denial | `ERR_ACCESS_DENIED` with `capability`, `resource`, `policy`, file:line, in sync, callback and promise forms | a distinct errno; a new `node:` module |
| Introspection | `process.permission.has(scope, reference)`, read-only, always present | setters, a way to widen from JS |
| Inheritance | workers inherit through `Config::child_of`; a worker cannot widen | sealed child processes |
| Platform | macOS and Linux enforced; Windows best-effort (R8) | Windows path-identity guarantees |

Default runs are untouched: no flag, no policy, no branch beyond one `enforced` test per gated
call, no new syscall, no cold-start cost.

## 2. Schedule: permissions move before 1.0

### 2.1 Why the move

The ADR was written when 1.0 was allow-all and permissions were 1.1. That leaves 1.0 shipping a
release note that says "sandboxing arrives in 1.1" and a plugin host that cannot use the feature the
runtime was built for until after the release. The model is opt-in, so moving it earlier costs no
compatibility break: `onde app.js` behaves exactly as it does today. What it costs is **≈4.8
engineering weeks on the 1.0 critical path** (24 days: the ADR's 22.5 plus the schedule and docs
work this move adds), which is the trade being accepted.

### 2.2 Renumbering, and why it is not cosmetic

Milestones are ordered by dependency, and hardening now depends on permissions: the compat sweep has
to include the new flags and the new error code, the docs are generated from the final binary, and
the release checklist has to run with and without a policy. Keeping permissions at "M9" while it
runs before "M8" would make the map read out of order. So:

| Milestone | Before | After |
|---|---|---|
| M7 | Performance and diagnostics | unchanged |
| M8 | 1.0 hardening (2.5 w) | **Permissions (≈4.8 w)** |
| M9 | Permissions (4.5 w, 1.1) | **1.0 hardening (2.5 w)** |
| M10 | FFI (4 w, 1.1) | unchanged label, still FFI in 1.1 |

Consequences:

* The 1.0 total in [roadmap.md](roadmap.md) moves from ≈34 to **≈39 eng-weeks** (34 + 4.8); the
  1.1 line is M10 alone (4 w), not "M9–M10 (8.5 w)".
* FFI keeps its milestone number and its dependency on permissions, so [ffi-plan.md](ffi-plan.md)
  needs one sentence changed, not a rewrite.
* `ffi.load` is defined by this milestone and already has a consumer in 1.0: `node:sqlite`'s
  extension loader. M10 adds `process.dlopen` as another route to the same grant instead of
  inventing its own switch.

### 2.3 Document changes that belong to this move

| Document | Change |
|---|---|
| [ADR-0011](adr/0011-permissions.md) | §3 first bullet ("1.0 is allow-all") becomes "1.0 ships the model, off by default"; §9 consequences and the M9 effort line; §10 heading and table renumber to M8; §7 gains one sentence pointing at this plan's §6 and §7 for the concrete harnesses; the four §4 clarifications below are folded in as wording, not as new decisions |
| [roadmap.md](roadmap.md) | §0 gains criterion 10 (permission model green) and "the 9 criteria" becomes 10; §1 milestone map; M8/M9 section split and renumber; §6 decision-log row for 0011 becomes "proposed (M8)"; §4 staffing's "sequential M0→M8" becomes "M0→M9" |
| [ffi-plan.md](ffi-plan.md) | intro: "after the M9 permissions model" becomes "after M8"; §12 WP5 exit criterion already points at `--allow-ffi`, which now exists |
| [ADR-0008](adr/0008-processes-and-threads.md) | the note under its title says permissions move to 0011 "(1.1)"; the parenthetical becomes "M8, in 1.0" |
| [README.md](../README.md) | security/limitations section: `--permission` is available in 1.0, off by default; what it does not cover (child processes, compiled apps) |
| [js/README.md](../js/README.md) | the host surface table: `readFile`/`realpath`/`statKind` move to the privileged loader object or are deleted (D5) |
| [compat.md](compat.md) | a D-row added when the implementation lands, not before: new flags and error code are onde extensions |

The ADR stays `proposed` until Phase 8, where its status becomes `accepted (M8)` and this file gains
the Outcome section that [m7-plan.md](m7-plan.md#12-outcome-2026-11-24) uses for an executed
milestone. Accepted ADRs themselves carry no outcome section, only the status and date.

## 3. Where the code is today

The survey below is what the work packages are sized against. Every row names the function that has
to change, not a line that will move.

| Area | Today | What this plan changes |
|---|---|---|
| Configuration | `Config` in [lib.rs](../crates/ln-runtime/src/lib.rs) has flat public fields; built three times in [main.rs](../crates/ln-cli/src/main.rs) and once in [ln-embed](../crates/ln-embed/src/lib.rs) | add `permissions: Option<Policy>`; group the inheritable fields into `Inheritable`; `Config::child_of` |
| Worker inheritance | [workers.rs](../crates/ln-runtime/src/workers.rs) copies `io_threads`, `budget`, `max_old_space_size` field by field when it builds the worker's `Config` | one `child_of` call; a field added to `Inheritable` cannot be forgotten |
| Host install | [host/mod.rs](../crates/ln-runtime/src/host/mod.rs) `install` builds ~45 properties (75 `host.set` calls counting the submodule installers); [bootstrap.js](../js/bootstrap.js) freezes the object *before* the loader is evaluated, and the loader reads through that frozen object | move the loader's privileged reads to `__ln_loader`, install it before the freeze, delete it after the loader captures it |
| Module reads | `read_source` in [modules.rs](../crates/ln-runtime/src/modules.rs); `read_entry` in [lib.rs](../crates/ln-runtime/src/lib.rs); `host.readFile` in [host/mod.rs](../crates/ln-runtime/src/host/mod.rs); `host.readFile` called from three places in [loader.js](../js/lib/loader.js); `package.json` read in [ln-modules](../crates/ln-modules/src/package.rs) | one Rust `read_source(path, Class)`; `read_entry` folded into it; `host.readFile` deleted; `package.json` declared as metadata exemption and added to the source scan |
| Ops | `Op` (34 variants) in [ln-io/lib.rs](../crates/ln-io/src/lib.rs); `build_op` in [ops.rs](../crates/ln-runtime/src/ops.rs); sync path in [host/fs.rs](../crates/ln-runtime/src/host/fs.rs); `Pool::submit` and `execute` in [ln-io/lib.rs](../crates/ln-io/src/lib.rs) | policy and fd table ride to the pool thread; an exhaustive classifier; resolution and `O_NOFOLLOW` immediately before each syscall |
| Net | `Command::Listen/Connect` in [net.rs](../crates/ln-io/src/net.rs); resolution inside [connection.rs](../crates/ln-io/src/net/connection.rs) `resolve_connect`; bind candidates in [listener.rs](../crates/ln-io/src/net/listener.rs) `listen_addresses` | filter resolved candidates against the policy in the task; check unix-socket paths there too |
| DNS | [host/dns.rs](../crates/ln-runtime/src/host/dns.rs) submits `Op::Lookup`; [ln-io/dns.rs](../crates/ln-io/src/dns.rs) resolves | gate the name before the resolver; a connect name grant implies resolve |
| Children | [host/proc.rs](../crates/ln-runtime/src/host/proc.rs) → `ProcService::spawn` → `TokioCommand::new` in [proc.rs](../crates/ln-io/src/proc.rs) | resolve the program (PATH or path), gate on the resolved executable, spawn that path |
| Signals | `process.kill` is a sync `libc::kill` in [host/signal.rs](../crates/ln-runtime/src/host/signal.rs) | gate under `child.spawn` before the call |
| Workers | `host.worker` "spawn" in [host/worker.rs](../crates/ln-runtime/src/host/worker.rs) → `WorkerBridge::spawn` | gate `worker.spawn`; worker `Config` comes from `child_of` |
| Environment | `host.env` in [host/mod.rs](../crates/ln-runtime/src/host/mod.rs) returns every variable; `process.env` in [process.js](../js/lib/process.js); `util.getEnv` falls back to the primitive in [util.js](../js/lib/util.js) | filter in the primitive, so both consumers inherit the gate; no second path |
| SQLite | `host.sqlite` open/backupInit in [host/sqlite.rs](../crates/ln-runtime/src/host/sqlite.rs); `sqlite3_load_extension` in [ln-sqlite](../crates/ln-sqlite/src/database.rs) | read/write on the database path, side-file implication, symlink refusal, `ffi.load` for every extension route |
| stdio | `host.writeFd` in [host/stdio.rs](../crates/ln-runtime/src/host/stdio.rs); `StdioMode::Fd` in [ln-io/proc.rs](../crates/ln-io/src/proc.rs) | an fd table consulted by both; unknown fd fails |
| Errors | `NodeError` in [ln-error](../crates/ln-error/src/lib.rs); JS conversion in [host_error.rs](../crates/ln-runtime/src/host_error.rs) `node_error_object` | an optional denial payload, carried through the async completion path |
| Tests | conformance corpus in `test/conformance/`; per-area harnesses in `test/proc`, `test/js`, `test/features`; CI in [.github/workflows/ci.yml](../.github/workflows/ci.yml) | a `test/perm/` harness, the source scan, and a deny-all sweep |

Four surfaces are easy to miss, and the plan treats each explicitly:

1. **`read_entry` is a second direct read** in the runtime ([lib.rs](../crates/ln-runtime/src/lib.rs))
   with its own error rendering. It reads *source*, so it is exempt from `fs.read`, but it must go
   through the chokepoint or the "only `read_source` reads outside an Op" claim is false.
2. **`ln-modules` reads `package.json`** during resolution. That is resolution metadata and exempt,
   but it sits outside the three crates the ADR's source scan names. The scan covers it and the
   exemption is declared.
3. **`js/bootstrap.js` exposes loader globals** (`__ln_cjs_namespace`, `__ln_run_cjs`,
   `__ln_builtin_exports`, `__ln_meta_resolve`, …) that are reachable from user code. They load
   *source*, so they stay exempt, but the inventory test must enumerate them, not just `__ln_host`.
4. **Diagnostics are plumbing**: [trace.rs](../crates/ln-runtime/src/trace.rs) writes the trace file,
   [report.rs](../crates/ln-runtime/src/report.rs) reads a source file for a code frame, and
   [host/mod.rs](../crates/ln-runtime/src/host/mod.rs) reads `/proc/self/statm`. None is an
   authority the policy grants, and all three are declared in the source scan.

## 4. Decisions

These are the implementation choices the ADR leaves open. D1 needs approval; the rest are
recommendations for the same review and are cheap to change before Phase 1.

**D1 — Schedule.** M8 permissions, M9 hardening, M10 FFI, as in §2. This is the only change that
needs an explicit yes, because it moves ≈4.8 weeks onto the 1.0 path.

**D2 — `ln-perm` is a new engine-free, tokio-free crate** with `serde`, `serde_json` and
`json_comments` only. It owns `Policy`, `Rule`, `Capability`, `Origin`, the parser and the matcher;
it reads only its own policy file and never touches the engine, the runtime's I/O or a syscall on a
target. `ln-io` depends on it for the checks
that happen on the pool thread; `ln-runtime` depends on it for host-level gates; `ln-cli` depends on
it to build the policy. `ondec` can depend on it later without pulling the runtime in, which is why
it is not part of `ln-runtime`.

**D3 — The policy and fd table travel as one cloneable `Permit`.** `ln-io` gets:

```rust
#[derive(Clone)]
pub struct Permit(Arc<PermitInner>);   // { policy: Policy, fds: Mutex<FdTable>, enforced: bool }
```

`Config::permissions: Option<Policy>` is converted once, at isolate construction, into
`Permit::unconfined()` (`enforced: false`) or `Permit::new(policy)`. The `OpBridge` owns the
`Permit`, passes it into `Pool::with_permit(io_threads, permit.clone())` (the test-only
`Pool::new_unconfined` does not exist in production) and stores it for the sync path;
`Pool::submit` already moves the op to the pool thread, so the permit clone rides with it without
adding a field to `Op`. `Op::execute` keeps its plain-data shape and gains a `&Permit` argument;
`Op` itself stays policy-free, which keeps it serialisable in tests and avoids an `Arc` in every
construction. The net and proc tasks receive a `Permit` when they are spawned. `enforced == false`
is the single branch that makes default runs cost nothing; it is a field, not a second code path.

*Alternative considered and rejected*: a `policy: Option<Arc<Policy>>` on every `Op` variant. It
puts the policy in the op grammar, forces every constructor and test to name it, and makes an op a
different thing depending on who built it.

**D4 — One read chokepoint, `read_source(path, Class)`.** It lives in `modules.rs`, takes the
`Permit` and the resolved path, and returns the text or a JS error. `Class::Source` is exempt
(module code, entry source, CJS, ESM, builtins); `Class::Data` requires `fs.read` on the resolved
path. `read_entry` in `lib.rs` calls it with `Source` instead of `fs::read_to_string`, so there is
exactly one place in the runtime that opens a file outside an `Op`. `package.json` in `ln-modules`
stays a separate read and is declared as metadata rather than pretending it is not a read.

**D5 — The privileged loader object is installed before the freeze.** Rust sets a second global,
`__ln_loader`, holding `platform`, `builtinSource`, `builtinNames`, `builtinUnavailable`,
`nodeOnlyBuiltins`, `evalCjs`, `resolve`, `metaResolve`, `readSource` and `readData`; `bootstrap.js`
captures it in a closure variable, freezes `__ln_host`, evaluates `internal/loader` with the
captured object, calls `loader.install(host, privileged)`, then deletes the global. `evalInternal`
and every later `evalCjs` use the captured object, so nothing after the deletion needs the global.
The object is never a property of `__ln_host`: freezing happens first, and `delete` on a frozen
object is a no-op (sloppy) or a `TypeError` (strict). `host.readFile`, `host.realpath` and
`host.statKind` are deleted; the last two have no JS consumer today, and `readFile` moves to
`readSource`/`readData`. `cjsNamespace`, `builtinExports` and the other `__ln_*` wrapper globals
stay on `host`, because generated ESM facades call them; they load source, so they are
source-exempt and classified as loader plumbing in the inventory (D14).

**D6 — Path identity: resolve late, check resolved, open resolved.** For a path that exists,
`realpath` in the pool task immediately before the syscall; open the resolved path with
`O_NOFOLLOW` (via `OpenOptionsExt::custom_flags` on unix). For a create, resolve the nearest
existing ancestor, append the remaining components lexically, check that result, then `lstat`-walk
the components below the grant root and refuse a symlink while a policy is active. For
`follow: false` ops, resolve the parent directory and keep the final component unresolved, so the
check and the syscall both act on the link itself. `fs.read`/`fs.write` match a resolved path when
it equals the grant or starts with the grant plus a separator, byte for byte: no case folding, no
Unicode normalisation, no globs. `fs.write` does not imply `fs.read`; a call that needs both needs
both grants. A grant is canonicalised as far as it exists at parse
time (so a write grant for a not-yet-created directory still matches later); the matcher compares
absolute paths.

**D7 — Endpoint matching needs the ADR's wording clarified.** A
`net.connect`/`net.listen` grant can name a host (`api.example.com`, `*.example.com`), a literal
address (`127.0.0.1`, `[::1]`), or a Unix path, with an optional port. The check runs in the task,
after resolution, once per candidate endpoint:

```text
allow(host, port, address) :=
    rule matches (host, port)                 // a name grant, trusted as a name
 || rule matches (address, port)              // a literal grant, including a name that resolved to it
```

This is what makes "the address that is connected to is what is checked" true for literal grants
without making hostname grants useless. Consequences: a policy granting only `169.254.169.254`
denies a name that resolves elsewhere and permits one that resolves there; a policy granting
`api.example.com` trusts that name's DNS, including a later rebind (recorded as out of scope, like
the ADR's hard-link note). Denied candidates are skipped; when every candidate is denied the error
is `ERR_ACCESS_DENIED`, not the last connection error. `net.resolve` checks the requested name
before the resolver (a literal IP needs no grant), and a name-shaped `net.connect` grant implies
`net.resolve` for the same name; a `net.listen` grant likewise implies it for the bind host, since
`listen_addresses` resolves before binding. Unix sockets are matched as paths under
`net.connect`/`net.listen`, never `fs`. Port `0` is literal; there is no `*` port. `:8080` is
listen-only, and a bare host grants any port.

**D8 — `child.spawn` matches the resolved executable.** Resolve the program before the call: a
program containing a separator is resolved against the cwd and realpathed; a bare name is looked up
in `PATH` for a regular, executable file and realpathed; failure to find it stays `ENOENT` and is
not turned into a denial. A bare-name rule matches the resolved path's basename; a path rule matches
the resolved executable exactly (no directory grants, no globs). `fork` passes `process.execPath`,
so it is a path match. `exec`/`execFile({ shell: true })` run `/bin/sh`, which is the executable the
policy sees: a policy that grants only `git` does not permit a shell, and that is recorded as a
divergence with its security rationale. `process.kill` has no executable to match; it is allowed
when the policy has *any* `child.spawn` grant and denied by a deny-all policy. That is deliberately
coarse: a policy that grants process control has accepted signal authority, and inventing a
`child.kill` id would double the grammar for one call. A bare-name grant trusts whatever `PATH`
resolves to at spawn time; a policy that cares about identity uses the full path. Both are recorded
in `compat.md`. `child.kill()` on a handle the isolate spawned is implied by that spawn grant;
`Command::Kill` in `ln-io` therefore needs no separate check, only `process.kill` (D8's coarse
rule).

**D9 — The fd table lives with the permit.** It starts with `0` (read), `1`/`2` (write), `ipcFd`
(read and write), records every fd returned by a granted `Open` with the mode from its flags, and
removes it on a successful `Close`. A bare-fd op is allowed when the fd is present and the mode
permits it (`Fstat`/`Fsync`/`Fdatasync`/`Close` need membership only). `host.writeFd` consults the
same table; `StdioMode::Fd` refuses an fd the table does not know. The table is keyed by the raw
descriptor number, so a close-then-open reuse is a new entry, not a stale one. `host.write` to
0/1/2 remains the separate console primitive and is exempt, as the ADR says.

**D10 — Inheritance is structural, not a copied list.** `Config` gains

```rust
pub struct Inheritable {
    pub budget: Budget,
    pub io_threads: usize,
    pub max_old_space_size: Option<u64>,
    pub permissions: Option<Policy>,
}
```

and `Config::child_of(&self, argv) -> Config` does `self.inheritable.clone().into_config(argv)`
plus the per-isolate defaults. A field added to `Inheritable` is inherited by construction; a field added to
`Config` outside it is per-isolate by construction. This is the only version of the ADR's "a field
added later cannot be forgotten" that Rust can actually enforce; a field-by-field copy plus a test
cannot see a new field. The public `Config` fields that move are `budget`, `io_threads`,
`max_old_space_size` and `permissions`; the CLI, `ln-embed` and the tests are updated in the same
change.

**D11 — A denial carries an origin with a line where one exists.** `Origin` is
`CommandLine` or `File { path, capability_line: Option<u32> }`. The parser strips comments with
`json_comments` (which replaces them with spaces, so `serde_json`'s line and column stay true) and
runs a small span pass over the stripped text that records the line of each capability key. A denial
for a capability that is present cites that line; a capability that is absent cites the file without
a line. Parse errors keep `serde_json`'s line/column and are fatal. The span pass is only a line
index, not a second parser; if it ever fails on a file `serde_json` accepted, the denial falls back
to the file path with no line rather than failing the run.

**D12 — `process.permission.has(scope, reference)`.** The scope is one of the nine capability ids;
the two Node spellings `child` and `worker` are accepted as aliases for `child.spawn` and
`worker.spawn`, because scripts written for Node use them. A non-string scope throws
`ERR_INVALID_ARG_TYPE`; an unknown string scope returns `false`, which is what Node 26 does. The
ADR's §5.9 premise that "Node always has it" is wrong on the Node we test against: `process.permission`
is `undefined` without `--permission` and an object under it (measured 2026-11-25, node v26.12.1).
The decision still stands, but its reason does not: the object is kept present because a
feature-detect from inside the sandbox tells a script nothing ("not enforced" and "allowed" are the
same answer), not because Node is compatible. Phase 0 corrects the premise and keeps the decision.
`reference` is validated by the same matcher (`fs.read`, `fs.write` take a path and resolve it the
way a gate would, including the nearest-existing-ancestor rule for a path that does not exist yet;
net scopes take `host[:port]`; `env.read` takes a name; the boolean capabilities ignore it). With no
policy the object is present and `has` returns `true` for every well-formed query.

**D13 — The source scan is a Rust test with a function allow-list, not line markers.** A new test in
`ln-runtime`'s `tests/` walks the source of `ln-runtime`, `ln-io`, `ln-sqlite` and `ln-modules`,
skips `#[cfg(test)]` modules by brace counting, finds the enclosing function name for every hit of
`fs::read`, `fs::read_to_string`, `fs::write`, `fs::read_dir`, `fs::read_link`, `fs::metadata`,
`fs::symlink_metadata`, `fs::rename`, `fs::remove_file`, `fs::remove_dir_all`, `fs::create_dir`,
`fs::set_permissions`, `fs::copy`, `File::open`, `File::create`, `OpenOptions`, `libc::open`,
`libc::socket`, `Socket::new`, `TcpListener::bind`, `UnixListener::bind`, `lookup_host`,
`Command::new`, `libc::kill`, `sqlite3_load_extension`, and fails
unless `(crate, file, function)` is in an explicit allow-list in the test source with a one-line
reason. A reviewer sees the list grow in the diff. Line markers were the alternative; they rot
silently when a file is reformatted and they invite a marker on the wrong line.

**D14 — Exemptions are written down where the code is.** `host.write` to 0/1/2, `host.chdir`, the
informational getters, timers, the `async_*` hooks, `exit`/`setExitCode`, IPC send, the compute
calls and `host.signal` get a `// perm: exempt — <reason>` comment at the registration site and a
row in the inventory's classification table. The inventory fails on an unclassified `__ln_host`
property or `__ln_loader` key, so the surface cannot grow silently. It is two tests: a JS test over
`__ln_host` and the user-visible `__ln_*` globals, and a Rust test over the `__ln_loader` key set,
which is declared as one `const` array and installed from it (the global is gone before a user
script can enumerate it).

## 5. Interfaces

### 5.1 `ln-perm`

```rust
#[derive(Clone)]
pub enum Capability { FsRead, FsWrite, NetConnect, NetListen, NetResolve,
                      ChildSpawn, WorkerSpawn, EnvRead, FfiLoad }

#[derive(Clone)]
pub struct Policy { /* [CapabilityGrant; 9] */ }
impl Policy {
    pub fn deny_all() -> Policy;
    pub fn any() -> Policy;                        // Rule::Any everywhere; tests and benches only
    pub fn grant(&mut self, capability: Capability, rule: Rule, origin: Origin);
    pub fn check(&self, request: &Request<'_>) -> Result<(), Denial>;
    pub fn from_file(path: &Path) -> Result<Policy, ParseError>;   // security checks included
    pub fn from_args(args: &GrantArgs) -> Result<Policy, ParseError>;
}

pub enum Rule { Any, Path(PathRule), Endpoint(EndpointRule), Exec(ExecRule), Name(String) }

pub enum Request<'a> {
    Path { capability: Capability, resolved: &'a Path },
    Endpoint { capability: Capability, host: Option<&'a str>,
               port: u16, address: Option<&'a SocketAddr> },
    Executable { resolved: &'a Path },
    Env { name: &'a str },
    Toggle { capability: Capability },
}

pub struct Denial { pub capability: Capability, pub resource: String, pub origin: Origin }

// The CLI's parsed values, kept clap-free so `ln-perm` has no argument-parsing dependency.
pub struct GrantArgs { /* paths, endpoints, executables, env names, two toggles */ }
```

The matcher is pure and unit-tested against a table (D6/D7); `ln-io` supplies resolved paths and
addresses and turns `Denial` into the error. `Policy::any()` is a value, not a variant: the ADR's
"no allow-all variant" is about the enum shape, and an all-`Any` policy is the fast path that tests
and benches need. `Policy` is `Clone` because a worker's `Inheritable` clones it; the clone happens
once per worker spawn, and every check is an immutable borrow.

### 5.2 The policy file

The grammar is the ADR's §5.2 exactly. Parse rules:

* Unknown keys, unknown capability names, wrong types, a non-array where an array is required, a
  non-boolean for `worker.spawn`/`ffi.load`, and a non-string rule are errors.
* An absent key denies. `{}` is `--permission` with no grants. There is no `default`.
* `env.read` entries are exact variable names: no prefixes, no wildcards. A name that is not listed
  is not in `process.env`.
* Relative path grants and relative Unix-socket grants resolve against the policy file's directory
  after `realpath`, never the cwd. The file itself is realpathed, must be a regular file, at most
  1 MiB, and must not be group- or world-writable on unix. Any failure is fatal; there is no
  implicit allow-all fallback.
* Entries are `Origin::File` with the capability key line (D11).
* The parser is `serde` over the comment-stripped text with `deny_unknown_fields`; `json_comments`
  uses `CommentSettings::c_style()` (`#` comments off, trailing commas unsupported).

On the command line one flag per capability id, repeatable, in the same grammar:

```sh
onde --permission \
     --allow-fs-read=./data --allow-fs-read=/usr/share/zoneinfo \
     --allow-fs-write=./cache \
     --allow-net-connect=api.example.com:443 --allow-net-listen=:8080 \
     --allow-child-process=git --allow-env=PORT plugin.js
```

Flag grants resolve against the cwd; their origin is `CommandLine`. `--permission` with neither a
file nor a flag is `Some(Policy::deny_all())`. A file and any flag together is a usage error
(exit 1) naming both channels. Every value-taking flag is added to `VALUED` in `main.rs`
(`--permission-file` plus the seven value-taking `--allow-*`; the two booleans need no
entry), or the script path is swallowed by the
`with_script_terminator` pre-scan.

### 5.3 The denial object

```text
ERR_ACCESS_DENIED: fs.read is denied for '/etc/passwd' by ./ci.json:4
```

The JS object has `name: "Error"`, `code: "ERR_ACCESS_DENIED"`, `capability`, `resource`, `policy`
(the origin's display string) and the message above. `NodeError` gains
`denial: Option<DenialPayload>`; `node_error_object` sets the three properties after `code`, so the
same conversion serves the sync throw, the callback and the promise form. A nonexistent path still
reports `ENOENT`: the check runs after resolution, so a denied *existing* resource never reports
success or a misleading errno.

### 5.4 `process.permission`

`process.permission` is a frozen object with one method, `has(scope, reference)`, backed by
`host.permissionHas`. It is installed unconditionally, including when no policy is active (D12).
No JS call moves the policy: the permit is `Arc`-owned by the isolate and never exposed.

## 6. Phases and work packages

Phases are in dependency order, and each one lands green on its own: the refactors are tested before
a gate is wired, because both criticals found in the ADR's reviews were in the refactors. Days are
engineering days and sum to 24: the ADR's 22.5 of work packages, plus 0.5 for the schedule edits in
Phase 0 and 1 for the docs and CI wiring the ADR's WP table does not budget.

| Phase | WPs | Days | Depends on | Exit criterion |
|---|---|---|---|---|
| 0 | Contract and schedule | 0.5 | — | ADR, roadmap, ffi-plan and README agree on M8/M9 and the 1.0 posture |
| 1 | `ln-perm` | 2.5 | — | `cargo test -p ln-perm` green; no runtime dependency in its `Cargo.toml` |
| 2 | Read chokepoint and loader | 4 | 1 | no `__ln_host.readFile`; JSON data denied by a policy, module source allowed by none |
| 3 | Policy plumbing, inheritance, fd table | 2 | 2 | default corpus unchanged; `Config::child_of` test; fd table unit tests |
| 4 | `fs` gate | 3 | 3 | `deny_all` fs corpus is `ERR_ACCESS_DENIED`; race test green |
| 5 | Host gates | 5 | 3 | every row of ADR §5.4 has a test that denies and a test that allows |
| 6 | CLI | 2 | 1, 5 | flag matrix, mutual exclusion and `VALUED` tests green |
| 7 | Denial surface and `process.permission` | 1 | 4, 5 | four properties in sync, callback and promise forms |
| 8 | Scan, corpus, docs, CI | 4 | 4–7 | CI green on both OSes; ADR accepted; Outcome section written |

Critical path: 1 → 2 → 3 → 4 → 5 → 7 → 8. Phase 6 can start once Phase 1 has the parser and finish
once Phase 5 has gates to exercise, and WP8.1's scan can start as soon as Phase 4 has moved the last
`ln-io` read. Phase 5's five capability areas are independent of each other and can be split between
engineers once Phase 3 is in.

### Phase 0 — Contract and schedule (0.5 d)

* Amend ADR-0011 per §2.3, including the four clarifications D7/D8/D11/D12 as wording in §5 and the
  renumber in §10. Do not change the decision itself. Correct §5.9's premise that Node always has
  `process.permission`: it is `undefined` without `--permission` on Node 26, and the decision to keep
  it present is justified by what a script can learn from it, not by Node compatibility (D12).
* Update roadmap §0 (criterion 10), §1, the M8/M9 sections and the decision log; ffi-plan intro;
  README security note; js/README host table gets the final shape in Phase 2, not here.
* Exit: a reader of the roadmap and the ADR cannot tell that permissions were ever scheduled after
  the release, except in the decision log's history.

### Phase 1 — `ln-perm` (2.5 d)

**WP1.1 — Crate and model (0.5 d).** `crates/ln-perm`: `Capability`, `Policy`,
`CapabilityGrant`, `Rule`, `PathRule`, `EndpointRule`, `ExecRule`, `Origin`, `Denial`, `Request`,
`Policy::deny_all`/`any`/`grant`. No engine, no tokio, no runtime dependency. Add to the workspace
members and `deny.toml` review (`json_comments` is Apache-2.0, already allowed).

**WP1.2 — Parser and file security (1 d).** `from_file`, `from_args`, the comment strip, the security
checks, `deny_unknown_fields`, relative-root resolution, the span pass (D11), `ParseError` with
line/column. Security tests: a directory, a missing file, a >1 MiB file, a 0o664 and a 0o666 file (unix), an
unknown key, a wrong type, `#` comments rejected, a trailing comma rejected, a relative grant
resolving against the file's directory after a `..` in the path. A symlinked policy file is
resolved, not refused: its grants root at the target's directory (the sudoers rule is about the
file being writable, not about being a link).

**WP1.3 — Matchers (1 d).** Path prefix (`/data` vs `/database`, `..` climbing, trailing separator),
case-sensitive denial of an uppercase spelling, endpoint (`*.example.com` not apex, bare host any
port, `:8080` listen-only, port `0` literal, IPv6 bracket form, unix path), executable (basename vs
full path), env exact, toggles. The ADR §7 matcher table becomes a `#[test]` table here, before any
gate calls it.

**Exit:** `cargo test -p ln-perm` green; the parser fuzz corpus (a handful of hand-written
malformed files) produces errors, never panics; the crate's dependency tree is `serde`,
`serde_json`, `json_comments`.

### Phase 2 — Read chokepoint and loader (4 d)

**WP2.1 — `Permit` skeleton and `read_source` (1.5 d).** Add `ln_io::Permit` (D3) now, because the
chokepoint is its first consumer: `unconfined()`, `new(policy)`, `enforced()`, `policy()`, with the
fd table left as a stub for Phase 3. Then move the read function in
[modules.rs](../crates/ln-runtime/src/modules.rs) to `read_source(path, Class, &Permit)`;
`Class::Source` exempt, `Class::Data` gated. Call it from `load_json_module`, `load_esm_module`,
`load_cjs_facade`, and the CJS/entry paths. Fold `read_entry` in
[lib.rs](../crates/ln-runtime/src/lib.rs) into the same function so the runtime has one read site
outside `Op`. Pass the class from the resolver's format rather than inferring it from the extension.

**WP2.2 — Privileged loader object (2 d).** Rust installs `__ln_loader` (D5); `bootstrap.js` captures
it before `Object.freeze(host)`, passes it to `install`, and deletes the global after the loader has
captured it. Rewrite [loader.js](../js/lib/loader.js) to use `privileged.readSource`/`readData`
instead of `host.readFile`; move `platform`, `builtinSource`, `builtinNames`, `builtinUnavailable`,
`nodeOnlyBuiltins`, `evalCjs`, `resolve`, `metaResolve` onto it. Delete `host.readFile`,
`host.realpath` and `host.statKind`; update [js/README.md](../js/README.md).

**WP2.3 — Loader tests (0.5 d).** `require("./secret.json")` and `await import("./secret.json")`
denied with a policy that grants nothing, allowed with `fs.read` on the file or its directory;
`require("./module.js")` works with no grants; a CJS file that requires a JSON file is denied at the
data read, not at the source read. These become the first cases in `test/perm/cases/`, run with
explicit flags by the runner that Phase 8 wires into CI; `test/conformance/` stays flag-free.

**Exit:** `grep` finds no `host.readFile`; a script that calls `__ln_host.readFile` gets
`undefined`/`TypeError`, not a file; the `__ln_loader` key set is one `const` list, and the deleted
global leaves no property on `__ln_host` (the Rust key-set test and the JS inventory that enforce
this land in Phase 8).

### Phase 3 — Policy plumbing, inheritance, fd table (2 d)

**WP3.1 — `Config` and the finished `Permit` (0.5 d).** Add `Config.inheritable: Inheritable` (D10),
with `budget`, `io_threads`, `max_old_space_size`, `permissions`; `Config::child_of`; update
[main.rs](../crates/ln-cli/src/main.rs) (three construction sites),
[ln-embed](../crates/ln-embed/src/lib.rs) and the tests. Finish `Permit` in `ln-io` (D3) with the fd
table slot and the `Clone` semantics.

**WP3.2 — Plumb it to the pool and tasks (1 d).** `OpBridge` owns the `Permit`; `Pool::new` takes it;
`Pool::submit` clones it into the blocking closure; `ln_io::execute` takes `&Permit`; the sync
`host.fsSync` path and `host.dnsAsync` pass it; `NetService` and `ProcService` receive it at
construction. Default builds construct `Permit::unconfined()` and the existing tests pass an
`unconfined` permit, so no test grows a policy by accident.

**WP3.3 — fd table (0.5 d).** `ln-io::FdTable` with entries and modes (D9); boot entries from the
isolate (`0`, `1`, `2`, `ipcFd`); record on `Open` success, remove on `Close`; `writeFd` and
`StdioMode::Fd` consult it. Unit tests: unknown fd fails, read on a write-only fd fails, close then
reuse is a new entry.

**Exit:** `cargo test --all` green with no policy; the `Config`-moved fields compile everywhere; the
`child_of` test shows a worker receiving the policy, budget and heap cap, and a per-isolate field
(`expose_require`, `diagnostics`) not being inherited; a new field added to `Inheritable` is
inherited by construction, not by a copied list.

### Phase 4 — `fs` gate (3 d)

**WP4.1 — Classification (0.5 d).** An exhaustive `fn check(&self, permit) -> Result<(), NodeError>`
over `Op` with no wildcard arm, so a new variant fails to compile until classified. Use the ADR §5.5
table: read/write/both-path/fd/lookup, `Open` classified by a write-bit mask (not `O_ACCMODE`), and
`follow: false` handled per path. Two path-shaped ops need a deliberate mapping: `CopyFile` reads
the source and writes the destination, `Rename` writes both, `Link` writes both, `Symlink` writes
only the link path, and `Mkdtemp` writes the prefix's *parent* (the created name is unknown at
submit time).

**WP4.2 — Resolution and the gate (1.5 d).** One helper per shape: `read_path`, `write_path`,
`create_path`, `two_path`; each resolves late, checks, and opens the resolved path with
`O_NOFOLLOW`. Create walks the nearest existing ancestor and lstat-checks components below the grant
root. Patch every op helper in [ln-io/lib.rs](../crates/ln-io/src/lib.rs) to use them; the fd ops
consult the table. The syscall must consume the resolved path the check validated; a re-resolve
after the check is a bug the race test is written to catch.

**WP4.3 — Denial on the async path (0.5 d).** The `NodeError` carries the denial payload from the op
thread through `OpDone::Err` and `node_error_object` in the completion phase, so a callback form
sees the same properties as the sync form (the payload plumbing is shared with Phase 7).

**WP4.4 — Tests (0.5 d).** The matcher table's fs rows against `ln_io::execute` with a permit; the
deny-all fs sweep; the symlink race (a script swapping a symlink cannot read the target, and the
open fails rather than following); `O_RDONLY|O_CREAT` denied under a read-only grant; `Stat` with
`follow: false` allowed when the link itself is granted even though its target is not.

**Exit:** the fs portion of the deny-all corpus is `ERR_ACCESS_DENIED`; the no-policy fs corpus is
byte-identical; the new `ln-io` I/O sites are enumerated for Phase 8's source scan.

### Phase 5 — Host gates (5 d)

**WP5.1 — Network (1.5 d).** `Permit` into `NetService`; in `connect_tcp` filter each candidate
address with `Permit::check(Request::Endpoint { host, port, address })`; in `listen_addresses` filter the
bind candidates the same way; unix sockets check the resolved path under `net.connect`/`net.listen`;
`net.resolve` is checked in the connect task before `resolve_connect` and in `Op::Lookup`; a
name-shaped connect grant implies resolve. Tests: `*.internal.example.com` not apex, `:0` vs
`:8080`, a name resolving to `127.0.0.1` under an IP grant, a denied candidate skipped while an
allowed one connects, unix socket denied by an fs grant.

**WP5.2 — Children and signals (1 d).** Resolve the program (D8) in `ProcService::spawn` before
`TokioCommand::new`, check `child.spawn`, spawn the resolved path; gate `host.kill` on any
`child.spawn` grant (D8); `exec`/shell note in `compat.md`. Tests: bare `git` granted by a basename
rule, `/usr/bin/make` granted by path, a `PATH` shim named `git` matched by the basename rule (the
documented cost of a bare-name grant; a path grant is not), `fork`
granted by `process.execPath`, `process.kill` denied by deny-all, `exec` denied when only `git` is
granted.

**WP5.3 — Workers (0.5 d).** Gate `host.worker` "spawn" before `WorkerBridge::spawn`; the worker's
`Config` comes from `child_of`; a worker cannot widen even if its script calls
`process.permission.has`. Test: a confined main spawns a worker that tries a denied read and fails;
a worker's `Config` inherits the policy.

**WP5.4 — Environment (0.25 d).** Filter `host.env` to granted names; `process.env` and
`util.getEnv` inherit it because both read the primitive. Test: `process.env.PORT` absent without
`env.read`, present with it; `JSON.stringify(process.env)` has no ungranted key; `util.inspect`'s
`NO_COLOR` probe sees nothing when it is not granted, which is the correct fail-closed behaviour
and is recorded in `compat.md`.

**WP5.5 — SQLite and stdio (1.25 d).** `open`: `:memory:` exempt, `fs.read` on the path, `fs.write`
when not `readOnly`, side files implied, symlinked `-journal`/`-wal`/`-shm` refused; `backupInit`
needs `fs.write` on the target; `allowExtension: true`, `enableLoadExtension(true)` and
`loadExtension(path)` need `ffi.load`; `writeFd` consults the fd table, and `StdioMode::Fd` refuses
an unknown fd. Tests per row of ADR §7's sqlite bullet.

**Exit:** every row of ADR §5.4 has a deny test and an allow test; the exempt list is written in
code next to each registration (Phase 8's inventory enforces it); `test/proc/run.sh` and the
net/sqlite conformance suites pass with no policy.

### Phase 6 — CLI (2 d)

**WP6.1 — Flags (1 d).** clap fields: `--permission` (bool), `--permission-file` (`Option<PathBuf>`),
seven value-taking `--allow-*` (`Vec<String>`: fs-read, fs-write, net-connect, net-listen,
net-resolve, child-process, env) and the two booleans `--allow-worker`/`--allow-ffi`, with the
mutual-exclusion check after parse (clap's `conflicts_with` cannot express "any of nine"). Add
`--permission-file` and the seven value-taking flags to `VALUED`; a boolean has no next token to
protect. Every `Config` built by `run_file`, `run_eval` and `run_tests` gets the policy from one
helper.

**WP6.2 — Behaviour and errors (1 d).** `--permission` alone → deny-all; `--permission-file` →
`Policy::from_file`; a bad file → exit 1 with `onde: permissions: <path>:<line>:<col>: <message>`
and no isolation; a flag + a file → usage error naming both; `--permission-file` with no
`--permission` → usage error (the ADR makes `--permission` the switch); a relative `--allow-*` path
resolves against the cwd. The parse is reported under `--timing` as one phase line.

**WP6.3 — Flag matrix test (part of 6.2).** `test/perm/cli.sh`: each usage error, each accepted
combination, `--` before the script, `--allow-fs-read` with a space and with `=`, and a script path
that looks like a flag.

**Exit:** `test/perm/cli.sh` green; `onde --help` documents the eleven flags; `--permission` with a
policy file and with flags produce identical policies for the same grants (one test, two doors).

### Phase 7 — Denial surface and `process.permission` (1 d)

**WP7.1 — Payload (0.5 d).** `NodeError.denial: Option<DenialPayload>`; `node_error_object` sets
`capability`, `resource`, `policy`; the async completion path carries it (shared with WP4.3); the
message names the origin. Unit test: `NodeError` equality and cloning still hold; the properties
exist on sync, callback and promise forms.

**WP7.2 — `process.permission` (0.5 d).** `host.permissionHas(scope, reference)`; `process.js`
installs a frozen `permission` object (D12); unknown scope `false`, non-string `TypeError`, booleans
ignore `reference`; no policy → `true` for every well-formed query. Test: the same scope/reference
pairs as the matcher table return the same answers the gates enforce, including a resolved path and
a denied uppercase spelling.

**Exit:** ADR §7's "denial shape" bullet green; `process.permission` present with and without
`--permission`; no JS call can move the policy (the object is frozen and backed by `Arc` state).

### Phase 8 — Scan, corpus, docs, CI (4 d)

**WP8.1 — Source scan (1 d).** The Rust test in D13, with the allow-list covering the `Op` executor
helpers, `read_source`, `ln-modules`'s package reader and the sqlite callbacks; test modules
excluded. Mutation check: temporarily remove one allow-list entry and one gate, confirm the scan and
the deny-all corpus fail.

**WP8.2 — Inventory and deny-all corpus (1.5 d).** The two inventory tests of D14 (JS for
`__ln_host` and `__ln_*`, Rust for the `__ln_loader` key set), with the gated/exempt/plumbing
table. `test/perm/deny-all.sh` runs
the existing `fs`, `net`, `child_process`, `workers` and `sqlite` conformance suites under
`--permission` and a deny-all policy, with a recorded manifest: a case either exits 0 with no I/O
(the pure-compute ones) or fails with `ERR_ACCESS_DENIED`; a case that fails with `ENOENT` for a path
it was supposed to reach, or succeeds on a side effect, fails the sweep. The manifest makes the
expected failure set reviewable and diffs when a case changes.

**WP8.3 — Docs and CI (1.5 d).** `compat.md` D-row (flags, error code, `process.permission`, the
`fs.write`-does-not-imply-read rule, the sqlite side-file rule, `exec` needing a shell grant);
README security section; js/README final host table; the ADR's `accepted (M8)` status; this plan's
Outcome section (what shipped, where the implementation disagreed, the with-policy numbers);
roadmap M8 marked complete. CI: add `test/perm/run.sh` (CLI matrix, inventory, deny-all sweep, the
targeted permission corpus) to `.github/workflows/ci.yml`, after the conformance leg so it reuses
the binary. `cargo deny check` stays green with `json_comments`.

**Exit:** the acceptance list in §10 is green on macOS arm64 and Linux x86_64; one PR-sized change
per phase, each with its own test evidence recorded in this document.

## 7. Verification

ADR §7 is the guarantee; this table is where each bullet becomes a test.

| ADR §7 bullet | Lands in | Owning phase |
|---|---|---|
| Source scan for I/O primitives | `crates/ln-runtime/tests/permissions_scan.rs` (D13) | 8 |
| Inventory of `__ln_host` and the privileged object | `test/perm/cases/inventory.js` for the host and `__ln_*`; the `__ln_loader` key set is a debug guard in `host::install` (D14) | 2, 8 |
| Matcher table | `crates/ln-perm/src/…` unit tests; gate-level repeats in `ln-io` | 1, 4 |
| sqlite | `crates/ln-runtime/src/lib.rs`: `sqlite_*` tests (open, readOnly, side files, extension, `file:` URI) | 5 |
| `deny_all` corpus | `test/perm/deny-all.sh` + manifest | 8 |
| The loader | `crates/ln-runtime/src/lib.rs`: `a_confined_isolate_denies_json*` tests | 2 |
| The race | `test/perm/race.js` (spawned by the harness; skipped on Windows) | 4 |
| Worker inheritance | `crates/ln-runtime/src/workers.rs`: `a_worker_inherits_the_permission_policy`, plus the `child_of` unit test | 3, 5 |
| Denial shape | `crates/ln-runtime/src/lib.rs`: `the_denial_properties_survive_all_three_forms` | 7 |
| No-policy regression | the conformance corpus (253 cases) and the CLI matrix's no-flag cases; no separate script | 3, 8 |

The denial shape test asserts the four properties on the three forms; the callback and promise forms
go through `__ln_op_done` and `node_error_object`, not a JS wrapper, so they are separate code paths
worth asserting separately.

Cold start: the M7 envelope (<15 ms hello-world, <25 ms with `http`) is measured with and without
`--permission`. Without a flag the test is a regression gate (the `enforced` branch); with a flag it
is a new number recorded in this plan's Outcome, not a gate until there is a policy file to parse.

## 8. Risks

| ID | Risk | Impact | Mitigation | Trigger |
|---|---|---|---|---|
| P1 | ≈4.8 weeks on 1.0 delays the release | Schedule | The move is the decision; the model is opt-in so it cannot break users; no phase is cut without removing a §1 table row and recording it | M8 misses its exit date by > 1 week |
| P2 | A bypass the tests do not see (the ADR's reviews found two) | Security | Source scan + deny-all corpus + reviewer checklist for every new host property; the inventory test fails on unclassified surface | Any new `host.set` without a table row |
| P3 | `host.readFile` deletion breaks an untested loader path (worker eval, CJS facade, `-e` require) | Loader regression | Fold `read_entry`; conformance modules and the `-e` tests; the privileged object carries everything the loader needs, and the list is in the ADR | A module case fails after Phase 2 |
| P4 | Extra syscalls slow fs with a policy | Perf (only opt-in) | Resolve once per op, no canonicalisation on the fast `Rule::Any` path; measure with a policy and record | fs ratio with a policy worse than 1.5x Node |
| P5 | fd-table races or bad reuse | Security / correctness | Mutex table, close removes, open records; `writeFd`/`StdioMode::Fd` tests; fd numbers are per-isolate | Any unknown-fd test flake |
| P6 | net name-vs-address semantics surprise a reviewer | Design | D7 written down and tests for both directions; DNS rebinding listed as out of scope | ADR review rejects D7 |
| P7 | Span pass misreports a line | UX only | Falls back to file-only; parse errors still exact; tests on a fixture file | A denial line that does not match the policy file |
| P8 | Windows path/mode checks diverge | Platform | Gate the unix-only checks with `cfg(unix)`, keep Windows best-effort, document | A Windows test that assumes mode bits |
| P9 | `exec`/`fork` semantics under a policy confuse users | Compat | `compat.md` D-row: shell is the executable, `fork` is `spawn`, child processes are not confined | Two user reports in the first month |
| P10 | Policy format ships and then needs a breaking change | Contract | Allow-lists only, no `default`, no trailing commas; changes are additive; record the format in `compat.md` | A requested feature that cannot be additive |

## 9. File map

```
crates/ln-perm/                     new: Capability, Policy, Rule, matcher, parser, spans, tests
crates/ln-io/src/perm.rs            new: Permit, FdTable, fs path resolution/gate helpers
crates/ln-io/src/lib.rs             Op::execute permission-aware; Pool::new/submit; op helpers
crates/ln-io/src/dns.rs             net.resolve before getaddrinfo
crates/ln-io/src/net.rs             Permit through the service; target types unchanged
crates/ln-io/src/net/connection.rs  candidate filtering before connect_one
crates/ln-io/src/net/listener.rs    bind candidate filtering
crates/ln-io/src/proc.rs            program resolution, child.spawn gate, StdioMode::Fd check
crates/ln-runtime/src/lib.rs        Config/Inheritable/child_of, read_entry, HostState.permit
crates/ln-runtime/src/ops.rs        build_op unchanged; OpBridge owns Permit
crates/ln-runtime/src/modules.rs    read_source(path, Class, permit)
crates/ln-runtime/src/workers.rs    child_of; worker.spawn gate
crates/ln-runtime/src/host/mod.rs   env filter; readFile/realpath/statKind removal; __ln_loader
crates/ln-runtime/src/host/fs.rs    sync/async pass the permit
crates/ln-runtime/src/host/net.rs   command entry passes the permit to the service
crates/ln-runtime/src/host/dns.rs   lookup gate
crates/ln-runtime/src/host/proc.rs  spawn gate
crates/ln-runtime/src/host/signal.rs kill gate
crates/ln-runtime/src/host/worker.rs spawn gate
crates/ln-runtime/src/host/sqlite.rs open/backup/extension gates, side-file checks
crates/ln-runtime/src/host/stdio.rs writeFd through the fd table
crates/ln-runtime/src/host_error.rs denial payload → JS properties
crates/ln-runtime/src/bootstrap.rs  __ln_loader handoff
crates/ln-error/src/lib.rs          DenialPayload, ERR_ACCESS_DENIED constructor
crates/ln-cli/src/main.rs           flags, VALUED, mutual exclusion, policy construction
crates/ln-embed/src/lib.rs          Inheritable construction
crates/ln-modules/src/package.rs    declared exemption, no behaviour change
js/bootstrap.js                     capture/delete __ln_loader; freeze order; process.permission
js/lib/loader.js                    privileged reads; no host.readFile
js/lib/process.js                   process.permission
js/lib/child_process.js             no change expected; shell/fork note in compat
crates/ln-runtime/tests/permissions_scan.rs   source scan (D13)
test/perm/                          run.sh, cli.sh, deny-all.sh, deny-all.expected, race.js
test/perm/cases/inventory.js        host surface inventory (JS)
crates/ln-runtime/src/lib.rs        permission end-to-end tests (fs, net, dns, child, env, sqlite, denial, has)
crates/ln-runtime/src/workers.rs    worker policy inheritance
.github/workflows/ci.yml            test/perm/run.sh step
docs/adr/0011-permissions.md        amended; accepted (M8)
docs/roadmap.md, docs/ffi-plan.md, docs/compat.md, README.md, js/README.md   schedule/docs
```

## 10. Acceptance

Permissions are done when all of the following hold in CI on macOS arm64 and Linux x86_64:

1. `cargo fmt`, `cargo clippy --all-targets -D warnings`, `cargo test --all` and `cargo deny check`
   are green, including `ln-perm` and the source scan.
2. The flag matrix passes: `--permission` alone, `--permission-file`, every `--allow-*`, both
   channels rejected, a bad file fatal, `--` before the script, a script path that looks like a
   flag.
3. The deny-all sweep fails every `fs`, `net`, `child_process`, `workers` and `sqlite` case with
   `ERR_ACCESS_DENIED` (or exits 0 for the pure-compute cases in the manifest), and the no-policy
   corpus is byte-identical to the pre-change run.
4. The loader: JSON via `require` and `import` denied without `fs.read` and allowed with it; module
   source loads with no grants; `__ln_host.readFile` no longer exists.
5. The race test shows a swapped symlink cannot be read and the open fails; `O_RDONLY|O_CREAT` is
   denied under a read-only grant.
6. A confined worker cannot read a denied path and inherits the policy; a field added to
   `Inheritable` is inherited (the unit test).
7. sqlite: `:memory:` free, read-only needs `fs.read`, read-write needs `fs.write`, side files
   implied, a symlinked side file refused, every extension route needs `ffi.load`.
8. `ERR_ACCESS_DENIED` has `capability`, `resource` and `policy` in sync, callback and promise
   forms, with file:line when the policy file provides it.
9. `process.permission.has` answers exactly as the gates do, is present with and without a policy,
   and cannot be used to widen.
10. The inventory test classifies every `__ln_host` property and `__ln_loader` key, and the source
    scan passes with its allow-list reviewed.
11. Cold start is unchanged without a policy (M7 envelope), and the with-policy cost is measured and
    recorded in this plan's Outcome section.
12. ADR-0011 is `accepted (M8)`, this plan has an Outcome section, the roadmap marks M8 complete,
    `compat.md` has the D-row, and the README states the 1.0 posture.

## 11. Open questions for the approval

1. **The renumber (D1).** M8 permissions, M9 hardening, M10 FFI, 1.0 grows by ≈4.8 weeks. This is
   the one decision that needs a yes before Phase 0.
2. **D7's endpoint rule.** "A name grant matches the name; a literal grant matches the address" is
   the only reading that makes both the ADR's `api.example.com:443` example and its
   `169.254.169.254` example true. If the intent was "resolve the policy's hostnames at boot", say
   so; that is a different design with a cold-start and staleness cost.
3. **D8's `process.kill`.** Allowed by any `child.spawn` grant, or a separate rule that takes a pid
   list (which cannot express "my children")? The plan recommends the coarse rule.
4. **D12's aliases.** Accept Node's `child`/`worker` scopes, or only the nine capability ids? The
   plan accepts both and documents it.

## 12. Outcome (2026-11-25)

M8 is implemented. `--permission` selects a deny-all base; `--permission-file` and the nine
`--allow-*` flags supply grants and are mutually exclusive; the nine capability ids are enforced in
Rust across the fs ops, the JSON/data loader, network candidates, dns, child spawn and kill,
workers, the environment, sqlite (including `ffi.load` routes) and stdio descriptors. Denials are
`ERR_ACCESS_DENIED` with `capability`, `resource` and `policy` in the sync, callback and promise
forms, and `process.permission.has` answers through the same matcher. Default runs are unchanged
(no policy, no resolution, no `O_NOFOLLOW`).

### 12.1 What the implementation changed in the plan

1. **`Pool::with_permit` instead of `Pool::new(io_threads, permit)`.** `Pool::new_unconfined`
   remains for tests; production pools are always built with a permit, so a forgotten argument is
   not a way to run unconfined. `Config::child_of` takes the worker's `argv` (the worker's
   `process.argv` is not the parent's), and `Inheritable::into_config` is the one-copy helper the
   worker bridge uses.
2. **The `Permit` skeleton landed with Phase 2**, because the read chokepoint is its first
   consumer; Phase 3 finished the fd table and the pool/task plumbing. The fd table records
   `open`/`close` in `Op::execute` and seeds 0/1/2 and the fork IPC fd at isolate construction.
3. **The loader, denial, sqlite, worker and race evidence lives in Rust unit tests** in
   `crates/ln-runtime` (99 lib tests plus the scan and existing integration tests) and `crates/ln-io`
   (73 lib tests, 100 including net/proc/tls), plus the shell harness in `test/perm/`.
   The plan's `test/perm/cases/*.js` only carries the host inventory; the end-to-end cases are
   cheaper to assert by exit code inside the runtime tests and still exercise `Isolate::new`.
4. **A denial reports the resolved path**, so on macOS `/etc/passwd` appears as
   `/private/etc/passwd`. That is the path the check used; reporting the caller's spelling would
   describe a file the runtime did not open.
5. **`process.permission.has` answers `false` for an unknown scope even when nothing is enforced.**
   The ADR's "true for everything" is implemented for the nine ids and the two Node aliases; an
   unknown scope is not a well-formed query, and answering `true` would claim a capability that
   does not exist.
6. **The source scan grew to `fs::canonicalize`, `Socket::new`, `lookup_host` and `ln-modules`**,
   and it found no TLS file reads: TLS takes certificate/key bytes from JavaScript, whose `fs`
   reads are gated. The scan's allow-list is by `(file, function)` with a reason, and it fails on a
   stale entry as well as an unlisted hit.
7. **`--timing` gained one `permissions` row** for the CLI's parse, because the policy is parsed
   before the isolate exists (`timing: permissions count=1 total_ms=…`).
8. **`builtinUnavailable` stayed public on `__ln_host`** (the loader also has a privileged copy):
   `constants.js` asks it before requiring the optional `node:crypto` module in a feature-trimmed
   build. It returns a string and reads nothing; the inventory records it as plumbing.
9. **SQLite `file:` URIs are refused under a policy, and the resolved path is what sqlite opens.**
   `SQLITE_OPEN_URI` makes sqlite parse a `file:` path itself, so the string the gate checked and
   the file sqlite opens would differ; the URI form is refused and `Database::open`/`Backup::start`
   receive the resolved path. This closes a chdir-relative escape found in review.
10. **`net.resolve` is checked before the resolver on connect and listen**, not only in
   `dns.lookup`: a deny-all policy issues no DNS query for a name. A connect or listen grant for a
   name implies resolve for it; a literal-address grant does not, so a name needs its own resolve
   grant even when the address would match.
11. **Truncate is descriptor-based under enforcement** (`open(O_NOFOLLOW)` + `ftruncate`).

### 12.2 Evidence

| Check | Result |
|---|---|
| `cargo test --all` | green (ln-runtime 99 lib + 15 integration incl. the scan, ln-io 100, ln-perm 40, plus the other crates) |
| `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check` | green |
| Source scan (`permissions_scan`) | 0 unlisted hits, 0 stale entries |
| Host inventory | 66 host properties, 29 `__ln_*` globals, no privileged read, no `__ln_loader` |
| Deny-all sweep | 77 existing fs/net/child_process/workers/sqlite cases: 63 `denied`, 14 `pass`, 0 unexpected |
| Symlink race | 400 async reads, 0 leaks, 0 unexpected errors |
| Cold start (release, `-e '1+1'`, 25 runs) | 11.58 ms without a policy, 11.59 ms with `--permission`, 11.47 ms with a policy file |
| `test/perm/run.sh` | CLI matrix (11), inventory, deny-all manifest, race |

One dependency note: `cargo deny check` is green for licenses, bans and sources; the advisory leg
reports CVE-2026-119375 in the pinned `rusqlite`/bundled SQLite. That dependency predates this
change (the milestone added `json_comments` and `ln-perm` only) and is a separate upgrade.

### 12.3 What did not ship

Compiled apps stay deferred (ADR-0011 §11). The directory-rename race remains the documented
`openat2(RESOLVE_BENEATH)`/dirfd follow-up, not something this milestone claims to close.
`chmod`, `chown` and `utimes` still resolve-and-call a path syscall (their `follow` form has the
same narrow final-component swap window that `truncate` no longer has); closing it needs a dirfd
held across check and syscall, the same follow-up. The deny-all manifest records the outcome
surface, not a filesystem snapshot: a case that catches a denial and normalizes it to a skip is
`pass` in the manifest, and the targeted tests are what prove that gate. Windows
is best-effort: the mode and case checks are gated behind `cfg(unix)`, and the matcher fails closed
on an odd-case path. A shell `exec` is checked as `/bin/sh`, and a bare-name `child.spawn` grant
trusts `PATH`; both are recorded in `compat.md` D80.

A post-completion review found two blocking escapes: sqlite `file:` URIs (SQLite parses the URI
itself, so the checked string and the opened file differed) and name resolution on connect/listen
before the resolver (a deny-all policy still issued the DNS query). Both are fixed and covered by
`sqlite_file_uris_cannot_escape_the_grant` and `a_name_is_not_resolved_without_a_resolve_grant`.
The review's remaining non-blocking items are the ones listed above and in §12.4: `chmod`/`chown`/
`utimes` still call a path syscall after the resolved check, the deny-all manifest records outcomes
rather than filesystem side effects, a bare `process.permission.has("net.connect", host)` query uses
port 0, and a relative Unix-socket grant without a separator is parsed as a host name.

### 12.4 Follow-ups

* A pre-digested policy blob only if `--timing` ever shows the parse mattering; at ~0.1 ms it does
  not.
* `openat2(RESOLVE_BENEATH)` on Linux and a dirfd hold on macOS for the rename race.
* The compiled-app policy (build-time blob and `ONDE_ABI_VERSION`) when a compiled app `eval`s
  plugins.
