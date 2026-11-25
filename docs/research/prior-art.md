# Prior art: shipping a JS app as one standalone executable

> **Design status (2026-11-20):** this is survey material. The project decided against appending a
> payload to a copy of the runtime; the shipping design links a static library instead. See
> [`../standalone-build.md`](../standalone-build.md), Appendix B for why appending was rejected.

Research notes for `onde`/`onde` (Rust + QuickJS, 5.3 MB single binary today).
Compiled 2026-11-20. Sources are primary where possible: Node's `src/node_sea*.cc` and API
docs (v26.13.1), Bun's `StandaloneModuleGraph` at tag `bun-v1.3.3` (Zig) and current `main`
(Rust rewrite), Deno's `cli/tools/compile.rs` + `cli/standalone/binary.rs` + `cli/lib/standalone/binary.rs`,
LLRT `main`, pkg `main`, nexe `master`, boxednode `main`. Every mechanism below was read in
source or official docs unless marked **Inferred**.

Legend: **[V]** verified in source/docs · **[I]** inference or untested.

The table below compresses detail; each section carries the verification status of its own claims.

---

## 0. The design space, in one table

| System | Payload bytes | How the runtime finds it | App code form | Output is a copy of the runtime? | Cross-compile |
|---|---|---|---|---|---|
| Node SEA (`--build-sea`) | `sea-prep.blob` in a PE resource / Mach-O section / ELF note | Resource lookup by name + a sentinel "fuse" string | Source (optionally V8 code cache, optional V8 startup snapshot, optional ZIP VFS) | Yes, copy of the `node` binary | Only by using a `node` binary for the target (`executable` key); snapshot/code cache must be off |
| Bun `--compile` | Module graph blob + offsets + trailer | Tail scan (Linux) or named section (`__BUN` / PE section, macOS+Windows) | Transpiled source, optional JSC bytecode, optional zstd sourcemap; assets | Yes ("a copy of bun with your program attached") | `--target`; downloads the target's Bun binary |
| Deno `deno compile` | `d3n0l4nd` data section: metadata, npm snapshot, module sources, VFS | Named section/resource lookup | Transpiled JS source + V8 code cache + in-memory VFS | Yes, copy of `denort` | `--target`; downloads `denort-<target>.zip` |
| pkg | VFS blob appended at `PAYLOAD_POSITION` | Two patched placeholder strings in the binary | V8 bytecode (default) or source, Brotli-compressed VFS | Yes, `pkg-fetch` base Node | Base binary per target from `pkg-fetch` |
| nexe | Appended bundle/resources | Placeholder patched in the binary | Bundled JS | Yes, prebuilt Node or self-built | Prebuilt or build from source |
| boxednode | *Nothing appended* | Node builtin module registry | JS **linked into** Node at build time (`--link-module`), optional snapshot | No — it builds a new Node | No (host toolchain only) |
| LLRT `llrt compile --executable` | zstd QuickJS bytecode + length + `lrtx` marker | 12-byte tail read | **QuickJS bytecode** (module `write`) | Yes, current LLRT exe | No |

Two families, and the split matters for us:

1. **Append/embed a payload into an existing runtime image** (SEA, Bun, Deno, pkg, nexe, LLRT).
   The runtime binary is a build input; the build is fast; codesign is the recurring tax.
2. **Link a new binary with the app inside** (boxednode, Nuitka, `qjsc`-style C emission).
   Slow, needs a toolchain, but no injection, no fuse, no re-sign surprise.

---

## 1. Node.js Single Executable Applications (SEA)

### 1.1 Build inputs

Two paths exist today:

- `node --build-sea sea-config.json` (v25.5.0+): generates the blob **and** injects it, natively.
  When Node is built with LIEF (`HAVE_LIEF`), `src/node_sea_bin.cc` does the injection itself. **[V]**
- `node --experimental-sea-config sea-config.json` → `sea-prep.blob` on disk, then an external
  injector (postject) writes it into a copy of `node`. **[V]** (deprecated in practice; still documented
  "for verification purposes").

Config keys (all verified against the v26 docs and `SeaConfig` in `src/node_sea.h`):

```json
{
  "main": "bundle.js",              // required, must be a single bundled file
  "mainFormat": "commonjs",         // "commonjs" | "module"
  "executable": "/path/to/node",    // base binary; default = current node
  "output": "sea",                  // executable path, or blob path for --experimental-sea-config
  "disableExperimentalSEAWarning": true,
  "useSnapshot": false,             // V8 startup snapshot, built by *running* main at build time
  "useCodeCache": false,            // V8 code cache for main, built at build time
  "useVfs": false,                  // v26.9+: mount assets as a read-only VFS
  "vfsArchive": "/path/to/assets.zip",
  "execArgv": ["--no-warnings"],
  "execArgvExtension": "env",       // "none" | "env" | "cli"
  "assets": { "a.dat": "/path/to/a.dat" }
}
```

`useVfs`/`vfsArchive`, `execArgv`, `execArgvExtension`, `mainFormat`, and `assets` are the
interesting additions since the original design; earlier SEA was literally "one script, no files".

