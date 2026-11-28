# ADR-0012: Plugin packages — a directory format, no runtime loader, tuckbox as the installer

- Status: proposed (2026-11-26; revised 2026-11-27 — loader dropped, then the review's fixes to
  the compiled-app mechanism, the catalog pin, tuckbox's npm scope and lock integrity). M11 (1.2),
  after M10 ([FFI](0010-ffi-dlopen.md)).
- Date: 2026-11-26, revised 2026-11-27
- Related: [0010 FFI](0010-ffi-dlopen.md), [0011 permissions](0011-permissions.md),
  [ffi-plan.md](../ffi-plan.md), [tuckbox.md](../tuckbox.md), [standalone-build.md](../standalone-build.md),
  [static-lib.md](../research/static-lib.md), [roadmap.md](../roadmap.md)

## 1. Context

[M10](0010-ffi-dlopen.md) makes it possible to *call* native code. It does not answer the question a
tool author actually has: how does a plugin arrive, how do I know it matches this machine, and how
does the project that depends on it pin a version. Without an answer, every tool that wants plugins
writes the same twenty lines of `dlopen` plus a directory convention, and each one gets the target
check and the integrity check slightly wrong.

Node's answer is N-API prebuilds: a stable C ABI, one `.node` per platform, rebuilt per V8 major
before N-API and per N-API version after. [ADR-0010](0010-ffi-dlopen.md) §2 already declined to build
that shim, and nothing here revives it.

Three properties decide the design, and the third one shrank it.

1. **A native plugin is not a sandbox.** It runs in-process with exactly the authority the process
   has. [ADR-0011](0011-permissions.md#6-threat-model-and-non-goals) says the same about FFI and the
   sentence is not softened here. What a plugin system can honestly offer is a *second population* —
   the trusted extension and the untrusted download — and those want different execution models, not
   a different package format (§6).
2. **A Rust `staticlib` cannot be merged into a program that already has one.** `libonde.a` carries
   `std`; linking a second Rust archive beside it produced **2,283 duplicate symbols** in a measured
   experiment ([static-lib.md](../research/static-lib.md#3-symbols-duplicates-whole-archive-visibility-debug-info)).
   So a *distributable* plugin artifact is a dynamic library, and linking a plugin into an app is a
   build, not a package (§9).
3. **The runtime needs no loader.** The glue calls `dlopen` itself and declares the symbols it uses —
   the FFI's ordinary path. So there is no plugin ABI, no host vtable, no init/shutdown hook and no
   lifecycle to manage. What the module system adds is a *resolution rule* (§3.1): turning
   `onde:plugin/<id>` into a directory is the work it already does for every other dependency. Opening
   native code is the part it must not do.

The consequence is stated once and then used throughout: **a plugin's C API is the plugin's
business.** onde supplies `dlopen`; it does not define what is behind it.

## 2. Options

* **A. No plugin system.** Built-in modules only; extension means a new runtime release.
* **B. N-API prebuilds.** The ecosystem-compatible answer, and a different project. Declined in
  ADR-0010 §2; unchanged by this document.
* **C. Nothing but the FFI.** Plugins are directories whose glue `dlopen`s its own dylib. No
  manifest, no catalog, every publisher invents the install story.
* **D. C, plus a package format the tooling reads.** The runtime behaves exactly as in C; a manifest
  and a catalog let an installer pick the right cell and verify it.
* **E. D with per-platform packages on npm** (the `@esbuild/darwin-arm64` shape), where
  `optionalDependencies` select the artifact.

### 2.1 Why D and not C

C is not an alternative at run time: **it is a strict subset of D.** A directory with a dylib, a glue
script as its `main` (or `index.js`) and no manifest loads under D by path or by id, because the
resolver never reads a manifest to find it.
So the question is only whether the tooling gets metadata, and "which cell is this, and is its hash
what the reviewer approved" is not answerable from the files alone.

Keeping C as the *escape hatch* is the point of D: anything outside the catalog still loads.

### 2.2 Why not E

Per-platform packages exist to work around npm's inability to choose an artifact *inside* a package:
a root package carries the JavaScript and `optionalDependencies` pull the matching platform package,
so a real plugin ends up as two directories with one manifest between them. The installer here is
ours, and it can select the cell — and it has to be, because tuckbox does not install
`optionalDependencies` at all ([tuckbox.md](../tuckbox.md)).

§3 removes the last reason it could have worked. Per-platform packages are an npm *resolution*
feature: they exist so a resolver can satisfy a specifier. A plugin is not resolved *through
`node_modules`*; it is installed into a directory that a separate rule finds by id (§3.1). E is a
model with nothing left to hook into.

## 3. Decision

**D, native only, with zero plugin code in the runtime.**

* **`onde` gains a resolver rule and an introspection module, and no loader.** No plugin ABI header,
  no `dlopen` anywhere below JavaScript, no lifecycle. The glue uses `onde:ffi` exactly as a script
  would; `onde:plugin` (§3.2) answers questions about installed plugins and never loads one.
* **The only gate is `ffi.load`.** A denied load throws the ordinary `ERR_ACCESS_DENIED` with
  `capability: "ffi.load"`.
* **The id is the contract; the path is the installer's.** `require("onde:plugin/@acme/geo")` — and
  the ESM form — resolves into a directory under the plugin roots (§3.1). No application names
  `plugins/`; if the installer moves things tomorrow, no application changes.
* **A plugin is not a node module.** The specifier is never resolved through `node_modules`, because
  that graph is *transitive* and this one is not: a plugin loads because a line of application code
  asked for it, never because a dependency listed it. `ffi.load` is granted per process, so the
  application could not otherwise tell which plugin asked.
* **The glue is a module; the plugin is not.** The resolver finds a JavaScript file and `require`
  evaluates it; that is all the module system does. The plugin as a *thing* — a named, versioned
  native bundle — has no lifecycle the runtime manages, which is what makes §5's "no host ABI"
  affordable.
* **The manifest is install-time metadata, not a runtime contract.** §4. The load path ignores it;
  `onde:plugin` reads it for introspection (§3.2).
* **The artifact is always a `cdylib`.** §1's second point.
* **The runtime never fetches.** `onde` runs what is on disk; only tuckbox talks to the network. This
  is the same rule as `--permission` not opening a socket at startup.
* **Distribution is a git catalog of release assets**, not a registry server and not npm. §7.
* **tuckbox becomes the installer**, dropping the npm registry client. §8.
* **M11, after M10.** FFI is 1.1; this is 1.2, and 1.0 is unaffected.

### 3.1 The resolution rule

One new rule in `ln-modules`, on both the CJS and the ESM path:

* **Specifier.** `onde:plugin/<package name>`, the full npm name, so a scoped plugin is
  `onde:plugin/@acme/geo`. The exact specifier `onde:plugin` is the introspection module (§3.2) and
  takes precedence over the prefix. A plugin id takes no subpath: `onde:plugin/@acme/geo/extra` is
  `ERR_INVALID_MODULE_SPECIFIER`, so a typo is not reported as a missing plugin.
* **Roots, in order.** Three layers, first match wins — the `#include` model, where an explicit path
  comes first and the trusted set is last:
  1. `ONDE_PLUGIN_PATH` (`:`-separated, `;` on Windows), the explicit path — what `-I` is to a
     compiler, and what an operator sets when the project directory is not where the plugins are.
     Because it comes first, an entry here wins over the built-in root too; §3.3's guarantee is
     about project directories, not about an operator's explicit path;
  2. the **built-in root**, `<exe-dir>/onde-plugins/` — where a distribution puts the plugins it
     ships (§3.3);
  3. `Config::plugin_roots`, defaulting to `[<project>/plugins]` — *project* being the nearest
     directory holding `package.json`, with `onde.plugins.json` beside it (§3.4), or the declaration
     itself when a project has no `package.json` at all — which an embedder sets wholesale, because
     it has its own layout and no project directory to speak of.

  There is **no upward walk** for the plugin itself: a parent directory's plugin is never picked up
  by surprise, which is one failure mode `node_modules` has and this must not. Finding the *project*
  does walk up once per process (§3.4); that is how the roots list is computed, not a per-specifier
  search.
* **Target.** `<root>/<name>/`, resolved through its `package.json` with the resolver's normal
  package rules, not as a directory import:
  * CJS path: `exports` with `node|require|default`, then `main`, then `index.js`;
  * ESM path: `exports` with `node|import|default`, then the same `main` fallback this resolver
    applies to any package, so a plugin that ships only `main` resolves on both paths; an `exports`
    target that names a directory is `ERR_UNSUPPORTED_DIR_IMPORT`.

  One plugin directory may therefore resolve to two files, one per path (§10). That is the plugin
  author's choice, stated here so the two paths are not assumed to agree.
* **Not found.** `ERR_MODULE_NOT_FOUND` naming the id and the roots that were tried — the same code
  a missing package gets, because it is the same failure (§3.2 covers when the introspection API
  raises `ERR_PLUGIN_NOT_FOUND` instead).
* **Nothing else is read.** The manifest is not consulted here. `format`, `name`/`version` and
  `target` were checked before the bytes were installed (§4.1); re-reading them at every require
  would be a second place for the same rule to be wrong.

It adds no syscall, no native code and no capability — it is a specifier-to-path rule of the kind the
resolver already applies nine ways.

### 3.2 `onde:plugin`, the introspection module

The resolver makes the id a contract. This module lets an application ask about the contracts it has
without loading any of them.

```js
const plugin = require("onde:plugin");

plugin.roots();        // [{ dir: '/opt/onde/onde-plugins', builtin: true, error: null }, …], frozen
plugin.list();         // one record per directory in the roots
plugin.manifest(id);   // the parsed onde.plugin.json, or throws ERR_PLUGIN_NOT_FOUND
plugin.resolve(id);    // the absolute directory the id resolves to
```

A root is `{ dir, builtin, error }`; a record is
`{ id, dir, manifest, active, usable, reason, builtin }`.

`roots` and not `paths`: these are the directories plugins live *under*, and the name has to survive
being compared with two neighbours. Node already gives `paths` a meaning — `require.resolve.paths()`
is the resolution chain for a specifier — and here it would read as "the paths of the plugins", which
is `list()[].dir`. One concept, one word, and the Rust field is already `Config::plugin_roots`. `id` is the directory name, because that is the
truth for resolution — the manifest's `name` was checked equal to it at install and is not consulted
again. `manifest` is `null` when there is none, so a directory that only satisfies option C is still
listable. `active` is true for the copy the id actually resolves to; a shadowed copy stays in the
list with `active: false`, because "the built-in one wins and your installed copy is dead" is the
diagnosis, not the silence. `usable` is `false` with a `reason` from a fixed vocabulary —
`"target"`, `"engine"`, `"shadowed"`, `"unreadable"` — when the plugin cannot run here: `target`
is another machine, `engines.onde` excludes this runtime, another root answered first, or the
directory could not be read. "Installed but not for this machine" is a state an application
should be able to *show*, rather than discover through a `dlopen` failure.

**It never loads.** No `dlopen`, no `require` of a glue, no evaluation: listing a plugin must not run
it. There is deliberately no `load` here — `require("onde:plugin/<id>")` is the loader, and a second
one would mean a second module cache and a second place to get the roots policy wrong.

`require.resolve("onde:plugin/@acme/geo")` returns the glue file — the one the directory
`resolve()` names contains — and `require.resolve.paths("onde:plugin/@acme/geo")` returns the roots
as directories, so the resolution chain the other neighbours expose is visible here too.

`ERR_PLUGIN_NOT_FOUND` is the only plugin error this module raises. The resolver raises the
ordinary `ERR_MODULE_NOT_FOUND` for the same missing id, and the asymmetry is deliberate:
`require("onde:plugin/x")` fails the way `require("x")` fails, while `plugin.manifest(id)` names
the thing it could not find. Everything else in §4.1 is an install-time refusal.

**It is JavaScript over `fs`.** Every function above is a `readdir` plus a JSON parse, so the module
lives in `js/lib/plugin.js` beside `path` and `os` and adds no capability: listing is a file read and
is gated by `fs.read` like any other — a `--permission` run that may not read the plugin roots may not
list them either. A policy that covers one root and not another does not fail the call: the root
comes back with `error`, and its plugins with `reason: "unreadable"`, because a listing that throws
tells a caller nothing about the rest of the installation. Two facts cannot be derived from the
files and are injected at boot as frozen values rather than re-derived here: the roots, and the
runtime's own target tuple (§4.1) — `process.platform` and `process.arch` cannot tell glibc from
musl, and `usable` must be able to. The version it compares `engines.onde` against is
`process.version`. §3.1 keeps the single definition of where plugins live.

### 3.3 The built-in root

A distribution can ship plugins of its own. They are ordinary plugin directories under
`<exe-dir>/onde-plugins/`, found by the same rule and loaded by the same glue as anything else —
`require("onde:plugin/<id>")` does not know or care which root answered.

This is the `#include <...>` half of the model, and it is worth stating what it is *not*:

* **Not embedded in the binary.** Embedding a `cdylib` would mean extracting and re-signing it at
  first use, and embedding the native code directly would mean exporting the runtime's symbols for
  `dlsym` — the visibility problem §5 exists to avoid. A compiled-in plugin is also already
  expressible, and already shipped: it is a Cargo feature and a built-in module (`node:sqlite`,
  `node:crypto`).
* **Not a second id space.** A built-in plugin has the same id grammar, the same manifest and the same
  `target` rules; `onde:plugin.list()` reports it beside the installed ones, distinguished only by
  its root.
* **Not a single-file dependency.** A distribution that ships no plugins is exactly today's binary;
  one that ships plugins ships a directory beside it. That is a packaging choice, not a runtime one.

The ordering consequence is deliberate and should be said plainly: because the built-in root is
searched before the project, **a project directory cannot replace a built-in plugin's id.** That is
the safety half — an application's `require("onde:plugin/json")` keeps meaning the runtime's own
implementation no matter what appears in `plugins/` — and the cost is that a fix to a shipped plugin
waits for a runtime release, or arrives under a different id. The guarantee stops at the project
root on purpose: `ONDE_PLUGIN_PATH` is searched *before* the built-in root (§3.1), so an operator can
still override a shipped plugin for one machine, which is the `-I` semantics that layer exists for.
§13 records the general override question rather than inventing a flag here.

### 3.4 The project's plugin set

Two files in the project root. They are the difference between a directory that happens to contain
plugins and a project that declares them.

**`onde.plugins.json`** — the declaration, the only one a human writes:

```jsonc
{
  "format": "onde-plugin-set/1",
  "catalog": "https://github.com/onde-plugins/index#8f1c4d2",
  "plugins": {
    "@acme/geo":  "^1.2.0",
    "@acme/json": "2.0.1"
  }
}
```

The `#<commit>` belongs to the declaration and not only to the lock: tuckbox has no git client, so
the catalog is read as files at a commit (§7), and some commit has to be named before anything can
be fetched. Moving the pin is an edit to that line; the lock then records what was installed from
it.

It is separate from `package.json` for two reasons. Plugins are not npm dependencies — not resolved
transitively, not in `node_modules`, not published to a registry — so a field inside `package.json`
would put them under a lifecycle that does not apply to them. And a plugin set is a **trust
declaration** (§6): a file whose diff reads "this project now loads these two native bundles" is
reviewable in a way that one changed key inside a five-hundred-line `package.json` is not. A project
with no npm dependencies does not need a `package.json` at all, which is also why §3.1 accepts the
declaration on its own as a project marker.

**`onde.plugins.lock`** — the resolution, generated by tuckbox and committed:

```jsonc
{
  "format": "onde-plugin-lock/1",
  "catalog": { "url": "https://github.com/onde-plugins/index", "commit": "8f1c…" },
  "plugins": [
    { "id": "@acme/geo", "version": "1.4.2", "target": "aarch64-apple-darwin",
      "dir": "plugins/@acme/geo", "size": 482304, "sha256": "9f2c…",
      "files": {
        "package.json": "1a3f…",
        "main.js": "77be…",
        "lib/libgeo.dylib": "9f2c…"
      } }
  ]
}
```

A lock rather than just `onde:plugin.list()` (§3.2), because the file records three things discovery
cannot. **Provenance**: which catalog, at which commit. **Integrity**: `sha256` is the catalog's
tarball hash, and `files` is one hash per path in the unpacked directory — the tarball hash proves
where the bytes came from, the per-file map is what proves they are still there, because what sits
on disk is a directory and one number over a directory is not a check anyone can run against it.
**Ownership**: which directories tuckbox created and may delete — and that is the one that matters
at `tuckbox remove`, because a plugin vendored by hand sits in the same root and must survive.

Both are versioned independently of the manifest's `format`, because they change for different
reasons. The lock is never hand-edited; a lock that disagrees with the declaration is a usage error,
not something to reconcile silently.

## 4. The package format

The manifest is `onde.plugin.json`, beside the artifacts. Everything in it answers an *installer's*
question; nothing in it is read on the load path, though `onde:plugin` reads it for introspection
(§3.2). "Required" below means required of a package the
catalog distributes — a vendored directory may omit the manifest entirely and still load (§2.1),
which is what keeps option C working.

Required:

| Field | Meaning | Who reads it |
|---|---|---|
| `format` | `"onde-plugin/1"` | installer; unknown is refused, never guessed |
| `name` | npm package-name grammar, scope included | installer, and the lockfile's key |
| `version` | semver; must equal the sibling `package.json` | installer |
| `target` | the Rust triple this package serves | installer, `ondec`, a verifier |

Optional:

| Field | Meaning | Who reads it |
|---|---|---|
| `artifacts` | `{ "native": { "dylib": path }, "wasm": { "module": path } }` | `ondec`'s staging step (§9), a verifier, a doc generator |
| `engines.onde` | semver range | installer, for a readable refusal |

```jsonc
{
  "format": "onde-plugin/1",
  "name": "@acme/geo",
  "version": "1.2.0",
  "target": "aarch64-apple-darwin",
  "engines": { "onde": ">=1.2" },
  "artifacts": { "native": { "dylib": "lib/libgeo.dylib" } }
}
```

`onde:plugin` reads every field above for introspection. That is reporting, not enforcement: the
checks that matter — `format`, the name/version agreement, `target` — happen once, in the installer.

**Hashes belong to the catalog, paths belong to the manifest.** A manifest describes what is in the
directory; a catalog entry describes where to get it and what it must hash to (§7). Putting a hash in
the manifest as well was the previous draft's mistake: nothing at load time would check it, and a
vendored directory's integrity comes from the thing that vendored it — a git commit, a submodule, a
reviewed copy.

### 4.1 Why `target` is required

Without it, a package's machine is stated only by the tarball's name, the catalog cell's key, or the
directory it was unpacked into — three conventions, none of them data a program can check against
another. `target` makes the claim checkable, and the check is not decorative: the catalog says a cell
is `aarch64-apple-darwin`, the downloaded tarball's manifest must agree, and a disagreement is
`ERR_PLUGIN_TARGET` rather than a plugin that installs cleanly and fails on first call.

**The vocabulary is the SDK's cell matrix.** These eight tuples are the only accepted values, spelled
exactly as Rust spells them — `arm64-apple-darwin` is not a synonym for `aarch64-apple-darwin`, and a
near-miss is a refusal rather than a best-effort match:

| tuple | arch | OS / libc | loads in v1 (from 1.2) |
|---|---|---|---|
| `aarch64-apple-darwin` | arm64 | macOS | yes |
| `x86_64-apple-darwin` | x86_64 | macOS | yes |
| `aarch64-unknown-linux-gnu` | arm64 | glibc | yes |
| `x86_64-unknown-linux-gnu` | x86_64 | glibc | yes |
| `aarch64-unknown-linux-musl` | arm64 | musl | no — FFI untested on musl |
| `x86_64-unknown-linux-musl` | x86_64 | musl | no — FFI untested on musl |
| `x86_64-pc-windows-msvc` | x86_64 | MSVC CRT | no — no `LoadLibrary` path |
| `aarch64-pc-windows-msvc` | arm64 | MSVC CRT | no — no `LoadLibrary` path |

The eight are the matrix in [standalone-build.md](../standalone-build.md#21-naming-and-matrix); the
four that load are the FFI's platform table. Everything else — 32-bit, big-endian, Windows GNU — is
outside that matrix and therefore outside this field. The two are deliberately different lists: the
matrix is what the project *builds*, the last column is what v1 *runs* — from 1.2, when FFI first
loads a native library — and a tuple that is in the first but not the second is a legal manifest
that fails with a reason instead of an untested `dlopen`.
Adding a cell is a runtime release, not a `format` bump.

The triple is used rather than npm's `os`/`cpu` pair because those cannot express the libc: the two
Linux rows above are different binaries, and a plugin built against glibc does not load on a musl
cell. One vocabulary — the one `ondec`, the SDK cells and the catalog already use — also means one
mapping table, generated from the cell list rather than re-typed per tool: the eight tuples live in
`ondec`'s `sdk::CELLS`, `Target` parses one, and §8's build step emits tuckbox's copy from it.

One distribution hazard the triple cannot express, and therefore a rule rather than a field: a
`*-gnu` plugin carries a **glibc floor** from the machine it was built on, and one built against a
newer glibc fails at `dlopen` with a symbol-version error. Plugins are built in the same pinned
container as the SDK cells for that tuple, so every `*-gnu` plugin shares the floor the matrix
records for that tuple — still to be fixed in
[standalone-build.md](../standalone-build.md#21-naming-and-matrix), where glibc 2.31 is the
candidate; there is no `libcFloor` field, because a number nobody verifies is the same mistake as a
hash in the manifest (§4).

It is singular because the field names **the cell this package serves**, not an inventory of the
machine code inside it. That is what an installer needs and all it can verify, and it makes one
question unaskable: there is never a package for "several machines", so there is no mode in which an
install downloads another architecture's bytes.

### 4.2 Why there is no `universal-apple-darwin`

A `lipo`'d binary is a real thing and this format does not support it, deliberately. Four reasons,
and the third is the one that decides it.

**It is not a target.** Cargo cannot build `--target universal-apple-darwin`; it is a packaging label
produced by a post-build `lipo`. Admitting it would put a value in `target` that no compiler emits,
and kill the property the vocabulary rests on: the list is generated from the cell table (§8), and
one entry of it would have to be synthetic.

**No machine has that tuple.** The host is `aarch64-apple-darwin` or `x86_64-apple-darwin`, so
matching becomes a special case — "if this is a Mac, accept the universal cell too" — and the
installer and every verifier now carry a platform-specific rule. It also creates precedence: what
happens when a specific cell and a universal one both exist for one id? Whichever rule we pick, one
of the two artifacts is silently preferred.

**Every install would carry a slice it cannot run** — on Apple Silicon, the whole `x86_64` half of
the file. That is the opposite of the property §4.1 just established: an install fetches exactly the
cell it will execute and nothing else. Universal binaries earn their size on machines that ship
everything at once (browsers, GUIs); a plugin system with a catalog and a per-cell installer has no
reason to pay it.

**The format has no room for it anyway.** One package has one manifest, and the manifest's `target`
must equal the catalog's cell (§4.1). A single fat tarball therefore cannot serve both cells: it
would need two manifests, hence two packages with identical native bytes and two hashes. If that is
ever worth doing, the shape to change is the package (manifest separate from the artifact blob), not
this field.

The only genuinely architecture-free artifact is wasm, which is not a plugin artifact at all (§6). A native
library that runs on two architectures is two architectures in one container, and this format names
containers, not contents.

### 4.3 Install-time errors

Every one of these is raised by tuckbox, not by the runtime:

| Code | Raised when |
|---|---|
| `ERR_PLUGIN_FORMAT` | `format` unknown or missing |
| `ERR_PLUGIN_MANIFEST` | a required field is missing, or disagrees with `package.json` |
| `ERR_PLUGIN_TARGET` | `target` is not this machine, or the catalog cell disagrees with it |
| `ERR_PLUGIN_ENGINE` | `engines.onde` excludes this runtime |
| `ERR_PLUGIN_INTEGRITY` | the downloaded bytes do not match the catalog |

A plugin that fails any of these is never installed, so the runtime's *native* failure surface is
only ever `dlopen`'s own: `ERR_FFI_DLOPEN` and `ERR_FFI_SYMBOL_NOT_FOUND`. The failures that remain
at run time are the ones §3.1 and §3.2 name — a missing id, an unreadable root — not five codes for
bytes that were checked before they were written.

## 5. Why there is no host ABI in v1

The previous draft defined `onde_plugin.h`: a vtable of `alloc`/`free`/`log` handed to
`onde_plugin_init`, plus an `ONDE_PLUGIN_ABI` integer compared with `≤`. It was wrong for one reason
worth writing down, because the same mistake will be proposed again.

**An ABI exists to protect a surface that two parties release separately.** In v1 a plugin and onde
share exactly one thing: `dlopen`. The plugin's own symbols are declared by the glue that ships in
the same tarball, at the same version, installed in the same operation. There is no drift to detect,
because the format guarantees the two are always the same release — and if someone assembles them by
hand, no integer in a header can tell you the native code is lying about what it is.

What a plugin *does* need from JavaScript is a callback, and the FFI already carries function
pointers: the glue passes a `Callback`, the C side calls it. That is a per-call contract, not a host
surface, and it needs no header at all.

Two consequences worth accepting out loud:

* **No `alloc`/`free` assist.** A plugin that returns memory owns the convention: it exports its own
  `x_free`, or the glue passes a buffer in and C fills it. onde never allocates on a plugin's behalf.
* **No `log`.** A plugin writes to fd 2 like any C library. If that turns out to be genuinely wrong
  (mixed formats on one stream), adding a host surface is a v2 of the format, and that is when an
  ABI number first means something.

## 6. Where wasm goes, and why it is not a plugin tier

Earlier drafts drew native and wasm as two artifacts of one plugin. That gets the relationship
backwards. wasm matters in this project for a reason that has nothing to do with plugins:

**a wasm module can be bundled into the application.** It is a payload asset like any other — the app's
own code instantiates it, and there is no directory, no `target`, no catalog cell, no `dlopen`, no
signature and no installation step. One artifact runs on every cell this runtime builds for, which
removes the entire matrix §4.1 has to police. That is the strongest argument for wasm here, and it is
stronger than metering.

So there are two unrelated roles, and only one of them belongs to this ADR:

| | bundled wasm | wasm as an installed plugin |
|---|---|---|
| arrives as | a payload asset, with the app's code | a directory in a plugin root |
| versioned by | the app's build | the catalog and the lock (§3.4) |
| platforms | one artifact for every cell | one artifact for every cell |
| needs | `onde:wasm`, compiled in (a Cargo feature) | the same module, plus §3's machinery |
| trust | the app author's | whoever installed it |
| authority | its imports only | its imports only; WASI preopens are configuration |
| failure | a trap fails one call | a trap fails one call |
| metering | fuel and memory ceilings | the same |

The first is an **application** feature: it needs an `onde:wasm` module and a payload asset, and
nothing else from this document. The second is the one that inherits the old tier table, and it is the
niche role — a module the app chose at build time is better carried in the payload than in a
directory.

One consequence is decisive for deployment. Bundled wasm means the engine must be **inside the
runtime**, behind a Cargo feature like `node-sqlite`, because the app's code calls it unconditionally.
Shipping the engine as a `cdylib` reached through `onde:ffi` — the shape two earlier drafts considered
— only ever fitted the installed-plugin role, and in the bundled role it cannot work at all.

`artifacts.wasm.module` therefore stays reserved for the installed-plugin role, and nothing loads it
in 1.2 — there is no loader to refuse it (§3), so the field is what it says it is: a path a
verifier, or `ondec`'s staging step, reads. A plugin that ships only wasm and whose glue requires a
module this build lacks fails with that module's absence — the ordinary
`ERR_UNKNOWN_BUILTIN_MODULE`, which is the honest error and needs no plugin-specific code.

## 7. Distribution: a git catalog, no registry

The format is registry-agnostic by construction: it defines a directory. What follows is a
recommended channel, not part of the contract.

* **Catalog repository, not a server.** One JSON file per plugin under `index/`, the Cargo sparse-index
  shape: PRs conflict per plugin rather than per file, and diffs are readable.
* **Read with a plain `https` GET, at a commit.** tuckbox is `fs`, `https`, `zlib` and no git
  client, and onde has no `child_process` to spawn one ([tuckbox.md](../tuckbox.md)), so the catalog
  is fetched as a file: `https://raw.githubusercontent.com/<org>/<repo>/<commit>/index/<plugin>.json`.
  That is why the declaration carries the commit (§3.4): resolving a branch name to one needs git or
  an API call, and neither belongs in an installer whose point is to be the runtime's honest test.
* **Binaries are release assets, never git objects.** A `.dylib` in git is an unbounded repository
  plus a git-LFS dependency. This is the Homebrew split, and the split the SDK already uses
  ([standalone-build.md](../standalone-build.md)).
* **Entries are generated by the plugin's release job, not written by hand.** A hand-typed hash only
  proves the reviewer hashed what the author gave them; a generated one is the hash of the artifact
  the build produced.
* **The declaration pins a catalog commit and the lock repeats it**, so "the entry changed after
  review" is detectable with `git show <sha>:index/acme-geo.json`.
* **No catalog server of our own means no uptime, no accounts, no takedowns, no publish API** — and
  also no discovery, no search, no deprecation UI. The catalog serves first-party and curated
  plugins; a git URL is the decentralized path for everyone else (§13). GitHub's availability is
  GitHub's, which is the dependency the release assets already carry.

A catalog entry carries `{ url, format, engines, size, sha256 }` per cell. A client can refuse an
incompatible one before fetching a byte — unknown `format`, `engines` that exclude this runtime, a
cell that is not this machine. A tampered one is caught after the fetch and before anything is
unpacked, when the bytes are hashed (§4.3). The tarball's own manifest is then authoritative for
what is inside. The overlap in `name`/`version` is checked; a disagreement is a hard
failure. This is the same division the SDK already has between `SHA256SUMS` and the engine stamp in
`onde.h`.

## 8. tuckbox becomes the installer

tuckbox was written as the honest test of the runtime: every byte is `require`, `fs`, `https`, `zlib`,
`path`, `process`. It is therefore also the only npm client this project controls, and it cannot
install anything a real project needs — no lifecycle scripts, no `bin` links, no peer dependencies,
no native builds, no `optionalDependencies` ([tuckbox.md](../tuckbox.md)). It is a permanent partial
npm, judged against npm's completeness, and it will never win that comparison.

**Decision: tuckbox drops the npm registry and becomes this project's package and plugin
installer** — a package installer for trees whose lock already exists, and the plugin installer
proper.

Measured in the tree: `registry.ts` is 308 lines of 2,520 (12%). The other 2,212 lines — `semver`,
`tar`, `store`, `lockfile`, `resolve`, `install`, the CLI — install an artifact safely, and they are
not untouched: `resolve.ts`, `install.ts` and `commands.ts` each import the file being deleted, and
the tarball fetch has no other home. The table below is the real diff. The content-addressed store,
the atomic unpack, the path-keyed lockfile and `ci`'s replay are the parts that are hard to get
right, and they are already right.

With §3's decision, tuckbox is also the *only* validator: `format`, `name`/`version`, `target`,
`engines`, and the catalog hashes all live here, because the runtime checks none of them.

| Change | Detail |
|---|---|
| Drop | the packument side of `registry.ts`: `getPackument`, `--registry`, the fixture registry, `real-registry.net.test.js`. npm *range* resolution goes with it, so there is no longer a server to ask what `^1.2.0` means |
| Move | the tarball fetch (`getTarball`, redirects, cache) into `http.ts`; `resolve.ts`, `install.ts` and `commands.ts` each keep one changed import. Deleting the file without this split breaks `ci` |
| Add | `catalog.ts`: the index client, one `https` GET per `index/<id>.json` at the pinned commit (§7) |
| Add | Cell selection: tuple → catalog cell → download. The tuple table is **generated from `ondec`'s `sdk::CELLS`**, never re-typed in TypeScript |
| Add | Install-time manifest validation (§4.3's error table), and the per-file hash map (§3.4) written as the directory is installed |
| Change | `--catalog <url>` replaces `--registry`, and it is a different kind of URL: a repository at a commit, fetched as files, not an API endpoint |
| Change | `onde.plugins.json` is the input and `onde.plugins.lock` the output (§3.4); installed to `plugins/<name>/`, **not** `node_modules`, with no nesting: a plugin is a direct, named dependency of the application, so there is no graph to resolve and no conflict to nest |
| Change | `tuckbox install` materializes the npm side strictly from `tuckbox.lock.json`, and fails with a sentence when `package.json` disagrees, because it has nothing left to resolve against. `ci` keeps its stricter check |
| Change | `tuckbox add`/`remove` operate on `onde.plugins.json`. They stop being npm commands: with no registry, `add foo` has no `latest` to resolve, and editing `package.json` is the human's job |
| Change | `tuckbox.lock.json` is untouched. Plugins get their own lock, so the npm side needs no v2 and no migration of a file already committed in users' repositories |
| Change | `tuckbox ls` merges the lock with `onde:plugin.list()`: managed entries from the lock, hand-vendored ones marked as such, built-ins marked, shadows visible |

Because tuckbox is itself an onde application, it can call `onde:plugin.list()` before installing and
warn when an id is already provided by the built-in root. The shadowing that §3.3 creates is cheap to
detect at install time and expensive to diagnose at run time, and this is the first real use of the
introspection module. The call is feature-detected, because tuckbox runs under node as well as
onde and its harness requires identical output from both ([tuckbox.md](../tuckbox.md)): `ls` merges
the lock with `list()` only when the module is there, and the merged view is asserted by an
onde-only case.

One property of `ci` is worth stating rather than assuming: it replays the *lock* without asking a
server what a range means, but a tarball still has to come from somewhere. With `.tuckbox/cache`
warm there is no network; with it cold, `ci` fetches. "Offline replay" is a warm-cache property.

Because a plugin is not resolved through `node_modules`, its own `dependencies` are not installed with
it: a plugin either vendors what it needs or uses what the application already has (the upward walk
from `plugins/<name>/` still finds the project's `node_modules`, which is how a glue script requiring
a shared helper works). That is a rule to document, not a resolver to write — plugins are expected to
be near-self-contained native bundles.

Two constraints on that plan:

* **Sequencing: add, then remove.** Land the catalog source with the registry still present, prove the
  plugin path end to end (install, lock, `ci` replay, load), then delete the packument client and leave
  the tarball fetch in `http.ts`. Deleting first trades a reversible change for an irreversible one.
* **Foreign bytes.** Removing the registry removes the only source of *other people's* tarballs, and a
  tarball writer tested against its own reader proves nothing. Mitigation: vendor two real npm tarballs
  into `tuckbox/test/fixtures` before `registry.ts` goes, so `tar` and `store` keep being tested
  against bytes this project did not produce.

The tool is not renamed: "tuckbox" never implied npm, and a rename would churn docs, tests and
demonstration material for no gain. What changes is the first paragraph of
[tuckbox.md](../tuckbox.md) and the comparison table in the README, neither of which can keep
defining the tool by npm's completeness.

## 9. Deferred, with the mechanism recorded

**Compiled apps (`ondec`).** The single-file path is unchanged: an app with no plugins is still one
executable. An app with plugins is `app` plus `app`'s **built-in root** (§3.3): `onde-plugins/<id>/`
beside the executable. The three alternatives do not exist. A second Rust `staticlib` is the
2,283-symbol wall (§1.2). Embedding a `cdylib` means extracting and re-signing it at first use, which
on macOS means library validation on a file this process just wrote. And shipping no native code
means there is no plugin.

So what ondec does has nothing to do with native formats:

1. **Bundle the glue as an ordinary module.** `require("onde:plugin/<id>")` is a static specifier but
   not a package name, so ondec resolves it at build time with the same roots rule (§3.1) and hands
   the file to rolldown. A *declared* id comes from the lock's `dir` (§3.4) rather than from
   `ONDE_PLUGIN_PATH`, so a build depends on the project and not on the operator's environment. A
   computed specifier still cannot be bundled — that is compat.md D64,
   unchanged. Because the glue is bundled, no payload key is written for the id: the app's own module
   is the artifact and the dylib is data.
2. **Stage the declared plugins, and only those.** The ids in `onde.plugins.json` (§3.4), each
   directory copied whole to `onde-plugins/<id>/` beside the output, and signed there when `--sign`
   names an identity (below). Not every plugin on disk: the build output must not depend on whatever
   happens to be in the developer's `plugins/`, and the lock (§3.4) is what makes the staged set
   reproducible.

   One directory, not one bag of libraries. Two plugins can legitimately ship a `libcore.dylib`, a
   plugin may bring data files beside its artifact, and an `@loader_path` reference survives only if
   its layout does — flattening breaks all three at once. Copying the directory whole also keeps
   `onde:plugin.list()` working in a compiled app, because the manifest travels with it.
3. **Register the namespace, not the ids.** Payload mode answers builtins from names alone, and its
   key table only resolves relative and absolute specifiers, so `onde:plugin` — and `onde:ffi`
   beside it — is registered the way every `onde:` module is, and that registration is the whole
   addition. `onde:plugin/<id>` is never added to the payload table: step 1 bundled it, so nothing
   reaches the resolver at run time, and a per-id table would be a second copy of the lock that has
   to be kept in step with it.

That imposes exactly one rule on plugin authors, and it is worth stating here rather than discovering
it: **a glue resolves its own directory through `onde:plugin.resolve(id)` (§3.2), never through
`__dirname`.** The first works in both worlds; the second works only in the interpreter. It is the
whole reason `resolve` is in the API.

A compiled app that must be one file uses `--packager wrappe`, and the recorded objection — that its
output is not signable — is about the wrong signature. wrappe extracts and *execs* `onde`, and macOS
library validation at `dlopen` compares each library against the team of the process that loads it.
So sign the staged files **before** packing: the runtime and every plugin's dylib, one identity, then
pack. The checks hold at the far end. Ad-hoc signatures do not satisfy library validation, so this
path needs a real identity and its notarization; that is a signing prerequisite on a packager, not a
property of the plugin format.

**The wasm engine.** §6 puts it inside the runtime as a Cargo feature, like `node-sqlite`; a `cdylib`
reached through `onde:ffi` cannot serve either role. Four engines are candidates and this ADR picks
none: `wasmtime` (Rust, or its C API vendored — a large tree either way); `wasmi` (pure Rust,
actively maintained); [`wasm3`](https://github.com/wasm3/wasm3) — C, MIT, ~64 KB, no JIT, metering and
caps since its 2026 release, the engine inside `txiki.js`; and
[WAMR](https://github.com/wasm-micro-runtime/wasm-micro-runtime) — Apache-2.0 with the LLVM exception,
a ~59 KB interpreter, and the only candidate offering two JIT tiers (Fast JIT and LLVM JIT, with
dynamic tier-up) beside AOT.

There is no LuaJIT of wasm, and the reason is worth writing down. A trace JIT earns its speed from the
shape of a dynamic language's hot loops; wasm is statically typed, so the wins come from real code
generation. Every engine that beats an interpreter by a large factor is a compiler backend. The spread
is roughly: interpreters an order of magnitude off native; Fast JIT and Cranelift a small multiple;
LLVM JIT within about 1.5x. "LuaJIT level" in that page's own table is `fib(40)` at 1.15s against
`wasm3`'s 3.83s — the V8 tier, not native.

The consequence is that the tier's purpose picks the engine. §6 justifies wasm by **authority and
metering**; a plugin that needs native-class speed should be a **native** plugin, which this format
already covers and which runs at 1.0x. Putting a JIT inside the wasm tier buys speed the native tier
already has, and pays for it with executable memory — the property that made `wasm3` attractive here,
and the one thing that would make a wasm-enabled build need a JIT entitlement on macOS even when
`ffi` is compiled out.

The tier is a budget, not a shape. A baseline wasm JIT is the smallest useful native-code generator
in any language runtime — wasm needs no hidden classes, no inline caches, no deoptimisation points,
and its structured control flow has no irreducible graph to patch — and a build with `ffi` already
asks for executable memory, so "no JIT" cannot be the project's rule on principle. What the rule can
be is a ceiling: a feature size delta, a cold-start delta, and an answer for metering, measured before
an engine is chosen. Lazy compilation on first call — which both baseline JITs and Cranelift support —
is what keeps the cold-start delta at zero for an app that never calls its module.

Whichever tier is chosen, two things stay true. Metering is instrumented into generated code and its
cost per instruction changes with the tier, so the engine is adopted with a metering-correction suite
rather than a smoke test. And a JIT puts wasm's portability at the mercy of its backends: one artifact
for every cell stops being free the moment the engine has to compile per architecture.

**A host surface.** The day a plugin needs to call *into* onde — not into JavaScript — §5's argument
expires, and a vtable with an ABI number arrives. It should arrive with a second caller, not in
anticipation of one.

## 10. Testing

The test weight moves off the runtime and onto the installer, which is the point of §3.

* **Two fixture plugins, and one of them is not Rust.** A Rust `cdylib` and a plain C `cdylib`, each
  with a glue module that declares its symbols. The C one is the point: a plugin needs nothing but
  `onde:ffi`, and the test proves it by using only the documented surface.
* **A plugin with no manifest** loads; that is option C, and it must keep working (§2.1).
* **Resolution**: `onde:plugin/<id>` finds the project root from the entry point and from a nested
  subdirectory; a missing id reports the roots tried; a plugin sitting in a *parent* directory is not
  found, because there is no upward walk (§3.1); `onde:plugin/@acme/geo/extra` is
  `ERR_INVALID_MODULE_SPECIFIER`; a plugin whose `exports` names a directory resolves on the CJS path
  and fails with `ERR_UNSUPPORTED_DIR_IMPORT` on the ESM path.
* **Built-in root wins**: a plugin directory of the same id in the project root and in the built-in
  root — the id resolves to the built-in, and `list()` reports the installed one with `active: false`
  and `reason: "shadowed"` rather than silently omitting it.
* **The explicit path wins over both**: the same id in `ONDE_PLUGIN_PATH` resolves there, because that
  is what `-I` does (§3.1), and `list()` marks the built-in copy shadowed.
* **Introspection**: `list()` reports a usable plugin, a built-in one, a wrong-target plugin with
  `reason: "target"`, a plugin whose `engines.onde` excludes this runtime with `reason: "engine"`,
  and a manifest-less directory with `manifest: null`; `manifest(bad)` throws `ERR_PLUGIN_NOT_FOUND`
  while `require("onde:plugin/<bad>")` throws `ERR_MODULE_NOT_FOUND`; a `--permission` run without
  `fs.read` on one root reports `error` on that root and `reason: "unreadable"` for its plugins
  instead of failing the call; listing maps no dylib.
* **A plugin that is installed but never required is never loaded** — the whole point of §3. Check
  it by asserting the dylib is absent from the process's mapped images.
* **Two plugin directories carrying different versions of one library** both load, each calls its own
  symbol, no collision — libloading's local scope, not a runtime rule; the test pins the scope flags
  it relies on instead of assuming the platform default.
* **`ffi.load` denied**: `ERR_ACCESS_DENIED`, naming `ffi.load`, at the `dlopen` call site.
* **Compiled app**: an app that requires a declared plugin builds, stages `onde-plugins/<id>/`, loads
  the glue from the payload with no run-time plugin lookup, and the glue's
  `onde:plugin.resolve(id)` returns the staged directory where `__dirname` does not (§9's one rule).
* **Declaration and lock**: a round trip from `onde.plugins.json` to `onde.plugins.lock`; `tuckbox ci`
  replays from the lock with the network unavailable and `.tuckbox/cache` warm, and with the cache
  cleared fails naming the missing tarball instead of hanging; a lock that disagrees with the
  declaration is a usage error.
* **Ownership and drift**: `tuckbox remove` deletes a locked plugin and refuses to delete a
  hand-vendored directory in the same root; a file whose hash no longer matches `files` is reported by
  path, so the answer is "main.js changed", not "drifted".
* **tuckbox under both runtimes**: `ls` still prints identical output under node and onde, with the
  `onde:plugin` merge present only where the module exists (§8).
* **tuckbox**: a catalog read at a pinned commit, cell selection, every row of §4.3's error table,
  a size or `sha256` mismatch, a `files` entry that does not match after install, and the vendored
  foreign tarballs.
* **Cross-build refusal**: a package whose `target` is not the host, or disagrees with its catalog
  cell, fails at install with a sentence, not at link time.
* **Vocabulary**: a tuple outside the eight (`i686-unknown-linux-gnu`) and a near-miss spelling
  (`arm64-apple-darwin`) are both `ERR_PLUGIN_TARGET`; a musl or Windows tuple installs and then
  refuses to load with the reason named, rather than reaching an untested `dlopen`.

## 11. Consequences

* **The runtime's cold start and its review surface are unchanged.** No new host submodule, no new
  crate, no new native surface; the whole cost is the resolver rule and config field below and one
  JS module.
* **The `.dylib` is the only distributable artifact.** Every language that can produce one can write a
  plugin, which is most of them and is the point: §10's fixture set is a Rust `cdylib` beside the C
  one. Rust's 2,283-symbol ceiling (§1) is about *linking a second static archive*, not about loading
  a dynamic library that carries its own runtime; Go (`-buildmode=c-shared`) and Swift
  (`-emit-library`) produce the same artifact.
* **A new public contract, but a small one: `format` and `target`.** They are the only things plugins
  and tooling must agree on: one names the layout, one names the machine, and both are versioned in
  one place.
* **The plugin author writes the glue; the application writes one specifier.** Ten lines in the plugin
  (`onde:plugin.resolve(id)` plus the declarations) and `require("onde:plugin/@acme/geo")` in the app.
  That specifier is the enablement record: nothing loads because it was depended on.
* **Two files appear in a project root.** `onde.plugins.json` is a second declaration beside
  `package.json`, which is a real cost in a project that already has five config files; the argument
  for it is §3.4's reviewability and the case of a plugin host with no npm dependencies at all.
* **The runtime gains one rule, one module and one config field.** `Config::plugin_roots`, a prefix
  in the `onde:` namespace, and `js/lib/plugin.js` — the whole cost of the id being a contract
  instead of a path. None of it is native code.
* **A distribution can ship plugins without a runtime release of the code itself**, and an application
  cannot tell a built-in plugin from an installed one except through `list()`. That is the `#include`
  property, and the price is that a project cannot replace a shipped plugin's id (§3.3).
* **tuckbox loses its "small npm" framing** and gains a narrower, complete one.
* **`compat.md` gains two rows.** The last row is D79, D75 is an unused gap left alone rather than
  filled out of order, so the next free numbers are D80 and D81. `ffi-plan.md`'s claim that FFI takes
  D67 is stale — D67 is `--max-old-space-size` — so FFI takes D80 and this takes D81 when implemented,
  and `ffi-plan.md`'s two references move with it.
* **The roadmap gains an M11 row.** [roadmap.md](../roadmap.md) stops at M10, so §3's "M11 (1.2)" is a
  new milestone, and the decision log in its §6 needs a row for this ADR.
* **One thing gets harder to explain and should be said plainly**: a plugin is not a sandbox, and
  `--permission` cannot confine one beyond the single `ffi.load` grant.

## 12. Work breakdown (M11)

| WP | Work | Est. |
|---|---|---|
| 1 | tuckbox: `catalog.ts` (files at a pinned commit), the source abstraction, cell selection, install-time validation, `onde.plugins.json`/`.lock` with per-file hashes, vendored foreign tarballs | 4 d |
| 2 | Split the tarball fetch into `http.ts`; remove the packument client and its suites; freeze npm resolution to the lock; catalog repository scaffold | 2 d |
| 3 | `ln-modules`: the `onde:plugin` module and the `onde:plugin/` rule on both paths, `Config::plugin_roots`, `ONDE_PLUGIN_PATH`, resolution tests; `js/lib/plugin.js` (`roots`/`list`/`manifest`/`resolve`) | 1.5 d |
| 4 | Fixture plugins (Rust and C), the test matrix in §10, `compat.md` D81, `ffi-plan.md` D-number fix | 2 d |
| 5 | Docs: the tuckbox rewrite, the plugin-author page, the README's tuckbox table | 1.5 d |

≈11 engineering days, ≈2 eng-weeks with review — one day more than the first revision, for the fetch
split, the per-file hashes and the cold-cache test. The earlier draft's two weeks included a
*loader* and an ABI header; §3 and §5 delete the loader and §3.1 keeps the resolver.

## 13. Open questions

* **Is `tuckbox add <git-url>` in v1?** It is the decentralized path and it needs no catalog, but it is
  also the first place a plugin's *source* is trusted rather than its hash. Deferring it makes v1
  entirely catalog-driven and hash-verified; shipping it makes the ecosystem open on day one.
* **May an installed plugin override a built-in id?** §3.3 says no, because silent shadowing would
  let a project directory change what `require("onde:plugin/<id>")` means. The alternative is an
  explicit opt-in (a flag, or a version-aware rule where the installed one wins only if newer), and
  it is worth waiting for the first real request rather than guessing.
* **How does the catalog pin move?** §3.4 puts the commit in the declaration, because §7 needs one
  before it can fetch a file. Bumping the catalog is therefore an edit, or a `tuckbox catalog update`
  that asks GitHub for a branch's current commit — one API call and the first server dependency in
  the tool. Deferring it keeps the installer server-free; the cost is that a maintainer copies a sha
  by hand.
* **Does the catalog belong in this repository's org or its own?** Its size is a non-issue (JSON
  only); its review load is not, and that is an org question rather than a design one.
* **Is `artifacts` worth keeping?** Nothing reads it in v1 except a human. It is kept because
  `ondec` will, and because a verifier needs to know which file is the native one. If a year passes
  with no reader, deleting it costs one `format` bump.

## 14. What would change this decision

* **A plugin that must call into onde.** Then §5's premise fails and a host vtable with a real ABI
  number arrives — and with it, the `abi ≤ host_abi` rule that the previous draft was right about
  and merely premature about.
* **A release that needs compiled apps with plugins.** §9 specifies the mechanism and deliberately
  leaves it unscheduled: the work is a rolldown resolution hook, a staging step, and the `onde:`
  namespace registration — no native format changes at all.
* **A package shape that separates the manifest from the artifact blob.** Then one `lipo`'d file
  could serve both macOS cells with two manifests and one hash, and §4.2's fourth reason stops
  applying — the first three would still have to be argued.
* **A wasm engine that is both small and fast.** Then bundled wasm becomes the default way to ship
  compute-heavy code — portable, one artifact per app, no cell matrix — and native plugins stay for
  what needs the whole process. That is the ordering §6 would prefer and does not yet have the engine
  for.
