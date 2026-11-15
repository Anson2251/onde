# Tuckbox — a package installer that runs on onde

Tuckbox is a small npm. It reads a `package.json`, resolves the dependency graph against the public
npm registry, and writes a `node_modules` tree that Node and onde both resolve correctly.

It exists for two reasons. First, it is the honest test of where onde stands: every byte it runs
is `require`, `fs`, `https`, `zlib`, `path` and `process`. Second, it is the tool that proves a
CLI shaped like this does not need a 40 MB resident floor to install a package.

It is deliberately not npm: no lifecycle scripts, no `bin` links, no peer-dependency
auto-installation, no native builds, no `optionalDependencies` install, no publishing, no
workspaces. A package that needs any of those is out of scope and fails loudly rather than
half-working.

## 1. What it writes

```
<project>/
  package.json
  tuckbox.lock.json          # v1, committed
  node_modules/
    ms/                      # a real directory of hardlinks, not a symlink
    debug/
      node_modules/ms/       # nested only when the root copy cannot be reused
  .tuckbox/
    store/<sha512-hex>/      # unpacked package contents, one directory per tarball
    cache/                   # downloaded tarballs, so a retry costs nothing
```

Three decisions worth stating:

**`node_modules` is kept, not replaced by a store.** Onde's resolver (like Node's) walks
`node_modules` upward and canonicalizes real paths, so the installed tree has to *be* a
`node_modules` tree. A pnpm-style isolated layout would need a resolver change and a symlink farm;
neither buys a demo anything.

**The store is content-addressed and hardlinked.** `.tuckbox/store/<sha512>` holds one unpacked
copy of each tarball, and installing hardlinks every file into place. Hardlinks (not symlinks)
keep `realpath` canonical, so nothing downstream — resolution, `__dirname`, a bundler — can tell
the difference from a normal install. Across filesystems the link fails with `EXDEV` and we copy.

**The lockfile is path-keyed.** Each entry is keyed by its install path
(`node_modules/a/node_modules/b`), so `tuckbox ci` replays the tree without resolving anything and
without trusting today's registry metadata.

## 2. Commands

| Command | Behaviour |
|---|---|
| `tuckbox install` | resolve `package.json`, write `tuckbox.lock.json`, materialize the tree |
| `tuckbox ci` | install strictly from the lockfile; fails if `package.json` and the lock disagree, or if an entry is missing. No resolution, no range lookup |
| `tuckbox add <name>[@range]…` | add to `dependencies`, then install |
| `tuckbox remove <name>…` | drop from `dependencies`/`devDependencies`, then install |
| `tuckbox ls` | print the resolved tree from the lockfile |

Flags: `--registry <url>` (default `https://registry.npmjs.org`), `--prod` (skip
`devDependencies`), `--verbose`. Exit codes: `0` success, `1` a failure the user can act on
(unresolvable range, integrity mismatch), `2` usage error.

## 3. Resolution

The range syntax is the practical subset of npm's: exact, `^`, `~`, `>=`, `<=`, `>`, `<`, `=`,
`||`, space-separated intersections, `x`/`X`/`*` wildcards, hyphen ranges (`1.2.3 - 2.3.4`) and
prerelease rules (a prerelease version only satisfies a range that itself mentions a prerelease on
the same `major.minor.patch`). `latest` as a spec resolves through `dist-tags`.

Selection is deterministic: for a range, the highest published version that satisfies it wins, and
`versions` are read from the registry's abbreviated packument (the same document npm requests).

Placement is the classic hoist-or-nest rule, applied breadth-first from the root:

1. Walking each dependency edge, if `node_modules/<name>` at the root is free, place it there.
2. If the root occupant already satisfies the range, reuse it — no second copy, no nested tree.
3. Otherwise place it under the requiring package: `.../node_modules/<pkg>/node_modules/<name>`.

That yields a tree Node resolves exactly as Node's own resolver would, with deduplication where it
is free and nesting only where two versions genuinely conflict.

Cycles are handled by resolving on `(name, version)` and placing each resolved package once per
install path, so `a → b → a` terminates.

## 4. The tarball path

```
packument → dist.tarball → https GET → Buffer
  → verify dist.integrity (sha512-…)      → mismatch is a hard failure
  → zlib.gunzipSync                        → tar bytes
  → tar.list()                             → entries, stripped of the leading `package/`
  → .tuckbox/store/<sha512>/               → written once per content hash
  → hardlink farm into node_modules
```

Integrity is checked against the tarball bytes before anything is unpacked, so a corrupted or
tampered download never reaches the store.

