# ADR-0004 — Module system: native ESM, a JavaScript CJS loader, one resolver

**Status:** accepted (2026-11-13, M2)
**Supersedes:** the "open" decision in roadmap §6
**Related:** [0001](0001-engine-baseline.md) (engine), [0002](0002-microtask-scheduler.md) (jobs),
[0003](0003-event-loop.md) (loop)

## Context

M2 must run the module ecosystem, not a subset of it:

- ESM with top-level await, live bindings, `import.meta` and dynamic `import()`.
- CJS with `require`, the wrapper function, `module.exports`, `node_modules` walking, extension
  and `index` lookup, `package.json` (`main`, `exports`, `type`), JSON, and a cache.
- Interop in both directions, because real dependency graphs mix them.
- Resolution must be testable without QuickJS: `exports`/`imports` maps and their condition
  ordering are where compatibility bugs hide.

QuickJS gives us native modules: `JS_Eval` with `JS_EVAL_TYPE_MODULE`, `JS_SetModuleLoaderFunc2`
for resolution/loading, and `import()` supported by the engine. It does **not** give us CJS, a
resolver, `package.json` semantics, or interop. Those are the decision.

## Decision

### 1. ESM is native, and canonical module names are URLs

A module's name is its identity in the engine's module map, and it is what `import.meta.url`
reports. We use:

- `file:///abs/path.js` for disk modules (percent-encoded, `pathToFileURL` rules),
- `node:path` for builtins.

Relative specifiers are resolved against the importing module's name (a URL), which is exactly
what QuickJS's loader callback hands us as `base`. `import.meta.filename`/`dirname` are set on the
declared module before evaluation (`Module::meta()`), so they are present even under TLA.

The resolver picks the format before the loader reads the file: `.mjs` → ESM, `.cjs` → CJS,
`.js` → the nearest `package.json` `"type"`, `.json` → JSON, `.node` → a clear
`ERR_DLOPEN_FAILED`. `require()` of anything resolving to ESM fails with `ERR_REQUIRE_ESM`
before evaluation.

### 2. Resolution is an engine-free crate: `ln-modules`

`ln-modules` owns the two Node algorithms (CJS `require`, ESM resolution), `package.json`
parsing, `exports`/`imports` maps, condition matching, file-URL round-tripping, and the CJS
named-export scan. It has no `rquickjs` dependency, so the ~50 resolution tests run in
milliseconds and do not need the engine.

`ln-runtime` adapts `Resolver`/`Loader` to QuickJS: it stores the resolver's result under the
canonical name, reads sources, generates facades, and throws Node-shaped errors (with `code`)
from the callbacks.

Why not a third-party resolver (`oxc_resolver`, as R4 suggested)? It would still need onde's
`package.json` type lookup, CJS extension semantics and the `require` cache, and it would add a
large dependency to a runtime whose value proposition is a small binary. The surface we need is
Node's documented algorithm, and it has one implementation here.

### 3. CJS is a JavaScript loader; Rust only compiles

`js/lib/loader.js` owns the module records, `module.exports`, `require.cache`, `module.children`,
`require.resolve`, `require.main`, `node_modules` search-path metadata, JSON loading, and the
builtin registry. This is the browser-cjs shape, and it keeps the Node semantics reviewable as
JavaScript.

Rust contributes exactly one thing the JS loader cannot do: **compiling with a real filename**.
`host.evalCjs(filename, source, exports, require, module, __dirname)` wraps the source in Node's
`(function (exports, require, module, __filename, __dirname) { ... })` and evaluates it with the
file's path as the engine filename. That is what makes CJS stack traces say `/app/lib/x.js:12`
instead of `<eval>:1`.

Two details from Node's wrapper are reproduced:
- the prefix has no newline, so user line 1 stays line 1 (the renderer subtracts the prefix from
  line-1 caret columns, as Node does),
- the wrapper is called with `this === module.exports`.

### 4. Interop is generated source, evaluated by the engine

QuickJS has no API to build a module namespace from Rust values, so interop is source:

- ESM importing CJS: `const ns = __ln_cjs_namespace(path); export default ns;` plus
  `export const name = ns.name` for names found by the static scan.
- ESM importing a builtin: `const ns = __ln_builtin_exports("node:path"); ...` with the same
  generated named exports.
- JSON: `const data = JSON.parse(<literal>); export default data;`.

The scan is `ln-modules::scan_named_exports`, a small lexer-like pass over `exports.x`,
`module.exports.x`, bracket assignments, `Object.defineProperty(exports, "x")` and
`module.exports = { x, ... }`. It skips comments and strings. It deliberately misses
`Object.assign`, loop-built names and re-exports; those remain reachable through `default`, and
the limits are documented (D17).

Snapshots rather than live bindings: `export const name = ns.name` copies the value at link
time, as Node's CJS facade does for values read once. Mutating `module.exports.foo` later does
not update the ESM binding.

### 5. `require()` of ESM is rejected, `import()` of CJS works

Node 22+ supports `require(esm)` for synchronous graphs. onde does not: evaluating an ESM graph
synchronously inside a running CJS call would require pumping the engine's job queue
re-entrantly, which ADR-0002 forbids (the checkpoint owns the queue). The rejection is explicit
(`ERR_REQUIRE_ESM` with the dynamic-import hint), not a confusing "not found". Dynamic
`import()` from CJS works because it is queued as a normal module job.

This is divergence D16 in `docs/compat.md`. `require(esm)` becomes tractable when M6 moves job
ownership to the host, because the CJS loader will be able to settle a module graph without
violating I1.

## Consequences

- **Deterministic startup.** Builtins are lazy: only the modules the entry actually requires are
  compiled, so `lite -e '1+1'` still pays for bootstrap, not the stdlib.
- **Two loaders, one resolver.** Resolution behaviour is identical for `require` and `import`
  except where Node differs (extensions, directories, conditions); that difference lives in
  `Kind`, not in duplicated code.
- **Interop is heuristic, like Node's.** The named-export scan has the same class of false
  negatives as `cjs-module-lexer`; `default` is always reliable.
- **The engine's module map is the cache for ESM.** CJS has its own `require.cache`. Requiring
  the same file both ways evaluates it once per system; Node has the same split (ESM and CJS
  caches are separate).
- **Tests are cheap where it matters.** `cargo test -p ln-modules` covers resolution without an
  engine; the conformance corpus covers the observable behaviour under both `node` and `lite`.
