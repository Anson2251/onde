# Stdlib consolidation and native migration plan

Status: **accepted as an M7 task, 2026-11-23.** Baseline: `./test/js/run.sh` reports
`77 passed, 0 failed` under `node v26.12.1` and `target/debug/onde`. Phases A0–A5 and B1–B2 are
M7 work; C1–C2 are 1.2.

This plan merges two pieces of work that were being planned separately:

* the JavaScript deduplication audit (`js/lib` re-derives the same helpers, codecs and option
  parsers), and
* the native-candidate ranking in [native-candidates.md](native-candidates.md) (which per-byte
  operations are worth moving into Rust).

They are one move because they meet at the same seam. The duplicated byte code is also the slow
byte code, and the native migration needs exactly the single module the deduplication wants to
create. Doing either alone means doing part of it twice.

[native-candidates.md](native-candidates.md) remains the measurement appendix: its ratios, RSS
numbers and host-call cost are the inputs to this plan. This page is the execution order.

## 1. The finding in one page

### 1.1 Duplication

Measured over `js/` (41 files, 29,809 lines including `bootstrap.js` and the five
`lib/internal/*` modules):

| Measurement | Value |
|---|---|
| `function` declarations | 1,127 |
| distinct function names | 938 |
| names defined in two or more files | 105 (294 definitions) |
| exact-body clone clusters (comments, whitespace and literals normalised) | 28 |
| lines in those clusters / redundant copies | 587 / 347 |
| largest exact clone | `utf8DecodeBytes`, 64 lines, verbatim in two modules |
| `invalidArgType` definitions | 22 copies, 12 distinct bodies |
| `invalidArgValue` / `describeValue` / `codedError` | 11 / 9 / 8 copies |
| `requireInternal` shims | 12 copies, plus `EMBEDDED` in 13 modules |

The line count understates the cost. The cost is **drift**: two implementations of one Node rule
can disagree, and a fix has to be found and applied in every copy. Two examples already in the
tree:

* `js/lib/internal/fs.js:111` (called with `options.signal` at `:228`) renders the error as
  `The "options.signal" argument ...`. Node — and `crates/ln-error/src/lib.rs:104` — says
  **property** when the name contains a dot.
  `crypto`/`zlib` already implement the property rule, so the same caller mistake produces two
  different messages depending on the module.
* `buffer.js:61`, `textcodec.js:50`, `crypto.js:118` and `readline.js:70` all throw
  `ERR_INVALID_ARG_TYPE` with different `Received ...` renderings (`type function (name)` vs
  `function name`, `an instance of X` vs `type object`). `assert.oracle.js` and
  `globals.oracle.js` compare `error.message`, so this is test surface too.

### 1.2 Native gaps

From [native-candidates.md](native-candidates.md), release build, medians of three:

| module | operation | onde vs Node | onde per call | verdict |
|---|---|---|---|---|
| `buffer.js` | `from(base64)` 1 KB | 1152x | 196 µs | move to the host |
| `string_decoder.js` | `write` 1 KB | 580x | 133 µs | fix the boundary scan in the host |
| `buffer.js` | `toString("base64")` 1 KB | 485x | 80 µs | move to the host |
| `buffer.js` | `toString("hex")` 1 KB | 227x | 129 µs | move to the host |
| `url.js` | `new URL()` parse | 78x | 20 µs | 1.2 |
| `assert.js` | `deepStrictEqual` | 50x | 8 µs | not a native candidate |
| `path.js` | `parse` / `join` | 36x / 18x | 6 / 3 µs | 1.2 |
| `util.js` | `inspect` | 28x | 22 µs | algorithm, not native |
| `querystring.js` | `parse` | 19x | 2 µs | 1.2 |
| `punycode.js` | `toASCII` | 17x | 13 µs | feeds `url` |

Already native: UTF-8 encode/decode (`host.text`), `Buffer.indexOf`/`lastIndexOf`,
`Buffer.compare`/`equals`. A host call costs **103 ns** against **44 ns** for a JS call, so a
method only pays when its own work is above roughly a microsecond; that is why the Buffer class
itself stays JavaScript.

### 1.3 The overlap is the plan

| Duplicated in JS | Also slow | Seam that fixes both |
|---|---|---|
| `hexEncode` / `base64Encode` (`buffer`, `string_decoder`) | 1152x / 227x | one `internal/bytes` module, native behind it |
| `utf8DecodeBytes` ×2 (`querystring`, `url`) | decoder is native already | call `textcodec.decodeUTF8` once |
| `string_decoder` scan before the native decode | 580x | one host call returning `{ text, pending }` |
| `toBytes` / `concatBytes` / aliases ×4 | not the bottleneck | one fallback home for the native path |

Doing the native move first would add host branches to four modules and leave their duplicate
fallbacks in place. Doing the dedup first creates the single module the host branch belongs in.
**Order: seam first, native behind it.**

## 2. Strategy

### 2.1 Rules

1. **JavaScript keeps the contract.** Argument validation, clamping, event order, error text,
   `Buffer` as a `Uint8Array` subclass, stream state machines, and the public shapes stay in JS.
2. **Rust owns per-byte work.** Move an operation when its ratio is in the hundreds *and* its work
   is per byte or per element. A host call has to save more than ~100 ns to pay.
3. **One seam per codec family, one fallback.** Every native codec has exactly one JS entry point
   and one JS fallback. Node tests exercise the fallback; `onde` exercises the native path.
