# tuckbox

A small npm. It reads a `package.json`, resolves the dependency graph against the npm registry, and
writes a `node_modules` tree, using only `fs`, `https`, `zlib`, `path` and `process`.

```sh
pnpm build
../target/debug/lite bin/tuckbox.js install      # run it on onde
node bin/tuckbox.js install                      # or on node, same output
```

| Command | Behaviour |
|---|---|
| `tuckbox install` | resolve `package.json`, write `tuckbox.lock.json`, rebuild `node_modules` |
| `tuckbox ci` | install exactly what the lockfile says, and fail if it disagrees with `package.json` |
| `tuckbox add <name>[@range]` | add a dependency and install |
| `tuckbox remove <name>` | drop a dependency and install |
| `tuckbox ls` | print the resolved tree |

`--registry <url>`, `--prod` (skip `devDependencies`), `--verbose`. Exit codes: `0` ok, `1` a
failure you can act on, `2` usage.

## Why it is shaped this way

### TypeScript, compiled to CommonJS

The source is `src/`, the thing that runs is `dist/`. onde executes the compiled CommonJS output, so
the demo does not depend on a loader feature onde lacks. `pnpm build` is the only build step.

### node_modules, not a store layout

Onde's resolver walks `node_modules` upward and canonicalizes real paths, so the tree has to be a
`node_modules` tree. A pnpm-style isolated layout would need a resolver change and a symlink farm,
and buys this demo nothing.

### A content-addressed store with hardlinks

Tarballs are unpacked once into `.tuckbox/store/<sha512>` and hardlinked into place. Hardlinks keep
`realpath` canonical, so resolution, `__dirname` and any bundler see an ordinary install. A symlink
farm would break all three. Across filesystems `link` fails with `EXDEV` and tuckbox copies instead.

### The lockfile is the only input to `ci`

Entries are keyed by install path, so replaying a tree needs no range lookup and no trust in the
registry's current metadata. `install` and `ci` both rebuild `node_modules` from scratch, which is
why a stale package cannot survive a run.

### Whole-buffer zlib

`node:zlib` on onde has no streaming inflate yet, so peak memory for one package is its compressed
size plus its unpacked size. That is recorded in [docs/tuckbox.md](../docs/tuckbox.md), and a
streaming `Inflate` is the fix.

## What it does not do

It skips lifecycle scripts, `.bin` links, peer and optional dependencies, native builds, publishing
and workspaces. `file:`, `git:` and `http:` specs are rejected with a clear error. The full list,
with the behaviour for each, is in [docs/tuckbox.md](../docs/tuckbox.md) §5.

## Tests

```sh
pnpm test                  # every test/*.test.js under node AND onde, outputs compared
TUCKBOX_NET=1 pnpm test    # adds the real-registry suite
```

Each test is a plain CommonJS file that prints `ok <name> <n> assertions`. The harness runs it on
both runtimes and requires identical output, so a module that leaned on an onde-only behaviour fails
against node, and one that leaned on a node-only behaviour fails against onde.