### 1.2 What the blob contains (byte level)

`SeaSerializer::Write` in `src/node_sea.cc` serializes a `SeaResource` with a fixed 10-byte header
(`kHeaderSize = sizeof(kMagic) + sizeof(SeaFlags) + sizeof(SeaExecArgvExtension) + sizeof(ModuleFormat)`):

```
u32  magic        = 0x143da20            // 0x0143da20
u32  flags        // 1<<0 disableWarning, 1<<1 useSnapshot, 1<<2 useCodeCache,
                  // 1<<3 includeAssets, 1<<4 includeExecArgv, 1<<5 enableVfs, 1<<6 vfsArchive
u8   exec_argv_extension   // 0 none, 1 env, 2 cli
u8   main_code_format      // 0 CJS, 1 ESM
--- then, via BlobSerializer (length-prefixed strings) ---
str  code_path                 // the "main" path as configured (diagnostics only)
str  main_code_or_snapshot     // JS source, or the V8 snapshot when useSnapshot
str  code_cache                // present iff useCodeCache
u64  asset_count; { str key; str bytes } * n    // present iff includeAssets
u64  exec_argv_count; str * n                    // present iff includeExecArgv
```

There is **no compression** and no integrity hash. `flags` is the only versioning; Node's own docs
require the blob and the target binary to be the same Node version. **[V]**

### 1.3 Where the bytes live in the executable

| Platform | Container | Exact name |
|---|---|---|
| Linux | ELF **note** (section `.note.node.sea`) | note name `NODE_SEA_BLOB` |
| macOS | Mach-O **section** in a new segment | section `NODE_SEA_BLOB`, segment `NODE_SEA` |
| Windows | PE **resource**, type `RT_RCDATA` | resource `NODE_SEA_BLOB` |

**[V]** — `src/node_sea_bin.cc` (`kSEAResourceName`, `kELFSectionName`, `kMachoSegmentName`) and the
API docs. postject's README documents the same mapping: ELF notes, Mach-O "sections inside a new
segment" (default segment `__POSTJECT`, overridable with `--macho-segment-name`), PE `.rsrc` `RT_RCDATA`.

### 1.4 How the runtime finds it: the sentinel fuse

Node does not scan for a magic number. At compile time it embeds one string in `node`:

```
NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:0
```

The injector flips the trailing `0` to `1`. At startup `postject_has_resource()` (a C header,
`postject-api.h`, compiled into node) searches the image for that fuse; if it ends in `:1`, Node calls
`postject_find_resource("NODE_SEA_BLOB", …)` — `FindResource`/`LoadResource` on Windows,
`getsectdata`-style lookup on macOS, note lookup on ELF. **[V]**

Consequences worth copying or avoiding:

- Detection is O(1)-ish and does not depend on the container's tail, so it survives `strip` better
  than a trailer does (though the resource bytes themselves can still be stripped by careless tools).
- Exactly one fuse is allowed: postject errors if it appears more than once, and errors if it is missing.
- The fuse is a *fixed random string shared by every Node build*, so any tool can flip it.

### 1.5 The macOS codesign dance

The dance exists because injection edits the Mach-O (adds a segment/LC commands), which invalidates
the existing signature, and on arm64 an invalid signature is a hard kill.

`--build-sea` path: `InjectIntoMachO` adds `NODE_SEA/NODE_SEA_BLOB`, and if
`binary.has_code_signature()` it calls `binary.remove_signature()` — it does **not** re-sign. **[V]**
The docs then tell you to run `codesign --sign - sea`. So the produced artifact is unsigned until you
sign it, and the doc's manual postject flow has you `codesign --remove-signature` *before* injecting
and re-sign after. **[V]**

postject path (docs, macOS):

```bash
cp "$(command -v node)" hello
codesign --remove-signature hello
npx postject hello NODE_SEA_BLOB sea-prep.blob \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
    --macho-segment-name NODE_SEA
codesign --sign - hello        # or a Developer ID identity, then notarize
```

Notarization itself is not a Node feature: a bare Mach-O cannot be notarized alone — it must be
shipped in a zip/dmg/pkg, signed with a Developer ID and the hardened runtime. SEA gives you no help
here, and `--build-sea`'s habit of copying whatever `node` binary you point at (including a signed,
hardened one) means the *copy* has a removed signature. **[V for the removal, I for the notarization
consequences]**

### 1.6 Startup / parse strategy

- Default: the main script is **source**, compiled by V8 at every start. Startup therefore does not
  improve over `node app.js`, and SEA's own docs push you to bundle to reduce module count.
- `useCodeCache: true`: V8 code cache for the main script is generated at build time and stored in
  the blob; it removes parse/compile of the entry script only.
- `useSnapshot: true`: the main script is **executed at build time** to warm a V8 heap, and must call
  `v8.startupSnapshot.setDeserializeMainFunction()`; the blob carries the snapshot and the runtime
  deserializes it. Big win, but the build now runs your app, and many builtins are not serializable.