4. **Don't restructure the hold zone.** Modules scheduled for a native parser replacement
   (`url`, `path`, `querystring`, `punycode`) get no structural refactor; only the exact-clone
   decoder swap and shared helpers they will consume.
5. **Errors before native errors.** Native operations must not invent a second error vocabulary;
   the JS validators throw one taxonomy, and host codec failures are programming errors.
6. **Use the standard crate for the standard algorithm.** `base64` is already in the lock through
   the TLS stack; the RFC 4648 encoder/decoder uses it. Keep only Node's non-standard sanitizer
   (junk characters, both alphabets, no code-unit masking since Node 26.13) local. Hex has no crate
   in the graph and is a twenty-line loop.

### 2.2 Tracks

```
Track A — JS structure (deduplication)
  A0 loader virtual resolution ─┬─▶ A1 internal/errors ─▶ A2 internal/bytes seam ─▶ A5 guardrail
                                │            │                     │
                                │            ├─▶ A4 residual       └─▶ B1 ─▶ B2
                                └─▶ A3 fs option parsers (any time after A0)

Track B — native Tier 1 (M7)
  B1 buffer base64/hex/fill behind A2 ─▶ B2 string_decoder boundary

Track C — native Tier 2 (1.2)
  C1 path/querystring/punycode ─▶ C2 url
```

A0 is first because the new `internal/*` modules need ordinary relative requires. A1 is next
because every module validates arguments. A2 creates the seam. B1 and B2 fill it. A3 and A4 are
independent after A0/A1. A5 locks the shape. C starts only after B, and is a 1.2 milestone.

### 2.3 What this plan deliberately does not move

* The `Buffer` class, its validation, `slice`/`concat`/coercion. The allocation study in
  [native-candidates.md](native-candidates.md) shows the class is not the cost; a host call per
  element access would be worse than a `Uint8Array` subclass.
* `events`, `stream`, `http`, `net`, `fs`. They are the compatibility contract; their cost is per
  request, and the parsers and syscalls beneath them are already native.
* `util.inspect`, `util.format`, `assert.deepStrictEqual`, `console`. Node implements these in
  JavaScript too; the gap is the engine, not the language.
* The `module`/`loader` path, for the same reason.
* Small per-call methods such as `readUInt32LE` (0.23 µs) and `Buffer.from(array)`; the host
  boundary costs more than the work.

## 3. Target shape

### 3.1 JavaScript

```
internal/errors.js      no requires        coded(), argument errors, abortError, describe
internal/bytes.js       -> errors          Buffer codec seam: aliases, utf16le/latin1/ascii/
                                           hex/base64, concat, byte views; host.buffer when
                                           present, one JS fallback otherwise
textcodec.js            -> bytes           UTF-8 seam (host.text, already native) + WHATWG
                                           labels/streaming; no second one-shot decoder
buffer.js               -> textcodec,bytes,errors
string_decoder.js       -> textcodec,bytes,errors   streaming state stays here
querystring.js, url.js  -> textcodec,errors          decoder swap only; hold zone
internal/fs.js          -> errors,bytes   + the fs option parsers
fs.js, fs-promises.js   -> internal/fs
crypto.js, zlib.js      -> errors,bytes
```

`internal/errors.js` is the only pure leaf. `internal/bytes.js` is allowed to touch
`globalThis.__ln_host.buffer`; `textcodec.js` already touches `__ln_host.text`. Those are the two
seams, and no other module reaches for a codec host directly.

### 3.2 Rust

```
crates/ln-runtime/src/host/
  codec.rs        new, private: base64/hex pure functions + unit tests
  buffer.rs       installs encodeBase64/decodeBase64/encodeHex/decodeHex/fill
  text.rs         + decodeStream(bytes, pending, fatal) -> { text, pending } | null
crates/ln-error     message parity with internal/errors (already the syscall taxonomy)
crates/ln-url       C2: WHATWG + legacy url, percent codecs, punycode
crates/ln-path      C1: posix/win32 path parsing and joining
```

