# Native candidates in `js/lib`

> Execution order, host contracts and the interaction with the deduplication work live in
> [stdlib-consolidation-plan.md](stdlib-consolidation-plan.md). This page stays the measurement
> appendix for the native track.

Which JavaScript modules are worth moving into the host, measured rather than guessed. The moving
part is the ratio against the engine baseline: on this machine a plain JS loop runs at ~1.3x Node
and an allocation-heavy one at ~12x, so **~12x means "this is what QuickJS costs" and the hundreds
mean "this implementation is the problem"**.

Reproduce with `BENCH_REPS=3 node test/bench/run.js` (the `lib.js` section), release build, medians
of three.

## Ranked

Ratios and per-call costs are the **pre-move** measurements that justified the work. The
post-move numbers are in "B1/B2 rebench" below.

| module | operation | onde vs Node | onde per call | verdict |
|---|---|---|---|---|
| `buffer.js` | `from(base64)` 1 KB | 1152x | 196 µs | moved (B1) |
| `string_decoder.js` | `write` 1 KB | 580x | 133 µs | moved (B2) |
| `buffer.js` | `toString("base64")` 1 KB | 485x | 80 µs | moved (B1) |
| `buffer.js` | `readUInt32LE` | 232x | 0.23 µs | cheap, low value |
| `buffer.js` | `toString("hex")` 1 KB | 227x | 129 µs | moved (B1) |
| `url.js` | `new URL()` parse | 78x | 20 µs | 1.2 |
| `assert.js` | `deepStrictEqual` | 50x | 8 µs | not a native candidate |
| `path.js` | `parse` / `join` | 36x / 18x | 6 / 3 µs | 1.2 |
| `util.js` | `inspect` | 28x | 22 µs | algorithm, not native |
| `util.js` | `format` | 27x | 1 µs | no |
| `querystring.js` | `parse` | 19x | 2 µs | 1.2 |
| `punycode.js` | `toASCII` | 17x | 13 µs | feeds `url` |

Already moved: the UTF-8 codec (`textcodec.js`, `buffer.js` encode/decode), which took
`readFileSync(path, "utf8")` on 1 MB from 142 ms to 0.4 ms; `Buffer.indexOf`/`lastIndexOf`, which
took a 1 MB byte scan from 40 ms to 10 µs (now 0.6x Node, because the search is a borrowed slice
rather than a copy); and `Buffer.compare`/`equals`, from 28 µs to 0.55 µs per 1 KB comparison
(3449x to 69x Node, the remainder being six-argument host calls and the borrow setup).

All three were checked against a randomized reference before being trusted: 12,016 assertions for
search and comparison together (3,500 generated cases), and 3,011 for UTF-8 (1,500 generated strings
and byte arrays). Each
arm validates a different thing, Node's implementation validates the reference and onde's validates
the host, and both were mutation-tested by breaking the host and watching them fail.

B1/B2 added base64/hex and the `StringDecoder` boundary; their rebench is below.

## B1/B2 rebench

Release build at `5450b0d`, `BENCH_REPS=5 node test/bench/run.js`, medians of five runs, 1 KB
payload. Per call is the benchmark total divided by its iteration count (20k for the Buffer
operations, 50k for `write`); "before" is the JavaScript loop above.

| Workload | Node 26 | onde before | onde now | vs Node | vs before |
|---|---|---|---|---|---|
| `Buffer.from(base64)` | 0.17 µs | 196 µs | 3.1 µs | 18.8x | 63x |
| `Buffer.toString("base64")` | 0.16 µs | 80 µs | 1.2 µs | 7.2x | 69x |
| `Buffer.toString("hex")` | 0.56 µs | 129 µs | 1.7 µs | 3.0x | 77x |
| `Buffer.from(hex)` | 0.63 µs | — | 2.1 µs | 3.4x | — |
| `StringDecoder.write` | 0.23 µs | 133 µs | 2.0 µs | 8.8x | 67x |