- **Portability rule:** `useCodeCache` and `useSnapshot` are single-platform only. The docs require
  both to be `false` when producing a SEA for another platform. **[V]**
- `useVfs` cannot be combined with `useSnapshot` or `useCodeCache` (code-cache restriction is called
  "incomplete implementation, not a technical impossibility"). **[V]**

### 1.7 Known limitations (documented, not folklore)

- The injected script cannot `require()`/`import` files from disk. Only builtins resolve. Escape
  hatches: bundle everything, `module.createRequire(__filename)` (i.e. from `process.execPath`), or
  `useVfs`/`assets`.
- `useVfs` VFS is read-only, mounted at a runtime-chosen path that cannot exist on the real FS;
  `__filename`/`__dirname` point *inside* the mount, not at `process.execPath`. Native `.node` addons
  cannot be `dlopen`ed from the VFS — write to a temp file first.
- `"mainFormat": "module"` cannot be combined with `useSnapshot`.
- `import.meta.resolve` is unsupported in the injected script.
- `sea.getRawAsset()` returns a view into the mapped image; writing to it can crash (section may be
  read-only/unaligned).
- One main script only; multi-entry (workers) needs separate handling.
- argv/execPath semantics (see §8): `__filename === process.execPath`, and `process.argv[1]` is a
  duplicate of `argv[0]` (`FixupArgsForSEA` literally "repeats argv[0] at position 1 ... as a
  replacement for the missing entry point file path"). **[V]**

---

## 2. Bun `bun build --compile`

### 2.1 Output is a modified copy of Bun

Docs, verbatim: "A standalone executable is a copy of bun with your program attached, so it also
contains the package manager, the test runner and the type checker." `--trim` (experimental) removes
them, plus unreached Bun/Node APIs. **[V]**

Size: Bun's install is ~58 MB on this machine (repo README measurement); a hello-world compile is
therefore tens of MB. There is no compression of the module graph beyond optional minify. **[V for the
copy, I for exact output size]**

### 2.2 Byte layout

From `src/StandaloneModuleGraph.zig` at `bun-v1.3.3` (the version family this repo benchmarks against)
the payload is:

```
[ bun binary image ]
[ strings: module names, module contents, sourcemaps, bytecode (128-byte aligned) ]
[ CompiledModuleGraphFile[]   // extern structs, offsets relative to blob start
                              //  name, loader, contents, encoding, module_format,
                              //  bytecode, sourcemap, side (server|client) ]
[ Offsets { usize byte_count; StringPointer modules_ptr; u32 entry_point_id;
            StringPointer compile_exec_argv_ptr; Flags flags } ]
[ "\n---- Bun! ----\n" ]      // 14-byte trailer
[ u64 total_byte_count ]      // file size, LE-ish native usize
```

Writer: `string_builder.append(offsets); append(trailer);` then the clone path writes
`total_byte_count = seek_position + bytes.len + 8` after it. Reader: read the **last 4096 bytes**,
take `u64` at `end-8`, sanity-check it (≤ 4 GB, ≥ 4096), step back 14 bytes and compare the trailer,
step back `sizeof(Offsets)`, then `lseek(END, -(offset_from_end + offsets.byte_count))` and read the
graph in one go. **[V]** The whole graph is read into memory ("mmap-aligned reads were too
complicated"); there is no per-module lazy load at that layer.

Note the trailer is *not* at EOF: the trailing `u64` is after it. A tail scanner must therefore probe
`[-8-14-…]`, not just `[-14:]`.

### 2.3 macOS/Windows do not tail-append

Current `main` (Rust rewrite, `src/standalone_graph/StandaloneModuleGraph.rs`) says in its module doc:

> Originally, we tried using LIEF to inject the module graph into a MachO segment. But this incurred a
> fixed 350 ms overhead on every build … so we give up on codesigning support on macOS for now

In 1.3.3 the non-macOS clone path appends `payload` after the copied image and then writes the trailing
`u64`. On current main, macOS writes the same blob into segment **`__BUN`**
(`getsegbyname(c"__BUN")`) with `macho_file.write_section(bytes, …)` and then
`build_and_sign_into(file, …)`, **truncating** the file because "codesign rejects bytes past the
signature"; Windows uses `pe_file.add_bun_section(bytes, …)` plus signing. **[V]**

That is the cleanest statement of the macOS constraint in this whole survey: on Apple platforms the
payload must be *inside* the signed region and the signature must be regenerated, not merely appended.

`--target` cross-compilation downloads the target platform's Bun binary (`CompileBuildOptions.executablePath`
exists precisely to supply one "instead of downloading one for target"). **[V]**

### 2.4 App code form and lookup at runtime

- The graph stores transpiled source, plus JSC bytecode when `--bytecode` is used. Bytecode is placed
  in the blob with `alignInSlice(…, 128)`; the source comment warns misalignment causes assertions or
  segfaults. **[V]**
- `--bytecode` is supported together with `--compile` for both CJS and ESM ("Bytecode compilation
  supports both cjs and esm formats when used with --compile"), moves JSC parse/optimize to build
  time, and has `--no-optimize-bytecode` and profile-guided `--bytecode-order`. Bytecode does not
  obscure source (docs say so explicitly). **[V]**
- Assets: `import x from "./icon.png" with { type: "file" }` yields `/$bunfs/root/icon-<hash>.png`;
  reads are served from the embedded graph. **`$bunfs`** is the virtual root. **[V]**
- Missing relative files fall back to disk relative to **cwd** at runtime, and error if absent;
  `--disallow-code-generation-from-strings=strict` blocks that. **[V]** (see also issue #44053 for
  `--external` resolution from cwd.)

---

## 3. Deno `deno compile`

### 3.1 Base binary: `denort`

`deno compile` embeds into **denort**, "a stripped build of Deno that contains only what's needed to
run a compiled program, with none of the tooling subcommands". On first compile for a version+target,
Deno downloads `denort-<target>.zip` from `dl.deno.land`, caches it in `DENO_DIR`; later compiles work
offline. `DENORT_BIN` overrides the base. `--engine quickjs` downloads `denort-quickjs-<target>.zip`
instead (experimental, no security updates). **[V]**

That is the whole cross-compile story: no linking, no emulation — fetch the foreign runtime, write the
payload, done. **[V]**

### 3.2 Byte layout of the data section

`serialize_binary_data_section` in `cli/standalone/binary.rs` (docs comment reproduced verbatim):

```
d3n0l4nd                              // MAGIC_BYTES, 8 bytes, at start
u64 metadata_len;  metadata           // JSON: argv, permissions, v8_flags, entrypoint_key,
                                      //   preload/require modules, node_modules mode,
                                      //   workspace resolver, code_cache_key, app_name, ...
u64 npm_snapshot_len; npm_snapshot    // serialized resolution snapshot (omitted with --bundle)
specifiers                            // u32 count + (u32 len, str, u32 id)*
redirects
remote_modules                        // per-module source/transpiled code + source map refs
u64 vfs_headers_len; vfs_headers      // JSON of VFS entries
u64 vfs_file_data_len; vfs_file_data  // concatenated file bytes
d3n0l4nd                              // magic repeated, to validate deserialization
```

**[V]** — `MAGIC_BYTES: &[u8; 8] = b"d3n0l4nd"` lives in `cli/lib/standalone/binary.rs`; the writer is in
`cli/standalone/binary.rs`.

This corrects a common claim: modern `deno compile` does **not** embed an eszip archive by default. It
serializes module sources and a VFS directly. eszip only appears behind a separate `--eszip` flag that
writes an `.eszip` file (`compile_eszip`, `EszipV2::from_graph`) — that is a different output mode, not
the compiled binary format. **[V]**

### 3.3 How it is attached and found

Via **libsui** (`libsui = "=0.16.4"`), a crate that writes a named blob into each container:

- Linux: `libsui::Elf::new(&original_bin).append("d3n0l4nd", &data_section_bytes, …)` — a section named
  `d3n0l4nd`.
- Windows: `pe.write_resource("d3n0l4nd", data_section_bytes)` — a PE resource, plus optional icon.
- macOS: `libsui::Macho::from(bin)?.write_section("d3n0l4nd", …)?.build_and_sign(&mut writer)?` — a
  Mach-O section, and **`build_and_sign` re-signs ad-hoc**.

**[V]** for the three writer calls; the section name is the same string as the magic, so lookup can be
by name, and the inner magic at both ends guards against a stale or wrong section. **Inferred:** that
the runtime reads the section by name through libsui rather than scanning the tail — I verified the
writer and the serializer, not the reader in `cli/lib/standalone`.

### 3.4 Code signing

- macOS: ad-hoc by default. libsui strips an existing signature first (`codesign --remove-signature`,
  best-effort), and on arm64 signs in-process with its own `apple_codesign::MachoSigner`; on x86_64 it
  shells out to `codesign -s -` on a temp file. Deno's docs: `codesign --verify -vv ./main` reports
  "valid on disk / satisfies its Designated Requirement", and a Developer ID signature can be applied
  afterwards in the normal way. **[V]**
- Windows: `signtool sign /fd SHA256 main.exe` after the fact; the PE resource survives signing. **[V]**
- Notarization is again external; Deno links to Apple's docs and says nothing structural. **[V/I]**

### 3.5 Startup strategy

- App code is **transpiled source** in the data section, plus an optional **V8 code cache**: metadata
  carries `code_cache_key` when code caching is on, and `--no-code-cache` turns it off. **[V]**
- Default VFS is in-memory (files served from the section). `--self-extracting` instead extracts to
  disk on first run: `<exe_dir>/.<exe_name>/<hash>/`, then `$XDG_DATA_HOME`/`~/Library/Application
  Support`/`%LOCALAPPDATA%`, reusing the directory when the hash matches. Deno documents the
  trade-offs plainly: slower first run, disk usage, higher memory (data no longer referenced
  statically), and tamper risk. **[V]**
- Deno deliberately embeds the **entire resolved node_modules tree** by default, which is why binaries
  are large and start slowly; `--bundle`, `--minify`, `--exclude-unused-npm`, `--include-as-is` exist
  to cut that down. **[V]**

---

## 4. pkg, nexe, boxednode — the pre-SEA generation

### 4.1 vercel/pkg (deprecated; 5.8.1 last release)

Mechanism **[V]** (`lib/producer.ts`, `lib/packer.ts`):

1. `pkg-fetch` supplies a **prebuilt Node binary** per target (or you build one — the README documents
   both). No linking per app.
2. A small bootstrap in the base binary (from `pkg-fetch`; a patched Node) carries **placeholder
   strings**: `// PAYLOAD_POSITION //`, `// PAYLOAD_SIZE //`, `BAKERY`, `PRELUDE_POSITION`,
   `PRELUDE_SIZE`. The JS prelude is written into the payload area at build time and its position and
   size are patched into those slots.
3. The packer builds a VFS record set (files, symlinks, stats), precompiles JS to **V8 bytecode** by
   default (`--no-bytecode` to keep source), optionally Brotli-compresses it, appends the blob at EOF,
   then patches the placeholders in the binary with the numeric position/size (`injectPlaceholder`,
   `discoverPlaceholder`).
4. At runtime, `process.pkg` exposes the payload; `__filename`/`__dirname`/`process.argv[1]` become
   `/snapshot/...` (`C:\snapshot\...`), and the prelude reads the VFS through an fd on its own
   executable.

Why it aged badly:

- Bytecode is tied to the exact V8/Node version of the base binary, and building it is **not
  deterministic**, so identical sources produce differing binaries (README says so, and recommends
  `--no-bytecode` when reproducibility matters). **[V]**
- Native addons need a prebuild for the target Node ABI, resolved via `prebuild-install`. **[V]**
- macOS signing failures are long-standing: #128 ("main executable failed strict validation when
  signing"), #1338 (binary only runs on the build machine). **[V — issue titles]**
- Antivirus/EDR false positives are the classic complaint: #350, #1350, #1992 ("Trojan.disco detected
  by VirusTotal"). **[V — issue titles]**
- Upstream is archived and points users at Node SEA. **[V]**

### 4.2 nexe

Mechanism **[V]** (`src/nexe.ts`, `src/steps/download.ts`, `src/compiler.ts`):

- Pipeline is `clean → resource → cli → bundle → shim → download → [build: artifacts, patches]`.
- `download` either fetches a **prebuilt Node** for the target (`remoteAsset`, 404 ⇒ "not available,
  create it using the --build flag") or downloads the Node **source tarball** and builds it.
- `bundle` runs browserify/rollup; `resource` adds globbed files; `addResource` puts them into the
  bundle that the shim reads.
- With `--build`, patches are applied to Node's source before compiling — i.e. the "runtime" is
  bespoke per app, which is why it is slow and version-fragile.

Fragility: a prebuilt base only exists for versions nexe published; otherwise you need a full C++
toolchain and tens of minutes; the patched-source path drifts with every Node release. **[V for the
mechanism, I for how often it breaks]**

### 4.3 boxednode (mongodb-js/boxednode)

Different family: **nothing is appended**. It compiles Node from source and links the app in as a
builtin module:

- `./configure --link-module ./lib-boxednode/<namespace>.js` then `make` (or `vcbuild` on Windows);
  the app source is written from `resources/entry-point-trampoline.js`. **[V]** (`src/index.ts`)
- Optional snapshot support (`useNodeSnapshot`, `nodeSnapshotConfigFlags` such as `WithoutCodeCache`),
  which compiles twice: a base image, then an image with the snapshot embedded. **[V]**
- Result: normal, signable, notarizable binary; no fuse, no self-extraction, `process.execPath` is
  just the binary. Cost: a full Node build per app, host-toolchain only, no cross-compile.

This is the closest analogue to "link a new binary" for Node, and the honest comparison point for us:
it buys clean platform semantics at the cost of a compiler and minutes per build.

---

## 5. AWS LLRT — the closest thing to what we would build

LLRT is Rust + QuickJS, like `onde`. It has a compile-to-binary path, and it is the most directly
reusable prior art in this document.

### 5.1 CLI

```
llrt compile input.js [output.lrt] [--executable]
```

`--executable` = "Create a self-contained executable that includes the LLRT runtime". Without it you
get a `.lrt` bytecode file run by the same LLRT version. **[V]** (`llrt/src/main.rs` usage text)

### 5.2 Payload format

`llrt_core/src/bytecode.rs`:

```
"lrt01"          // BYTECODE_VERSION, 5 bytes
'c' | 'u'        // compressed | uncompressed
u32 le           // uncompressed length (only when 'c')
<zstd bytes>     // level 22, with a shared dictionary (COMPRESSION_DICT)
```

The compiler compresses the whole QuickJS module bytecode (`Module::declare` + `module.write`), i.e.
**real QuickJS bytecode**, not source. **[V]**

### 5.3 Self-contained executable layout

`llrt_core/src/compiler.rs`, `compile_file(..., create_executable=true)`:

```
[ bytes of the running llrt executable ]     // fs::read(current_exe)
[ bytecode blob with "lrt01" header ]
[ u64 le: size of the bytecode blob ]
[ "lrtx" ]                                   // BYTECODE_SELF_CONTAINED_EXECUTABLE_MARKER
```

Runtime detection (`start_cli`): seek to `-(4 + 8)` from EOF, read 12 bytes, compare the last 4 with
`lrtx`, parse the `u64`, `start = file_len - size - 12`, read exactly `size`, then
`vm.run_bytecode(&module)`. Note it uses `ne_bytes` for the offset arithmetic and `le_bytes` for the
payload length — sloppy but works on the little-endian targets it ships. **[V]**

There is **no** snapshot of the runtime heap; the "snapshot" is QuickJS bytecode only. Cross-compile is
not supported: the output is a copy of *your* `llrt` binary. **[V]**

Also worth noting: LLRT's Lambda mode never touches this path — Lambda deployments ship `bundle.js`
(esbuild, ESM) in the zip, and the runtime loads it at cold start. The compile path is for the CLI
use case. **[V]**

---

## 6. Adjacent mechanisms (for comparison, not deep detail)

### 6.1 `node --build-snapshot`

Writes a V8 heap snapshot blob (`--snapshot-blob snapshot.blob --build-snapshot snapshot.js`) that is
loaded with `--snapshot-blob` and can carry a deserialize main via
`v8.startupSnapshot.setDeserializeMainFunction()`. Only **one** entrypoint at build time, user-land
modules must be pre-bundled, only a subset of builtins is snapshot-safe, and an unserializable builtin
can crash the builder. The blob is V8-version- and platform-specific. Non-experimental since
v25.4.0/v24.13.1. **[V]** This is the mechanism SEA's `useSnapshot` reuses.

### 6.2 PyInstaller (append-archive family)

- A C **bootloader** is the executable; the app, the Python interpreter and all modules/lib data are
  in an **embedded archive** appended to it.
- One-file mode: bootloader creates `_MEIxxxxxx` in the temp dir, uncompresses support files there,
  then runs exactly like one-folder mode; deletes the folder on exit (not on crash/kill, which leaks
  disk). No-exec `/tmp` breaks it. **[V]**

This is the canonical "append archive, extract to temp, exec" design: simple, portable, and it makes
startup, disk, and antivirus behavior all worse. `--runtime-tmpdir` is the escape hatch. **[V]**

### 6.3 Nuitka (`--mode=onefile`)

Compiles Python to C and links a real binary (so the app is *code*, not a payload), then onefile mode
adds a self-extracting container that unpacks at runtime — same trade-off as PyInstaller, but the
compile side is a genuine AOT translation. **[V for the compile model, I for the exact onefile
container layout]** (Nuitka's public manual page for onefile moved; couldn't pin the URL during this
pass.)

### 6.4 staticx (append + extract, ELF only)

Bundles a dynamic ELF with its shared libraries: the payload is an archive appended to a small
bootloader, extracted at startup to a temp "bundle" dir; it then sets `STATICX_BUNDLE_DIR` and
`STATICX_PROG_PATH`, forces `nodeflib` so only bundled libs load, and warns that NSS config is ignored
for glibc apps. **[V]** Same family as PyInstaller, minus cross-platform ambition.

### 6.5 `qjsc`

Out of scope here (another agent covers it). For the record, its model is "emit C containing the
bytecode, compile and link" — i.e. the boxednode family, not the append family.

---

## 7. What actually breaks in practice

### 7.1 macOS codesign / notarization

- Node: `--build-sea` removes the code signature and leaves re-signing to you; the docs' manual flow
  is remove-signature → inject → `codesign --sign -`. On Intel macOS, `--build-sea` currently
  **segfaults at launch** while the blob+postject path on the same Node works
  ([nodejs/node#65479](https://github.com/nodejs/node/issues/65479), open); a similar Intel-Mac SEA
  segfault was [#62893](https://github.com/nodejs/node/issues/62893).
- Bun: ad-hoc signature correctness has regressed in shipped releases — "codesign regression in
  1.3.12 — invalid or unsupported format for signature"
  ([oven-sh/bun#29361](https://github.com/oven-sh/bun/issues/29361)), fixed by
  [#39772](https://github.com/oven-sh/bun/pull/39772) ("Fix invalid ad-hoc code signature on
  `bun build --compile` darwin-arm64 output"). Bun's own source comment concedes it "gives up on
  codesigning support on macOS" in the LIEF path and re-signs in-process instead.
- pkg: [#128](https://github.com/vercel/pkg/issues/128) "main executable failed strict validation when
  signing binary on macOS"; [#1338](https://github.com/vercel/pkg/issues/1338) binary runs only on the
  build machine.
- Deno: [#575](https://github.com/denoland/deno/issues/575) "sign macos binaries" (historical); today
  ad-hoc signing is automatic via libsui, which is why `deno compile` feels smoother here than SEA.
- postject on Linux arm64 in Docker produced ELF binaries with a broken hash table for addons
  ([nodejs/postject#105](https://github.com/nodejs/postject/issues/105), linked from Node's own docs).

Rule for us: **any byte-level edit on macOS requires re-signing, and the cheapest correct behavior is
to sign ad-hoc in-process at the end of the build** (what libsui and Bun do), rather than telling users
to run `codesign`.

### 7.2 Antivirus / EDR

- Strongest evidence is pkg: [#350](https://github.com/vercel/pkg/issues/350), 
  [#1350](https://github.com/vercel/pkg/issues/1350), [#1992](https://github.com/vercel/pkg/issues/1992)
  ("Trojan.disco detected by VirusTotal"). All are "unsigned self-extracting stub with an appended
  archive" heuristics.
- For SEA/Bun/Deno compiled outputs I did not find a canonical, still-open issue with a clean
  reproduction; reports exist but are diffuse. **Inferred:** the triggers are the same four properties
  — unsigned binary, appending/injection into a signed vendor image, extract-to-temp behavior
  (PyInstaller/staticx), and a large high-entropy tail. Deno's `--self-extracting` and PyInstaller's
  `_MEIxxxx` are the highest-risk patterns; SEA's in-place resource and Deno's default in-memory VFS
  are lower-risk.
- Adjacent but real: Defender scanning costs are a known perf issue for Bun's on-disk caches
  ([oven-sh/bun#44598](https://github.com/oven-sh/bun/issues/44598)), and Deno's install script has
  been blocked by Defender ([denoland/deno#36087](https://github.com/denoland/deno/issues/36087)).
  Neither is about compiled output, but both show the class of problem.

### 7.3 `process.execPath`, `argv[0]`, `argv[1]`

- Node SEA: `__filename === module.filename === process.execPath`, `__dirname` is its dirname, and
  `argv[1]` is **a copy of `argv[0]`** so that code indexing `argv[1]` as "the script" doesn't blow up
  (`FixupArgsForSEA`). Docs show `process.argv` as `['/path/to/sea', 'path/to/sea', 'user-arg1', …]`.
  With `useVfs`, `__filename`/`import.meta.url` instead point inside the virtual mount. **[V]**
- Windows SEA + `cluster.fork()` prepends the executable path into the worker's `process.argv`,
  breaking parsing ([nodejs/node#62776](https://github.com/nodejs/node/issues/62776)). **[V]**
- pkg: `/snapshot/...` paths for `__filename`, `__dirname`, `argv[1]`, `require.main.filename`, plus
  `process.pkg.entrypoint`. Documented table in pkg's README. **[V]**
- Deno: `import.meta.dirname` resolves against the in-binary VFS for framework entrypoints, and
  `--self-extracting` moves everything to a real temp/app-data dir. **[V]**
- Bun: I could not find documented `process.execPath`/`argv[1]` semantics for compiled executables.
  **Unknown; must be tested** before we promise anything. (Bun's compiled output does expose
  `process.execArgv` from `--compile-exec-argv`.) **[I]**

Design takeaway: pick one story and write it down. Our current `process.execPath` = the real binary is
the least surprising; SEA's `argv[1] == argv[0]` hack and pkg's `/snapshot` rewrite are both
compatibility debts.

### 7.4 Self-extraction, updates, size

- Self-extraction (PyInstaller, staticx, `deno compile --self-extracting`) buys native-addon and
  raw-file compatibility, and pays in first-run latency, disk, tamper surface, and crash-leaked temp
  directories. Deno's hash-keyed directory is the best-behaved version of it. **[V]**
- Updates: none of these systems has a built-in updater. The app is the file, so an update is "replace
  the file"; anything finer-grained (delta patch) fights the signature. pkg's `/snapshot` and Bun's
  `/$bunfs` make runtime path assumptions that break naive updaters. **[I, from the mechanisms]**
- Size: append-family binaries are `runtime + payload`, with runtime dominating: Node SEA ≈ a full
  `node` (76 MB install measured in this repo), Bun ≈ a full `bun` (~58 MB), Deno ≈ `denort`. pkg/nexe
  ≈ base Node + compressed VFS. boxednode ≈ a from-source Node. LLRT is the outlier because the
  runtime itself is small. This is exactly where `onde`'s 5.3 MB matters: the payload can dominate,
  not the runtime. **[V for mechanisms, I for cross-system size comparisons]**

### 7.5 Other sharp edges worth remembering

- Bun's compiled executables honor `BUN_OPTIONS` and `BUN_BE_BUN=1` at runtime, and there is an open
  request for build-time switches to disable them
  ([oven-sh/bun#45374](https://github.com/oven-sh/bun/issues/45374)) — an environment-driven behavior
  change in a "standalone" artifact. **[V]**
- Bun: `--external` packages resolve from `process.cwd()`, not the executable's directory
  ([oven-sh/bun#44053](https://github.com/oven-sh/bun/issues/44053)). **[V]**
- Bun: `strip` after `--compile` strips the payload, leaving a binary that silently starts the Bun CLI
  instead of the app ([oven-sh/bun#48405](https://github.com/oven-sh/bun/issues/48405)) — a trailer or
  section layout that assumes nothing rewrites the file. **[V — issue title]**
- Deno moved residual lazy sources to a libsui "sidecar" to keep them demand-paged
  ([denoland/deno#34248](https://github.com/denoland/deno/pull/34248)) — evidence that "read the whole
  payload into memory" (Bun, LLRT) is a real cost at scale. **[V]**
- Node SEA: `disableExperimentalSEAWarning` was silently ineffective for a while
  ([nodejs/node#50547](https://github.com/nodejs/node/issues/50547)). **[V]**

---

## 8. What this implies for `onde`

Not a decision record, just the constraints the prior art establishes:

1. **Append a self-describing payload to our own binary, with a fixed-size trailer.** Bun/LLRT prove
   the shape: `[runtime][blob][offsets/len][magic]`. It needs no LIEF, no postject, no linker, and the
   build is milliseconds. Our runtime is 5.3 MB, so the payload can be the interesting part.
2. **Trailer, not just magic, on Linux; named section or in-place region on macOS.** Appending past a
   Mach-O signature is invalid by construction (Bun truncates because "codesign rejects bytes past the
   signature"; Node strips and re-signs; Deno writes a section and re-signs). If we want one mechanism
   everywhere, we either (a) reserve a payload region *inside* the image at link time (a linker
   section, zero post-processing), or (b) append and re-sign ad-hoc on macOS. Option (a) is the one no
   surveyed system does cleanly, and it is available to us because we control the link step.
3. **QuickJS bytecode at build time beats source**, and LLRT shows the whole implementation is ~150
   lines: `Module::declare` + `Module::write`, zstd with a dictionary, a 6-byte header. No V8 code
   cache portability problem, no `useSnapshot` build-time execution, no platform-specific snapshot.
   The catch is that bytecode is tied to the engine build — the same constraint Deno/Node solve by
   downloading a matching runtime, and the same one we would solve by refusing to mix versions.
4. **Cross-compile = fetch the target runtime, then append.** Bun and Deno both do exactly this and
   nothing smarter. There is no evidence of anyone cross-linking a JS runtime per app.
5. **Code signing is the tax, and it belongs in the build command.** libsui's in-process ad-hoc signer
   (arm64) and Bun's `build_and_sign_into` are the models; "run `codesign` yourself" (Node) is the
   model that generates issues.
6. **Avoid self-extraction.** In-memory/VFS reads keep AV surface, startup, and temp-dir leaks down;
   Deno's default is in-memory and its `--self-extracting` is opt-in with documented costs.
7. **Write down `process.execPath`/`argv` semantics and test them.** Every system here has a different
   answer, and two of them (SEA, pkg) have open bug tails because of it.

---

## 9. Source list

Node: [SEA API docs](https://nodejs.org/api/single-executable-applications.html) ·
[`src/node_sea.cc`](https://github.com/nodejs/node/blob/main/src/node_sea.cc) ·
[`src/node_sea_bin.cc`](https://github.com/nodejs/node/blob/main/src/node_sea_bin.cc) ·
[`src/node_sea.h`](https://github.com/nodejs/node/blob/main/src/node_sea.h) ·
[`--build-snapshot` docs](https://nodejs.org/api/cli.html#--build-snapshot) ·
[postject](https://github.com/nodejs/postject)

Bun: [single-file executable docs](https://bun.com/docs/compiler/executables) ·
[`StandaloneModuleGraph.zig` @ bun-v1.3.3](https://github.com/oven-sh/bun/blob/bun-v1.3.3/src/StandaloneModuleGraph.zig) ·
[`StandaloneModuleGraph.rs` @ main](https://github.com/oven-sh/bun/blob/main/src/standalone_graph/StandaloneModuleGraph.rs)

Deno: [deno compile docs](https://docs.deno.com/runtime/reference/cli/compile/) ·
[`cli/tools/compile.rs`](https://github.com/denoland/deno/blob/main/cli/tools/compile.rs) ·
[`cli/standalone/binary.rs`](https://github.com/denoland/deno/blob/main/cli/standalone/binary.rs) ·
[`cli/lib/standalone/binary.rs`](https://github.com/denoland/deno/blob/main/cli/lib/standalone/binary.rs) ·
[libsui](https://crates.io/crates/libsui/0.16.4)

pkg: [repo](https://github.com/vercel/pkg) · `lib/producer.ts`, `lib/packer.ts`.
nexe: [repo](https://github.com/nexe/nexe) · `src/nexe.ts`, `src/steps/download.ts`, `src/compiler.ts`.
boxednode: [repo](https://github.com/mongodb-js/boxednode) · `src/index.ts`.
LLRT: [repo](https://github.com/awslabs/llrt) · `llrt_core/src/compiler.rs`, `llrt_core/src/bytecode.rs`,
`llrt/src/main.rs`.
Comparisons: [PyInstaller operating mode](https://pyinstaller.org/en/stable/operating-mode.html) ·
[staticx usage](https://staticx.readthedocs.io/en/latest/usage.html) ·
[Nuitka user manual](https://nuitka.net/user-documentation/user-manual.html).
