# Native candidates in `js/lib`

Which JavaScript modules are worth moving into the host, measured rather than guessed. The moving
part is the ratio against the engine baseline: on this machine a plain JS loop runs at ~1.3x Node
and an allocation-heavy one at ~12x, so **~12x means "this is what QuickJS costs" and the hundreds
mean "this implementation is the problem"**.

Reproduce with `BENCH_REPS=3 node test/bench/run.js` (the `lib.js` section), release build, medians
of three.

## Ranked

| module | operation | onde vs Node | onde per call | verdict |
|---|---|---|---|---|
| `buffer.js` | `indexOf` over 1 MB | 2204x | **40 ms** | move to the host |
| `buffer.js` | `from(base64)` 1 KB | 1152x | 196 µs | move to the host |
| `string_decoder.js` | `write` 1 KB | 580x | 133 µs | fix the scan, not the module |
| `buffer.js` | `toString("base64")` 1 KB | 485x | 80 µs | move to the host |
| `buffer.js` | `compare` 1 KB | 3535x | 28 µs | same primitive as `indexOf` |
| `buffer.js` | `readUInt32LE` | 232x | 0.23 µs | cheap, low value |
| `buffer.js` | `toString("hex")` 1 KB | 227x | 129 µs | move to the host |
| `url.js` | `new URL()` parse | 78x | 20 µs | 1.2 |
| `assert.js` | `deepStrictEqual` | 50x | 8 µs | not a native candidate |
| `path.js` | `parse` / `join` | 36x / 18x | 6 / 3 µs | 1.2 |
| `util.js` | `inspect` | 28x | 22 µs | algorithm, not native |
| `util.js` | `format` | 27x | 1 µs | no |
| `querystring.js` | `parse` | 19x | 2 µs | 1.2 |
| `punycode.js` | `toASCII` | 17x | 13 µs | feeds `url` |

Already moved: the UTF-8 codec (`textcodec.js`, `buffer.js` encode/decode), which took
`readFileSync(path, "utf8")` on 1 MB from 142 ms to 0.4 ms.

## Tier 1: worth doing now

**`buffer.js` search and codecs.** `indexOf`/`includes`/`lastIndexOf` are JavaScript byte loops;
40 ms to scan 1 MB is the single worst cost in the runtime, and `indexOf` on a buffer is ordinary
code. base64 and hex are also byte-at-a-time loops with a lookup table. All of these are memchr,
memcmp and a 64-entry table in Rust, and they share one host module.

**`string_decoder.js`.** Not a port: the module already calls the native decoder, but it scans the
chunk in JavaScript to find how many trailing bytes form an incomplete sequence, which is 1024
iterations per 1 KB chunk. It needs the boundary found in Rust, in the same call that decodes
(`{ text, pending }`), not a second pass. This is the path behind `stream.setEncoding("utf8")` and
every text `fs.createReadStream`.

## Why not port the whole `buffer` module

The obvious follow-up is "Buffer is used everywhere, so move all of it". Two measurements say no,
and one of them contradicts the assumption that the class is what costs memory.

A host call costs **103 ns** against **44 ns** for a JavaScript call, so a method only pays when its
own work per call is above roughly a microsecond:

| method | onde per call | verdict |
|---|---|---|
| `indexOf` over 1 MB | 40 ms | move |
| `from(base64)` 1 KB | 196 µs | move |
| `toString("hex")` 1 KB | 129 µs | move |
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