**Memory.** `ln-zlib` is whole-buffer: there is no streaming inflate yet, so peak memory for one
package is roughly its compressed size plus its unpacked size. That is fine for the packages this
is meant to install and is the reason `tuckbox` reports the largest package it unpacked under
`--verbose` rather than pretending it streams. A streaming `Inflate` in `node:zlib` is the fix,
and it is the same missing piece that keeps `createGunzip` unavailable.

## 5. What is not implemented

| Not implemented | Behaviour |
|---|---|
| lifecycle scripts (`preinstall`, `postinstall`, `prepare`) | skipped; `--verbose` names each one |
| `bin` links (`.bin/`) | not created; a package that needs one is documented, not silently broken |
| `peerDependencies` | not installed, not validated |
| `optionalDependencies` | skipped, and the skip is reported |
| native builds (`node-gyp`, `install` scripts) | never run |
| `publish`, `outdated`, `audit`, `workspaces` | absent |
| tarballs that are not gzip | rejected with `ETARBALL` before anything is unpacked |
| an explicit `package/` root directory entry | skipped: `npm pack` does not emit one, other packers do, and it describes the directory tuckbox is already writing into |
| executable bits in an archive | cleared on unpack (`0o666` file mask, no setuid/setgid). tuckbox creates no `.bin` links and onde cannot spawn a process, so nothing depends on the bit |
| `file:`, `git:`, `http:` specs | rejected: only registry ranges and exact versions |

The lockfile is written by tuckbox only. A `package-lock.json` from npm is ignored rather than
half-read.

## 6. Testing

```sh
pnpm test                  # every suite under node AND onde, outputs compared
TUCKBOX_NET=1 pnpm test    # adds the real-registry suite
```

`test/run.js` runs each `test/*.test.js` under both runtimes and requires identical output, so
node is the oracle: a module leaning on an onde-only behaviour fails against node, and one leaning
on a node-only behaviour fails against onde.

| Suite | Assertions | What it proves |
|---|---|---|
| `semver` | 244 | ranges, prerelease rules, ordering; 7,373 differential checks against npm's own semver during development |
| `tar` | 68 | ustar prefix, pax `x`/`g`, GNU `L`/`K`, base-256 sizes, and every unsafe-path rejection |
| `store` | 54 | integrity, atomic unpack, idempotency, hardlinks, `ETARBALL` for links and non-gzip |
| `registry` | 57 | a fixture registry: accept header, redirects, scoped names, cache hits, 404 mapping |
| `lockfile` | 46 | round trip, byte-identical serialization, atomic write, validation errors |
| `install` | 35 | end to end over a conflict graph: hoist, nest, hardlinks, `ci` refusal, `--prod`, `ETARGET` |
| `real-registry` | 19 | opt-in: `left-pad`, `debug`+`ms`, `chalk`+5 installed from npm and `require`d |

The `install` suite is the important one. Its fixture registry serves real ustar+gzip tarballs for a
graph with a genuine conflict (`root -> a -> b@^1`, `root -> c -> b@^2`), and the assertions are
made by `require`ing the installed packages: `a` must see `b@1.5.0` and `c` must see `b@2.0.0`, so
the layout is proven by two module resolvers rather than by comparing path strings.

## 7. Module layout

TypeScript in `src/`, compiled to CommonJS in `dist/` by `pnpm build`. onde runs the compiled
output, so the demo depends on no loader feature onde lacks, and the source gets real types on the
`fs`/`https`/`zlib` calls that onde provides.

```
tuckbox/
  bin/tuckbox.js     launcher: requires dist/cli.js (and says so when dist/ is missing)
  src/cli.ts         argv parsing, dispatch, exit codes
  src/commands.ts    install, ci, add, remove, ls
  src/types.ts       packument, lockfile and tar-entry shapes
  src/lib/semver.ts  parse, compare, satisfies, maxSatisfying        (pure)
  src/lib/tar.ts     ustar/pax/GNU-long reader                       (pure)
  src/lib/store.ts   sha512, integrity, unpack, hardlink farm        (fs)
  src/lib/registry.ts packument and tarball fetch over http/https    (net)
  src/lib/lockfile.ts read/write/serialize the v1 lockfile           (fs)
  src/lib/manifest.ts read/rewrite package.json                      (fs)
  src/lib/resolve.ts graph resolution + hoist/nest placement
  src/lib/install.ts lockfile -> node_modules
  test/              one *.test.js per module; the harness runs each under node and onde
```

The dependency direction is strictly downward: `resolve` knows about `semver` and `registry`;
`install` knows about `store` and `lockfile`; `tar` and `semver` know nothing at all. That is what
makes the pure half testable under two runtimes.

`test/run.js` executes every `test/*.test.js` under **both** node and onde and requires identical
output. node is the oracle: a module that leaned on an onde-only behaviour fails against node, and
one that leaned on a node-only behaviour fails against onde.

