# `test/ffi` — the `onde:ffi` matrix

```sh
./test/ffi/run.sh                  # the whole suite
ONDE=target/release/onde ./test/ffi/run.sh
FFI_FEATURE_CHECK=0 ./test/ffi/run.sh   # skip the --no-default-features build
```

`run.sh` builds the C fixture (`fixture/fixture.c`) and the layout oracle (`layout.c`) into a
temporary directory, then runs the JavaScript files under `onde`:

| file | covers |
|---|---|
| `inference.test.js` | §4: declarations, typed values, the inference table, float-tag refusal, missing arguments, shape limit, signature conflicts |
| `call.test.js` | §2/§7: scalar round-trips, 64-bit edges, floats, pointers, variadics, `errno`, `buffer`/`buffer_length`, symbol and `dlopen` failures, `fn`, string aliases, `close` |
| `struct.test.js` | §5: layout against the C oracle, by-value arguments/returns, `ref` out-params, views, nested and array fields, `define`, recursion, coercion, reserved names |
| `callback.test.js` | §9: inline invocation, N calls, pointer arguments, reentrancy, exception parking, void returns, in-flight close refusal, `threadsafe` refusal |
| `memory.test.js` | §8: `alloc`/`free`, borrowed external buffers, `CString`, one-shot reads, deallocator-backed buffers, `close` liveness |
| `json.test.js` | §6: envelopes, `toJSON`/`toPlain`, `fromJSON`, `revive`, codecs, pointer rules |
| `sqlite.test.js` | §2.1: the sqlite3 example, skipped when the system library is absent |

The last three checks in `run.sh` are not JavaScript: a `--no-default-features` binary must not
resolve `onde:ffi`, `require("node:ffi")` must not resolve either, and the `ffi.load` permission
must deny and then grant `dlopen`.

`bench.js` prints per-call overhead; it is not part of the pass/fail suite because a shared CI
runner measures the runner (the same rule `test/perf` follows).

The fixture's export table and the oracle's output format are documented in
`fixture/README.md`.