What remains is the host boundary, not the codec: string-to-Rust conversion and the fresh
`Uint8Array` for decodes dominate the 2–3 µs. `TextDecoder` with `stream: true` still keeps its
JavaScript state machine; B2 covered `StringDecoder`, which is the stream path behind
`setEncoding("utf8")`.

## Tier 1: landed (B1/B2)

**`buffer.js` codecs.** Base64 encode/decode and hex encode are native; the standard 4-to-3
packing uses the `base64` crate, while hex stays a local table loop. `Buffer.from(hex)` decode was
not measured pre-move; it is now 2.1 µs. `fill` remains JavaScript (no measured win above the
host-call floor).

**`string_decoder.js`.** `write` now makes one host call that returns `{ text, pending }`; the
JS state machine remains only for the node-test fallback. The path behind
`setEncoding("utf8")` and text `fs.createReadStream` dropped from 133 µs to 2.0 µs per 1 KB.

See "B1/B2 rebench" for the numbers; the execution plan is
[stdlib-consolidation-plan.md](stdlib-consolidation-plan.md).

## Why not port the whole `buffer` module

The obvious follow-up is "Buffer is used everywhere, so move all of it". Two measurements say no,
and one of them contradicts the assumption that the class is what costs memory.

A host call costs **103 ns** against **44 ns** for a JavaScript call, so a method only pays when its
own work per call is above roughly a microsecond:

| method | onde per call | verdict |
|---|---|---|
| `indexOf` over 1 MB | 40 ms | move |
| `from(base64)` 1 KB | 196 µs | moved (B1) |
| `toString("hex")` 1 KB | 129 µs | moved (B1) |
| `compare` 1 KB | 28 µs | move |
| `readUInt32LE` | 0.23 µs | marginal |
| `from(array)`, `slice`, `concat`, coercion | 50-100 ns | leave: the boundary costs more than the work |

Peak RSS for 300,000 live objects (a control run subtracted):

| | onde | Node |
|---|---|---|
| `new Uint8Array(13)` | 411 B | 483 B |
| `Buffer.allocUnsafe(13)` | 411 B | 254 B |
| `Buffer.from("hello world!")` | 414 B | 274 B |

`Buffer` costs the same as a plain `Uint8Array` here, so the JavaScript subclass is not the
overhead: the per-typed-array allocation is. Node's 254 B comes from pooling small allocations out
of an 8 KB slab, which is a change to `allocUnsafe` in JavaScript (ADR-004 records that onde has no
pool), not a reason to make the class native.

Element access settles it. `buf[i]`, iteration, and handing a view to `crypto`, `zlib` or `fs` all
rely on `Buffer` being a real `Uint8Array`; the subclass inherits that, and a plain `JS_NewClass`
object would have to reimplement it with an exotic typed array to avoid a host call per element.

## Tier 2: 1.2

**`url.js`** (78x, 2695 lines). The largest single win left, and the riskiest: WHATWG has hundreds
of edge cases and the corpus already asserts them. Worth a milestone, not an afternoon.

**`path.js`, `querystring.js`, `punycode.js`.** 17x to 36x, small absolute cost per call. Cheap to
do, but they matter only in loops over many paths or queries.

## Not native candidates

`util.js` (`format`, `inspect`), `assert.js` (`deepStrictEqual`), `events.js`, `console.js` and the
`module`/`loader` path. Node implements these in JavaScript too, so the 25x to 50x measured here is
the engine and object overhead, not a JavaScript-versus-native gap. A Rust `inspect` would win on
large objects and lose on small ones, and `deepStrictEqual` is dominated by property access on JS
objects, which a host function cannot avoid.

`stream.js`, `http.js`, `net.js` and `fs.js` are deliberately out: they are the compatibility
contract (event order, backpressure, `Duplex` semantics), their cost is per request rather than per
byte, and the parsers and syscalls underneath are already native. The server's real problems are
JS-bound throughput and per-connection memory, which lazy state addresses better than a port.

## Rule of thumb

Move a module when its ratio is in the hundreds **and** the operation is per byte or per element.
When the ratio is near the engine baseline, the code is already as fast as JavaScript gets on this
engine, and the remaining cost is the object model.
