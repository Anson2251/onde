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
divergences/  deliberate differences; expectations recorded from lite-node
```

113 cases total (M1: 72, M2: 41). The Node self-test skips `divergences/` (9 cases) and any
`.nodiff` case, so the differential harness compares 103.

## Running

```sh
./test/conformance/run.sh                    # lite against the recorded expectations
RUN=node ./test/conformance/run.sh           # prove the expectations still describe Node
REGEN=1 RUN=node ./test/conformance/run.sh   # re-record from Node (never from lite)
./test/differential.sh                       # node vs lite, same stdout + exit code
SUITES="modules stdlib" ./test/conformance/run.sh
```

`divergences/` is excluded from the Node self-test and the differential harness. To record it:

```sh
SUITES=divergences RECORD_DIVERGENCES=1 REGEN=1 ./test/conformance/run.sh
```

Divergence cases are small and cite their D-number from [docs/compat.md](../compat.md) in a
comment. A new deliberate difference should add one.

## `.nodiff`

A case whose Node output depends on wall-clock timing carries `<case>.nodiff`. Node's own result
for a clamped 0 ms timer racing a top-level `setImmediate` can flip between runs; lite applies
the deterministic due-time rule from ADR-0003 §5. The Node self-test and differential harness
skip these files; lite still asserts its own stable order.

## Adding a case

1. Write the smallest program that isolates one behaviour.
2. Prefer stdout assertions over stderr: fatal stderr is Node-*shaped*, not byte-identical
   (V8 internal frames do not exist in QuickJS).
3. Record from Node, then run the lite and differential modes.
4. If Node is timing-dependent, keep the case and add a `.nodiff` marker with a comment
   explaining why.
5. Module fixtures belong in a subdirectory (`fixtures/`, `node_modules/`), never at the suite
   root: everything at the root ending in `.js`/`.cjs`/`.mjs` is a case.