`codec.rs` stays inside `ln-runtime` because it is small and has one caller. If it grows past a
couple of hundred lines or a second crate needs it, promote it to `ln-codec` then; do not add a
crate for a 64-entry table. `ln-url` and `ln-path` are real parsers with corpora and deserve
engine-free crates and an ADR; they join the workspace as members and must keep `cargo deny`
clean (no new external dependency without the ADR's justification).

### 3.3 Host contract additions

| Member | Signature | Phase | Notes |
|---|---|---|---|
| `buffer.encodeBase64` | `(view, start, end, urlSafe) => string` | B1 | borrows the view's backing store, no copy in |
| `buffer.decodeBase64` | `(text, urlSafe) => Uint8Array` | B1 | Node-lenient: ignores non-alphabet characters, stops at padding |
| `buffer.encodeHex` | `(view, start, end) => string` | B1 | lowercase hex |
| `buffer.decodeHex` | `(text) => Uint8Array` | B1 | odd trailing digit dropped; char codes masked to a byte |
| `buffer.fill` | `(view, byte, start, end) => void` | B1 | only if the bench says the JS fill is above the host-call floor |
| `text.decodeStream` | `(view, start, end, pending, fatal) => { text, pending } \| null` | B2 | `pending` 0–3 bytes; `null` means fatal invalid |

Argument checks and clamping stay in JS, as `host/buffer.rs` already documents. A host codec
function receives already-validated ranges; a detached or non-view value is a programming error
and may throw, but it must not become user-visible Node semantics.

## 4. Work plan

| Phase | Track | Work | Depends on | Risk | Est. |
|---|---|---|---|---|---|
| A0 | JS | virtual-tree relative resolution; delete shims | — | medium | 0.5–1 d |
| A1 | JS | `internal/errors.js` | A0 | medium-high | 2–3 d |
| A2 | JS | `internal/bytes.js` + decoder dedup | A1 | medium | 2–3 d |
| A3 | JS | `fs` option parsers into `internal/fs.js` | A0 (A1 preferred) | low | 0.5 d |
| A4 | JS | residual helpers | A1, A2 | low | 0.5–1 d |
| A5 | JS | duplication guardrail + docs (guardrail later deleted) | A2 | low | 0.5 d |
| B1 | Native | buffer base64/hex/fill behind A2 | A2 | medium | 1.5–2 d |
| B2 | Native | `string_decoder` boundary in one host call | A2 | medium-high | 1–1.5 d |
| C1 | Native | path/querystring/punycode (1.2) | B1, A2 | medium | 1–2 w |
| C2 | Native | url (1.2) | C1, B1 | high | 3–4 w |

A3 can run any time after A0, though landing A1 first avoids editing `internal/fs.js` twice. A4
after A1/A2. B1 and B2 both start after A2; B1 first because it proves the host-codec pattern on a
simple case. C1/C2 are a separate milestone; do not start them before A1/A2 or the shared
error/byte seams will be built twice. A+B together are roughly **10–13 eng-days**; C is a 1.2
milestone, with C2 the bulk of it.

**Landing sequence.** One PR per line, each with the full gate below:

1. A0 — loader resolution and shim removal (no new modules).
2. A1a — `internal/errors` moves the exact clusters, no message changes.
3. A1b — Node message rules and the oracle (separate review because it changes text).
4. A2 — `internal/bytes` and the two decoder deletions.
5. A3 — `fs` option parsers (can go in parallel with 4).
6. A4/A5 — residuals and docs (the duplication check was later removed from CI).
7. B1 — buffer codecs behind the seam, with the differential corpus.
8. B2 — `string_decoder` boundary, with the split corpus.

C1/C2 start only after 8 and carry their own ADRs.

## 5. Track A — JavaScript structure

### A0 — Virtual-tree relative resolution, then delete the shims

**Problem.** `loader.js:199` resolves a relative require from an embedded module (`<onde:...>`) by
basename. From `<onde:fs>`, `require("./internal/fs.js")` would map to the **public** `fs`; from
`<onde:internal/http>`, `require("./net.js")` would map to the public `net` instead of
`internal/net`. The 12 `requireInternal` shims and the 13 modules carrying `EMBEDDED` exist to
avoid that.

**Change**

* Pass the requiring file into `resolveInternalSpecifier`; compute the virtual directory
  (`internal` for `<onde:internal/*>`, empty otherwise), join and normalise the specifier, then
  try that candidate and fall back to the basename candidate.
* Replace `requireInternal("x", "./x.js")` with `require("./x.js")` in `fs`, `fs-promises`,
  `http`, `https`, `net`, `tls`, `child_process`, `worker_threads`, `internal/fs`,
  `internal/http`, `internal/pipe`, `internal/worker`; delete the `EMBEDDED` constants and the
  two remaining mode ternaries (`fs-promises.js:25`, `readline-promises.js:19`).
* `url.js:16`: delete `loadModule`; require `./querystring.js` and `./punycode.js` directly.
* Remove the unused `loader.evalInternal` export (`loader.js:364`).

**Verification.** All 68 node/onde test runs plus the 9 Node oracles; `./test/conformance/run.sh`;
grep gates for `requireInternal` and `EMBEDDED`.

**Exit.** No mode branches in `js/lib`; the same relative specifier works in both runtimes.

### A1 — `internal/errors.js`

**API**

```js
coded(Ctor, code, message)
invalidArgType(name, expected, actual)       // ERR_INVALID_ARG_TYPE
invalidArgValue(name, value, reason)         // ERR_INVALID_ARG_VALUE
invalidPropertyType(name, expected, actual)  // same code, "property" wording
missingArgs(...names)                        // ERR_MISSING_ARGS
outOfRange(name, range, value)               // ERR_OUT_OF_RANGE
unknownEncoding(label)                       // ERR_UNKNOWN_ENCODING
abortError(reason)                           // ABORT_ERR
describeValue(value)                         // Node's determineSpecificType rendering
```

`invalidArgType` accepts a bare type (`"string"`), a clause (`"of type string"`,
`"an instance of Buffer or Uint8Array"`), or a full `must ...` phrase, and normalises them the
way `ln-error` does (`lib.rs:104`): a dotted name becomes "property"; `an instance of` / `one of`
stay `must be`; everything else becomes `must be of type`. Strip the leading `of type ` so current
messages stay identical where they were already correct.

**A1a — move the exact clusters, preserve output.** Replace the clusters in Appendix A.1 with imports.
Call sites keep their `expected` strings. Move `abortError` too; fold the
`readline-promises:21` copy in and add `cause` only where the call site has a signal.

**A1b — adopt the Node rules.** Property/argument distinction, canonical received rendering
(function names, truncation), integer separators above 2^32. This changes messages; that is the
point. Add `test/js/lib/errors.oracle.js` with a table of invalid calls per module
(`buffer`, `fs`, `path`, `url`, `stream`, `zlib`, `crypto`, `events`) comparing
`{ name, code, message }` with Node literals.

**Leave.** `bootstrap.js` and `loader.js` keep their local copies: seed code runs before the module
system exists. Call sites that already pass a complete `must ...` clause stay as they are.

**Exit.** `invalidArgType` 22 → 1 shared + 2 seed copies; the error/coded-error families
(82 definitions, 672 lines) collapse to one module; exact redundant lines in those families
(about 190) drop to under 20.

### A2 — `internal/bytes.js` and the decoder swap

**Scope** (inventory in Appendix A.2)

* Encoding alias table (Buffer vocabulary: utf8/utf16le/ucs2/latin1/binary/ascii/hex/base64/
  base64url) with `canonicalEncoding(label)`.
* `decodeUtf16le` / `encodeUtf16le`, `decodeLatin1` / `encodeLatin1`, `decodeAscii` /
  `encodeAscii`; Node masks on decode and truncates on encode, keep that asymmetry.
* `hexEncode` / `hexDecode`, `base64Encode` / `base64Decode` with `start`/`end` and a URL-safe
  flag. These are the functions B1 fills with a native branch.
* `concatBytes`, `byteView`, `isAnyArrayBuffer`, `isArrayBufferView`.
* No throwing policy for coercion: return `null` for "not bytes" and let callers keep their own
  `ERR_INVALID_ARG_TYPE` wording.

**Consumers**

* `buffer.js`: the non-UTF-8 branches of `encodeString`/`bytesToString`; validation and clamping
  stay. UTF-8 still comes from `textcodec`.
* `string_decoder.js`: the stateless flush paths and its two encoder tables. The chunk-boundary
  state stays; B2 replaces its scan.
* `querystring.js` and `url.js`: delete both 64-line `utf8DecodeBytes` copies and call
  `textcodec.decodeUTF8`. No other change in the hold zone.
* `textcodec.js`: no ownership change. It remains the UTF-8/WHATWG seam; it may use bytes for the
  non-UTF-8 one-shot paths, but UTF-8 stays where the host fast path already is.
* `internal/fs.js`: use `concatBytes`/`byteView`; keep `Buffer.isEncoding` as its policy.

**Semantics to pin.** Invalid UTF-8 becomes U+FFFD by maximal subpart; a lone surrogate becomes
U+FFFD; `ascii` encode keeps the low 8 bits while decode masks 0x7F; `hex` stops at the first
non-hex pair and drops an odd trailing digit; base64 ignores non-alphabet characters and pads;
`base64url` does not pad; `utf16le` drops a trailing odd byte.

**Why not one mega bytes module.** UTF-8 already has a native fast path in `textcodec`, and moving
it would put the streaming state machine and the one-shot decoder in one file for no benefit.
Two seams, each with one owner (`textcodec` for UTF-8/WHATWG, `bytes` for the Buffer codecs), is
less risk and maps cleanly onto B1/B2.

**Exit.** One decoder, one alias table, one hex encoder, one base64 encoder; no regression in
`test/bench/codec.js` (within 5%).

### A3 — `fs` option parsers into `internal/fs.js`

Move the parsers in Appendix A.3: `parseReadFileOptions` (`fs.js:108`, `fs-promises.js:38`),
`parseWriteFileOptions` (`120`/`53`), `entryValue` (`615`/`102`) and `fileEncoding` (`907`/`96`)
into the existing normalisation section (`internal/fs.js:536`). Keep `flagGiven`, `flush` and the optional
`displayName` field; the promise surface ignores what it does not use. Literal merge, not a
rewrite: the string/object/`undefined`/`null` precedence is the behavior.

**Exit.** Four duplicate functions gone; `fs.test.js` and `fs-promises.test.js` green.

### A4 — Residual helpers

* `crypto.js` / `zlib.js`: delete what remains of their eight-function block after A1
  (`isAnyArrayBuffer`, `isArrayBufferView`, `byteView`) and import from bytes; the error half
  moved in A1.
* `events.js` / `stream.js`: use `errors.abortError`; their abort-listener logic is not
  duplicated and stays.
* Leave `processObject`, `hostObject`, `createServer`, `validateString`, the loader path helpers,
  `module.js` and the readline VT regex (see §6).

### A5 — Guardrail and docs

* `scripts/check-duplication.mjs` was built: a dependency-free Node script with the audit's
  normalisation, the §6 allowlist and a 40-line budget, run in CI after the stdlib tests. It has
  since been **deleted along with its CI step**; the allowlist, budget and cluster counts in this
  document record the state when it was retired, and duplication is review work again.
* `js/README.md`: add the two modules and the virtual-relative rule; `docs/architecture.md` §2:
  one sentence on the two JS seams; `docs/compat.md`: only if A1b changes a message not already
  covered.

## 6. What stays duplicated on purpose

* `fs` vs `fs/promises`: different API shapes (D35); only option parsers are shared.
* `http`/`https`/`tls`/`net`: layered on purpose; no duplicated framing.
* `readline/promises`, `stream/promises`: adapters; `stream-promises` already has no duplicated
  `pipeline`/`finished`.
* `string_decoder` vs `Buffer#toString`: streaming state machine vs one-shot; only the stateless
  tail is shared.
* `textcodec`'s JS fallback: required for Node-run tests; the host fast path is production.
* `bootstrap.js`/`loader.js`: seed code; they carry what they need before the module system.
* `loader.js` path helpers vs `path.js`: the loader must work before `path` is loadable.
* `module.js` facade: public shape over the loader; the bodies are thin.
* `processObject` (2 copies), `hostObject` (3), `createServer` (2), `validateString` (2): below the
  threshold where a shared module pays for its load-order edge.
* `url`/`path`/`querystring`/`punycode` internals: hold zone until C.

## 7. Track B — native Tier 1

### B1 — Buffer base64/hex behind the seam

**Why.** `from(base64)` at 196 µs and `toString("hex")` at 129 µs are byte-at-a-time JS loops; a
64-entry table and a memcpy in Rust. Both are already behind `internal/bytes` after A2, so the
native branch is added in one module, not four.

**Rust**

* `host/codec.rs` (new private module): `encode_base64` and the 4-to-3 packing of
  `decode_base64` use the `base64` crate's standard and URL-safe engines (already in the lock
  through the TLS stack). Only the Node-compat sanitizer in front of the decoder is local:
  it drops junk, accepts both alphabets, looks each code unit up as itself (Node stopped masking
  them in 26.13), stops at `=`, and drops a lone trailing character. `encode_hex`/`decode_hex` stay local (twenty lines, no crate in the graph).
  No `js::Value`, so unit tests need no engine.
