# Conformance corpus

Each suite is a directory of `<case>.js`, `<case>.cjs` or `<case>.mjs` programs plus a
`<case>.expected` file containing the ordered stdout lines and a final `exit:<code>` line.
For `.js` cases the expected file drops the extension (`cjs01-basic.expected`); `.mjs` and
`.cjs` cases keep it (`esm01-basic.mjs.expected`).

```
microtasks/   ADR-0002's 12-case ordering corpus (the load-bearing contract)
timers/       setTimeout/setInterval/setImmediate, clear, ref/unref, clamp, args/this
loop/         exit, exitCode, beforeExit revival, phase ordering
nexttick/     process.nextTick priority and re-drain
uncaught/     uncaughtException dispatch and default fatal output
rejections/   unhandledRejection / rejectionHandled protocol
modules/      CJS/ESM entries, resolution, cycles, interop, import.meta, TLA
stdlib/       path, url, util, assert, events, buffer, os, console, process, module, …
zlib/         gzip/zlib/raw-deflate round trips, crc32 and coded errors
sqlite/       node:sqlite: schema, types, bindings, iterators, limits, backup, coded errors
divergences/  deliberate differences; expectations recorded from onde
```

253 cases total. The Node self-test skips `divergences/` (13 cases) and the one `.nodiff` case,
so the differential harness compares 239.

## Running

```sh
./test/conformance/run.sh                    # onde against the recorded expectations
RUN=node ./test/conformance/run.sh           # prove the expectations still describe Node
REGEN=1 RUN=node ./test/conformance/run.sh   # re-record from Node (never from onde)
./test/differential.sh                       # node vs onde, same stdout + exit code
SUITES="modules stdlib" ./test/conformance/run.sh
```

Recording and the Node self-test both mean the **official** Node build. A distributor can differ in
the edges the corpus pins — Homebrew's `node` devendors V8's simdutf and stops masking code units in
the legacy base64/hex decoders — see [docs/internals.md](../../docs/internals.md) §3.

`divergences/` is excluded from the Node self-test and the differential harness. To record it:

```sh
SUITES=divergences RECORD_DIVERGENCES=1 REGEN=1 ./test/conformance/run.sh
```

Divergence cases are small and cite their D-number from [docs/compat.md](../../docs/compat.md) in a
comment. A new deliberate difference should add one.

## `.nodiff`

A case whose Node output depends on wall-clock timing carries `<case>.nodiff`. Node's own result
for a clamped 0 ms timer racing a top-level `setImmediate` can flip between runs; onde applies
the deterministic due-time rule from ADR-0003 §5. The Node self-test and differential harness
skip these files; onde still asserts its own stable order.

## Adding a case

1. Write the smallest program that isolates one behaviour.
2. Prefer stdout assertions over stderr: fatal stderr is Node-_shaped_, not byte-identical
   (V8 internal frames do not exist in QuickJS).
3. Record from Node, then run the onde and differential modes.
4. If Node is timing-dependent, keep the case and add a `.nodiff` marker with a comment
   explaining why.
5. Module fixtures belong in a subdirectory (`fixtures/`, `node_modules/`), never at the suite
   root: everything at the root ending in `.js`/`.cjs`/`.mjs` is a case.