* `host/buffer.rs` installs them using the existing `with_bytes` borrow pattern; ranges arrive
  from JS and are clamped there. `decodeBase64`/`decodeHex` allocate the result `Uint8Array`.
* `fill` only if `test/bench/lib.js` shows the JS `fill` above the host-call floor; otherwise
  leave it (native-candidates lists it as a candidate, not a proven win).

**Semantics the Rust must reproduce** (pin with the Node oracle, not assumption):

* base64: ignore whitespace and non-alphabet characters, accept both the standard and URL-safe
  alphabets regardless of the flag (Node does), stop at `=` padding, and let a single trailing
  character contribute no byte; empty input → empty output.
* base64url: `-`/`_` alphabet, no padding on encode, accept padding on decode.
* hex: two nibbles per byte, lowercase encode; odd trailing digit dropped; each UTF-16 code unit
  masked to a byte before lookup (Node's native behavior for `"š"` → `a`).
* All decoders produce a fresh `Uint8Array`; encoders return a JS string.

**JS**

* `internal/bytes.js`: `if (hostBuffer && hostBuffer.encodeBase64) ... else <the one JS loop>`.
  The fallback is the current loop, moved not rewritten. Keep `start`/`end` in JS; the host
  borrows the whole backing store and slices in Rust, so no subarray allocation per call.
* `buffer.js`: no new branch; its `bytesToString`/`encodeString` already call bytes.
* `string_decoder.js`: its hex/base64 flush calls bytes.

**Perf gate.** `from(base64)` 196 µs → ≤2 µs, `toString("hex")` 129 µs → ≤2 µs,
`toString("base64")` 80 µs → ≤2 µs: 40x–100x faster, and the point is to leave the
hundreds-of-x regime. A 1 KB operation still pays a ~0.1 µs host call and a JS string
allocation, so the absolute floor is nearer 0.5 µs; tighten the gate after the first
measurement. Regressions in `buffer:from`, `buffer:toString` or `textdecoder:decode` block the
phase.

**Testing.** Node (no `host.buffer` in the shim) exercises the JS fallback; `onde` exercises the
native path. Add `test/js/lib/codec-differential.test.js` with generated inputs (lengths 0–4096,
every alphabet edge, invalid characters, URL-safe, unicode) and the randomized reference method
native-candidates describes. Mutation-test the Rust (break the table or the padding and watch the
differential fail). Add a `buffer` suite under `test/conformance/buffer/` (record the
`.expected` files with `REGEN=1 RUN=node`, add `buffer` to `default_suites` in
`test/conformance/run.sh`) and run `./test/differential.sh`, which compares node and onde output.

### B2 — `string_decoder` boundary in one host call

**Why.** `StringDecoder.write` already calls the native decoder, but only after a per-byte JS
scan and then once per multibyte sequence: a 1 KB chunk costs up to 1024 iterations plus hundreds
of host calls, which is why it measures 580x Node. The fix is one host call that returns both the
decoded prefix and the carried suffix.

**Contract.** `host.text.decodeStream(view, start, end, pending, fatal) -> { text, pending } | null`

* `pending` is the 0–3 byte suffix carried from the previous `write` (a `Uint8Array`, empty on the
  first call). The host prepends it (≤3 bytes) and decodes the rest.
* Use `std::str::from_utf8` and its `valid_up_to`/`error_len`: a truncated sequence at the end
  becomes `pending`; an invalid sequence inside is replaced with U+FFFD (lossy) or returns `null`
  when `fatal`. Loop until the buffer is consumed.
* `text` is the decoded prefix; `pending` is a new small `Uint8Array`.
* The host does not decide `end()` semantics; JS keeps the maximal-subpart U+FFFD flush and the
  `ERR_ENCODING_INVALID_ENCODED_DATA` shape.

**JS**

* `StringDecoder.write`: one call when `host.text.decodeStream` exists; otherwise the current
  boundary scan. The fallback remains, because Node tests have no host.
* `StringDecoder.end`: unchanged; flush `pending` in JS.
* Optional, after B2 is green: route `TextDecoder` with `stream: true` (UTF-8 only) through the
  same op. It has extra state (BOM, fatal, `ignoreBOM`), so treat it as a follow-up, not part of
  B2's exit.

**Perf gate.** `StringDecoder.write` 133 µs → ≤2 µs (about 65x faster; ~9x Node).
`fs.createReadStream` with `setEncoding("utf8")` and an HTTP text body are the real paths; check
both in `test/bench/lib.js`.

**Testing.** A chunk-splitter that feeds the same bytes one byte at a time, at every two-way
split, and in 1/3/7-byte chunks; compare concatenated output and `end()` against Node's
`StringDecoder` for valid, truncated, overlong, surrogate and 4-byte sequences. Fatal and
replacement modes both. This is where a boundary bug hides; the corpus is the deliverable.

## 8. Track C — native Tier 2 (1.2)

These are separate milestones. The plan names them so the hold zone is explicit, not so they can
start now.

### C1 — `path`, `querystring`, `punycode`

* `ln-path`: posix and win32 parse/join/normalize; `path.oracle.js` already pins the shapes.
* `querystring`: percent decode with the legacy rules (`+`, malformed `%`, custom separators,
  `maxKeys`, null-prototype object built in JS). The pair splitter returns data; JS builds the
  object.
* `punycode`: RFC 3492 encode/decode. It feeds `url`'s IDNA, so fold it into `ln-url` rather than
  shipping a standalone module; C1 can expose it only if C2 is deferred.
* Ratios are 17x–36x but absolute cost is 2–13 µs; start only if a real workload (npm-style path
  or query loops) needs it. Otherwise C2 is the only 1.2 item that matters.

### C2 — `url`

* `ln-url`: WHATWG parser/serializer plus legacy `parse`/`format`/`resolve`, percent encode sets,
  IDNA/UTS46. JS keeps the `URL`/`URLSearchParams` classes and calls the host for parse and
  serialize. The setters still need percent encoding; expose the encode sets from `ln-url` (one
  host call per set operation) or keep the setter encoding in JS and share only the parser. Decide
  with the corpus, not up front.
* `fileURLToPath`/`pathToFileURL` interact with `ln-path` on Windows drive letters; design them
  together.
* This is the riskiest item in either plan: hundreds of WHATWG edge cases, and the existing
  `url.oracle.js`/`url.test.js` corpus is the acceptance test. Needs an ADR for the crate and the
  host contract. Do not fold it into the dedup work.

## 9. Verification and measurement

Baseline commands:

```sh
./test/js/run.sh                     # 77 cases: 34 test files x node/onde + 9 oracles
./test/differential.sh               # node vs onde on the conformance corpus
cargo test --all                     # host units, modules.rs arms, ln-error
./test/conformance/run.sh            # embedded loader and module behavior
BENCH_REPS=5 node test/bench/run.js  # startup + codec + lib, release build
```

The two runtimes test different code paths by construction. `test/js/lib` loads a module through
`test/js/host-shim.js`, which has no `text` or `buffer` members, so under Node the JS fallback
runs; under `onde` the same test exercises the native branch. The conformance corpus runs a
script under Node and under `onde`, and `test/differential.sh` compares stdout and exit code, so
it pins the native result against Node. Every new codec needs a case in that corpus.

Keep `test/js/host-shim.js` free of `text` and `buffer` members: adding them would silently stop
exercising the JS fallback in the Node leg while every test still passed.

New tests:

| Test | Phase | Asserts |
|---|---|---|
| embedded relative-resolution case | A0 | `fs/promises` and `tls` reach the right internal modules |
| `errors.test.js` / `errors.oracle.js` | A1 | literal and Node-compared messages |
| `codec-differential.test.js` | A2/B1 | same inputs under Node (fallback) and onde (native), both against pinned literals |
| `string-decoder-boundary.test.js` | B2 | every split point, fatal and replacement |
| existing `fs*.test.js` | A3 | option precedence, `flush`/`flagGiven` |

Perf gates:

| Phase | Gate |
|---|---|
| A2 | `buffer:from`, `buffer:toString`, `textdecoder:decode` within 5% of baseline |
| B1 | base64/hex ≤2 µs/1 KB each (40x–100x faster) |
| B2 | `StringDecoder.write` ≤2 µs/1 KB (about 65x faster) |
| all | cold start within 1%; `test/bench/lib.js` no regression; binary size within 1% |

Do not accept "it looks faster": the bench is release mode, medians of at least three, and the
same script runs under both runtimes.

## 10. Risks

| Risk | Phase | Mitigation |
|---|---|---|
| Loader resolution breaks embedded boot | A0 | basename fallback; conformance modules; land alone |
| Error messages drift or tests pin old text | A1 | A1a preserves, A1b changes in a separate diff; oracle |
| Seam refactor regresses codec throughput | A2 | host fast path untouched; bench codec before/after |
| Missing `modules.rs` arm passes Node, fails `onde` | A1/A2 | arm + Rust assertion in the same commit; run both |
| Circular dependency through `util`/`buffer` | A1/A2 | errors requires nothing; bytes requires errors only |
| Native and JS fallback disagree | B1/B2 | Node tests run the fallback, `onde` the host; differential corpus; mutation test |
| Host call overhead eats the win | B1/B2 | only per-byte ops above ~1 µs; bench per phase |
| `string_decoder` boundary bug at a split | B2 | exhaustive split corpus, fatal and replacement |
| New host contract freezes too early | B1/B2 | keep codec.rs private; ADR before C's public-adjacent surface |
| WHATWG edge cases in C2 | C2 | corpus-first; ADR; separate milestone; do not bundle with dedup |
| Cold start / binary size | all | measure; keep modules small; no new dependency |

## 11. Release mapping and definition of done

**Status (2026-11-24): A0–A5 and B1–B2 are landed.** The virtual-tree loader is the only
resolution path (no `requireInternal`/`EMBEDDED` branches remain in `js/lib`); `internal/errors.js`
and `internal/bytes.js` are the two leaf seams, with base64/hex served by `host/codec.rs` and the
`StringDecoder` streaming split by `host/text.rs` behind them. Base64 encoding/decoding uses the
`base64` crate behind a small Node-compat sanitizer; hex remains local.

Rebench at `5450b0d` (release, `BENCH_REPS=5 node test/bench/run.js`, medians of five runs; 1 KB
payload; per-call = total / iterations, 20k for the Buffer operations and 50k for `write`):

| Workload | Node 26 | onde before | onde now | vs Node | vs before |
|---|---|---|---|---|---|
| `Buffer.from(base64)` | 0.17 µs | 196 µs | 3.1 µs | 18.8x | 63x |
| `Buffer.toString("base64")` | 0.16 µs | 80 µs | 1.2 µs | 7.2x | 69x |
| `Buffer.toString("hex")` | 0.56 µs | 129 µs | 1.7 µs | 3.0x | 77x |
| `Buffer.from(hex)` | 0.63 µs | — | 2.1 µs | 3.4x | — |
| `StringDecoder.write` | 0.23 µs | 133 µs | 2.0 µs | 8.8x | 67x |

"onde before" is the pre-move JavaScript loop recorded in
[native-candidates.md](native-candidates.md); `from(hex)` was not measured separately before the
move. At retirement the duplication guard reported five allowlisted clusters (25 redundant lines,
within the 40-line budget) and one unallowlisted cluster (`invalidArgType`, 8 lines, in
`bootstrap.js` and `test.js`); it has since been deleted and is no longer part of CI. Tested
state: `./test/js/run.sh` 83 passed, `./test/conformance/run.sh` 235 passed,
`cargo test --all` 490 passed, `cargo fmt --all -- --check` and
`cargo clippy --all-targets -- -D warnings` clean.

* **A0–A5 + B1–B2 are the M7 stdlib-consolidation task**, tracked from
  [roadmap.md](roadmap.md#m7--performance-and-diagnostics-4-w). They remove ~350 redundant lines,
  delete the 13 `EMBEDDED` branches, and close the two largest codec gaps left in
  [native-candidates.md](native-candidates.md).
* **C1–C2** are 1.2. C2 is the one that moves the needle for URL-heavy work; C1 is optional.
* The standalone-build and bytecode-snapshot work in M7 benefits from fewer JS modules and fewer
  conditional branches; two small internal modules are a net win, not a cost.

Done means:

* `invalidArgType` exists once (plus the two seed copies) and applies the property rule.
* One UTF-8 one-shot decoder, one encoding-alias table, one hex encoder, one base64 encoder.
* `fs` and `fs/promises` share their option parsing.
* No `requireInternal`/`EMBEDDED` shims.
* base64/hex encoders ≤2 µs/1 KB and decoders ≤3.5 µs/1 KB (63x–77x faster than the JS loops);
  `StringDecoder.write` is one host call per chunk (perf follow-up not re-measured); no other
  codec regressed.
* `./test/js/run.sh`, `./test/differential.sh`, `cargo test --all` and
  `./test/conformance/run.sh` green; `docs/` updated.

## 12. Open questions

1. **A1b behavior change**: adopt Node's canonical messages (recommended) or keep current wording
   and only dedupe? Adopting fixes the `property` bug and aligns with `ln-error`.
   **Settled:** adopted; `errors.js` applies the property rule and `test/js/lib/errors.oracle.js`
   pins the messages.
2. **A0 timing**: take the loader change now, or keep the shims until M7? Everything else is
   independent of the answer.
   **Settled:** the loader change landed in A0; the shims are gone.
3. **Seam split**: two seams (`textcodec` for UTF-8, `bytes` for the rest; recommended) or one
   `bytes` module that absorbs UTF-8 too? The latter is tidier on paper and riskier in practice.
   **Settled:** two seams kept; UTF-8 stays in `textcodec`, the Buffer codecs in `bytes`.
4. **`host/codec.rs` vs a new `ln-codec` crate**: start private, promote when a second caller
   appears (recommended), or crate it now?
   **Settled:** private `crates/ln-runtime/src/host/codec.rs`; promote only when a second caller
   appears.
5. **B2 scope**: `StringDecoder` only (recommended first) or `TextDecoder` streaming in the same
   phase?
   **Settled:** `StringDecoder` only; `text.decodeStream` is its seam, `TextDecoder` streaming
   stays in JS.
6. **C1**: do path/querystring/punycode at all in 1.2, or only `url`? The absolute costs are
   small; the URL parser is the reason the tier exists.
7. **Errno tables**: keep the JS copy with a parity test (recommended), or generate both sides
   from one data file?
8. **Guardrail strength**: advisory report first, hard CI failure once the budget is met
   (recommended), or hard failure from day one?
   **Settled:** hard CI failure with the budget met; `scripts/check-duplication.mjs` ran after the
   stdlib tests and reported the five §6 exceptions by name. Superseded: the script and its CI
   step were deleted, so the ratchet no longer exists.

## Appendix A — duplication inventory (2026-11-23)

Method: every `function` declaration in `js/**/*.js` (1,127 definitions), bodies normalised for
comments, whitespace, string literals and numbers, hashed; a cluster is an exact body in two or
more files. Cross-file 10-line windows were used as a second, independent check. The A5 guard
script that reproduced this has since been deleted; the numbers below are the audit's record.

### A.1 Error and validation helpers

82 definitions, 672 lines, for the helpers below.

| Helper | Copies | Locations |
|---|---|---|
| `invalidArgType` | 22 | `bootstrap.js:130`; `assert:57`, `async_hooks:74`, `buffer:61`, `child_process:27`, `crypto:118`, `dns:22`, `events:51`, `internal/fs:111`, `internal/http:214`, `internal/net:184`, `internal/worker:31`, `loader:87`, `path:85`, `readline:70`, `stream:88`, `string_decoder:55`, `textcodec:50`, `tls:45`, `url:38`, `util:1794`, `zlib:113` |
| `invalidArgValue` | 11 | `assert:94`, `buffer:98`, `child_process:36`, `dns:36`, `internal/fs:119`, `internal/http:222`, `internal/net:192`, `os:199`, `readline:78`, `stream:96`, `tls:49` |
| `describeValue` / `describe` | 9 / 6 | `assert:65`, `crypto:105`, `events:30`, `globals:68`, `path:60`, `readline:56`, `stream:74`, `util:1802`, `zlib:100`; plus `bootstrap:575`, `buffer:45`, `internal/fs:89`, `internal/http:195`, `internal/net:164`, `textcodec:58` |
| `codedError` | 8 | `dns:16`, `internal/fs:105`, `internal/http:208`, `internal/net:178`, `loader:80`, `net:85`, `readline:50`, `stream:68` |
| `makeError` | 7 | `bootstrap:613`, `buffer:39`, `crypto:98`, `globals:35`, `string_decoder:45`, `textcodec:28`, `zlib:93` |
| `outOfRange` | 6 | `buffer:69`, `crypto:146`, `globals:49`, `internal/fs:127`, `stream:110`, `zlib:130` |
| `missingArgs` | 4 | `assert:83`, `globals:41`, `internal/net:216`, `url:50` |
| `unknownEncoding` | 2 | `buffer:112`, `string_decoder:51` |
| `invalidPropertyType` | 2 | `crypto:127`, `zlib:122` |
| AbortError constructors | 5 | `events:81`, `stream:142`, `readline-promises:21`, `globals:589`, `bootstrap:365` |

Exact clusters: `assert`/`path`/`util` (7 lines ×3); `buffer`/`crypto`/`textcodec`/`zlib`
(7 ×4); `dns`/`loader` (13 ×2); `internal/fs`/`internal/http`/`internal/net` (7 ×3); the
`internal/fs`/`internal/http`/`internal/net`/`net`/`readline` `codedError` (5 ×5); and the
`crypto`/`zlib` block (`makeError`, `describeValue`, `invalidArgType`, `invalidPropertyType`,
`outOfRange`, `isAnyArrayBuffer`, `isArrayBufferView`, `byteView`).

### A.2 Byte and text codecs

| Duplicate | Copies | Notes |
|---|---|---|
| `utf8DecodeBytes` (64 lines) | `querystring:54`, `url:253` | exact; `textcodec.decodeUTF8` already implements the same WHATWG replacement rules |
| `ENCODING_ALIASES` table | `buffer:120`, `string_decoder:30` | same names, different unknown-label policy |
| `hexEncode` / `base64Encode` | `buffer:183/204`, `string_decoder:100/108` | same algorithm, different signatures (`start,end` vs whole buffer) |
| `toBytes` | `internal/fs:483`, `string_decoder:75`, `textcodec:314`, `tty:108` | four coercion policies, four messages |
| `concatBytes` | `internal/fs:523`, `string_decoder:87` | 8 lines each |
| `normalizeEncoding` | `internal/fs:463`, `string_decoder:69` | fs delegates to `Buffer.isEncoding`, decoder keeps a table |
| `encodeString` / `bytesToString` | `buffer:253/288` | the non-UTF-8 branches are the copy; `Buffer` already delegates UTF-8 to `textcodec` |
| `toUSVString` | `url:91`, `util:2274` | different call-site needs; left alone |

### A.3 `fs` option parsers

| Function | `fs.js` | `fs-promises.js` |
|---|---|---|
| `parseReadFileOptions` | 108 | 38 |
| `parseWriteFileOptions` | 120 | 53 |
| `entryValue` | 615 | 102 |
| `fileEncoding` | 907 | 96 |

Only `flagGiven`, `flush` and the optional `displayName` differ.

### A.4 Bootstrap shims

`requireInternal` in 12 modules: `fs`, `fs-promises`, `http`, `https`, `net`, `tls`,
`child_process`, `worker_threads`, `internal/fs`, `internal/http`, `internal/pipe`,
`internal/worker`. `EMBEDDED` in 13 modules (the twelve plus `readline-promises`).

### A.5 Small helpers left in place

`processObject` (`console:26`, `os:24`); `hostObject` (`os:19`, `readline:468`, `tty:31`);
`createServer` (`http:107`, `https:99`); `validateString` (`path:93`, `url:1749`); `module.js`
facade (`createRequire`, `isBuiltin`, `install`); the `loader.js` path helpers; the readline VT
regex. Reasons are in §6.
