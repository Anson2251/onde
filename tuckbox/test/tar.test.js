"use strict";

// Unit tests for `dist/lib/tar.js`. Plain CommonJS, no framework: the same file runs under `node`
// and under `onde`, and prints a single `ok tar <N> assertions` line on success.
//
// Every archive is built here, block by block. Committing binary fixtures would hide which bytes
// the reader is actually being asked about; generating them makes each case explicit.

const { list, TarError } = require("../dist/lib/tar.js");

const BLOCK = 512;

let passed = 0;
const failures = [];

function ok(condition, message) {
  if (condition) {
    passed += 1;
  } else {
    failures.push(message);
  }
}

function eq(actual, expected, message) {
  ok(
    Object.is(actual, expected),
    `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
  );
}

function throwsCode(fn, code, message, includes) {
  try {
    fn();
    failures.push(`${message} (expected a throw with code ${code})`);
  } catch (error) {
    const codeOk = error !== null && error !== undefined && error.code === code;
    const messageOk = includes === undefined || String(error && error.message).includes(includes);
    ok(
      codeOk && messageOk,
      `${message} (expected code ${code}${includes === undefined ? "" : ` and message containing ${JSON.stringify(includes)}`}, got ${error && error.code}: ${error && error.message})`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------------------------

function putString(block, offset, value, length) {
  block.write(value, offset, length, "utf8");
}

function putOctal(block, offset, value, width) {
  const text = value.toString(8).padStart(width - 1, "0");
  block.write(text, offset, width - 1, "ascii");
  block[offset + width - 1] = 0;
}

function putBase256(block, offset, value, width) {
  let rest = value;
  for (let i = width - 1; i >= 0; i -= 1) {
    block[offset + i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  // The high bit of the first byte marks the field as base-256 rather than octal.
  block[offset] |= 0x80;
}

function header(options) {
  const config = options || {};
  const name = config.name === undefined ? "" : config.name;
  const mode = config.mode === undefined ? 0o644 : config.mode;
  const size = config.size === undefined ? 0 : config.size;
  const type = config.type === undefined ? "0" : config.type;
  const linkname = config.linkname === undefined ? "" : config.linkname;
  const prefix = config.prefix === undefined ? "" : config.prefix;
  const base256Size = config.base256Size === true;

  const block = Buffer.alloc(BLOCK);
  putString(block, 0, name, 100);
  putOctal(block, 100, mode, 8);
  putOctal(block, 108, 0, 8); // uid
  putOctal(block, 116, 0, 8); // gid
  if (base256Size) {
    putBase256(block, 124, size, 12);
  } else {
    putOctal(block, 124, size, 12);
  }
  putOctal(block, 136, 0, 12); // mtime
  block.fill(0x20, 148, 156); // checksum field, while summing
  putString(block, 156, type, 1);
  putString(block, 157, linkname, 100);
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  putString(block, 345, prefix, 155);

  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += block[i];
  block.write(sum.toString(8).padStart(6, "0").slice(-6), 148, 6, "ascii");
  block[154] = 0;
  block[155] = 0x20;
  return block;
}

function padded(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const remainder = buffer.length % BLOCK;
  if (remainder === 0) return buffer;
  return Buffer.concat([buffer, Buffer.alloc(BLOCK - remainder)]);
}

function file(name, content, options) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([
    header(Object.assign({}, options, { name, size: data.length, type: "0" })),
    padded(data),
  ]);
}

function directory(name, options) {
  return header(Object.assign({}, options, { name, size: 0, type: "5", mode: 0o755 }));
}

/** `LEN key=value\n`, where LEN counts the digits, the space and the trailing newline. */
function paxRecord(key, value) {
  const body = Buffer.from(`${key}=${value}\n`, "utf8");
  let length = body.length + 2;
  for (;;) {
    const next = String(length).length + 1 + body.length;
    if (next === length) break;
    length = next;
  }
  return Buffer.concat([Buffer.from(`${length} `, "ascii"), body]);
}

/** A GNU long-name (`L`) or long-link (`K`) record followed by its NUL-terminated payload. */
function gnuLongHeader(type, value) {
  const data = Buffer.from(`${value}\0`, "utf8");
  return Buffer.concat([
    header({ name: "././@LongLink", size: data.length, type }),
    padded(data),
  ]);
}

function endBlocks() {
  return Buffer.alloc(BLOCK * 2);
}

function archive(parts) {
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------------------------

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test("simple file", () => {
  const tar = archive([file("package/index.js", "hello world"), endBlocks()]);
  const entries = list(tar);
  eq(entries.length, 1, "simple: one entry");
  const entry = entries[0];
  eq(entry.path, "index.js", "simple: leading package/ is stripped");
  eq(entry.type, "file", "simple: type is file");
  eq(entry.mode, 0o644, "simple: mode is preserved");
  eq(entry.data.toString("utf8"), "hello world", "simple: data is the payload");
  eq(entry.linkname, "", "simple: linkname is empty");
});

test("NUL typeflag is a regular file", () => {
  const entries = list(archive([file("package/nul.txt", "ok", { type: "\0" }), endBlocks()]));
  eq(entries.length, 1, "nul type: one entry");
  eq(entries[0].type, "file", "nul type: typeflag 0 is a file");
  eq(entries[0].data.toString("utf8"), "ok", "nul type: data is read");
});

test("zero-length file", () => {
  const entries = list(archive([file("package/empty", ""), endBlocks()]));
  eq(entries.length, 1, "empty file: one entry");
  eq(entries[0].data.length, 0, "empty file: zero-length data");
});

test("directory entry", () => {
  const entries = list(archive([directory("package/lib/"), endBlocks()]));
  eq(entries.length, 1, "dir: one entry");
  eq(entries[0].path, "lib", "dir: trailing slash is stripped");
  eq(entries[0].type, "dir", "dir: type is dir");
  eq(entries[0].mode, 0o755, "dir: mode is preserved");
  eq(entries[0].data, null, "dir: data is null");
});

test("ustar prefix field", () => {
  const tar = archive([
    header({ name: "index.js", prefix: "package/lib", size: 2 }),
    padded("hi"),
    endBlocks(),
  ]);
  const entries = list(tar);
  eq(entries.length, 1, "prefix: one entry");
  eq(entries[0].path, "lib/index.js", "prefix: prefix and name are joined");
});

test("path normalization", () => {
  const entries = list(
    archive([file("./package//lib//deep/x.js", "x"), endBlocks()]),
  );
  eq(entries.length, 1, "normalize: one entry");
  eq(entries[0].path, "lib/deep/x.js", "normalize: ./ and // are collapsed");
});

test("pax path", () => {
  const longPath = `package/${"p".repeat(120)}/main.js`;
  const record = paxRecord("path", longPath);
  const tar = archive([
    header({ name: "package/ignored.js", size: record.length, type: "x" }),
    padded(record),
    header({ name: "package/short.js", size: 4 }),
    padded("pax!"),
    endBlocks(),
  ]);
  const entries = list(tar);
  eq(entries.length, 1, "pax path: header itself is not an entry");
  eq(entries[0].path, `${"p".repeat(120)}/main.js`, "pax path: override wins");
  eq(entries[0].data.toString("utf8"), "pax!", "pax path: payload follows the real header");
});

test("pax global header applies to the next entry", () => {
  const record = paxRecord("path", "package/from-global.js");
  const tar = archive([
    header({ name: "package/ignored.js", size: record.length, type: "g" }),
    padded(record),
    header({ name: "package/original.js", size: 2 }),
    padded("g!"),
    endBlocks(),
  ]);
  const entries = list(tar);
  eq(entries.length, 1, "pax g: header itself is not an entry");
  eq(entries[0].path, "from-global.js", "pax g: override wins");
});

test("pax linkpath and size", () => {
  const longTarget = `targets/${"q".repeat(120)}.js`;
  const record = Buffer.concat([paxRecord("linkpath", longTarget), paxRecord("size", "0")]);
  const tar = archive([
    header({ name: "package/link.js", size: record.length, type: "x" }),
    padded(record),
    header({ name: "package/link.js", type: "2", linkname: "short.js", size: 0 }),
    endBlocks(),
  ]);
  const entries = list(tar);
  eq(entries.length, 1, "pax linkpath: one entry");
  eq(entries[0].type, "symlink", "pax linkpath: type is symlink");
  eq(entries[0].linkname, longTarget, "pax linkpath: override wins");
});

test("pax size overrides the header size", () => {
  const record = paxRecord("size", "5");
  const tar = archive([
    header({ name: "package/x", size: record.length, type: "x" }),
    padded(record),
    header({ name: "package/sized.txt", size: 0 }),
    padded("sized"),
    endBlocks(),
  ]);
  const entries = list(tar);
  eq(entries.length, 1, "pax size: one entry");
  eq(entries[0].data.toString("utf8"), "sized", "pax size: payload is read using the override");
});

test("GNU long name", () => {
  const longName = `package/${"g".repeat(130)}.js`;
  const tar = archive([
    gnuLongHeader("L", longName),
    header({ name: "package/short.js", size: 3 }),
    padded("gnu"),
    endBlocks(),
  ]);
  const entries = list(tar);
  eq(entries.length, 1, "gnu L: one entry");
  eq(entries[0].path, `${"g".repeat(130)}.js`, "gnu L: long name is applied");
  eq(entries[0].data.toString("utf8"), "gnu", "gnu L: payload belongs to the real entry");
});

test("GNU long link name", () => {
  const longTarget = `../${"k".repeat(130)}.js`;
  const tar = archive([
    gnuLongHeader("K", longTarget),
    header({ name: "package/link.js", type: "2", linkname: "short.js", size: 0 }),
    endBlocks(),
  ]);
  const entries = list(tar);
  eq(entries.length, 1, "gnu K: one entry");
  eq(entries[0].type, "symlink", "gnu K: type is symlink");
  eq(entries[0].linkname, longTarget, "gnu K: long link name is applied");
});

test("base-256 size", () => {
  const data = Buffer.alloc(600, 0x61);
  const tar = archive([
    header({ name: "package/big.bin", size: data.length, base256Size: true }),
    padded(data),
    endBlocks(),
  ]);
  const entries = list(tar);
  eq(entries.length, 1, "base256: one entry");
  eq(entries[0].data.length, 600, "base256: size is decoded from base-256");
  eq(entries[0].data[0], 0x61, "base256: first data byte");
  eq(entries[0].data[599], 0x61, "base256: last data byte");
});

test("two files with padding", () => {
  const second = Buffer.alloc(513, 0x7a);
  const tar = archive([
    file("package/a.txt", "abc"),
    file("package/b.txt", second),
    endBlocks(),
  ]);
  const entries = list(tar);
  eq(entries.length, 2, "padding: two entries");
  eq(entries[0].path, "a.txt", "padding: first path");
  eq(entries[0].data.toString("utf8"), "abc", "padding: first data");
  eq(entries[1].path, "b.txt", "padding: second path");
  eq(entries[1].data.length, 513, "padding: second data length");
  eq(entries[1].data[0], 0x7a, "padding: second data first byte");
  eq(entries[1].data[512], 0x7a, "padding: second data last byte");
});

test("clean truncated tail is accepted", () => {
  const entries = list(file("package/only.txt", "tail"));
  eq(entries.length, 1, "truncated tail: entry count");
  eq(entries[0].path, "only.txt", "truncated tail: entry path");
});

test("absolute path", () => {
  throwsCode(
    () => list(archive([file("/etc/passwd", "x"), endBlocks()])),
    "ETARUNSAFE",
    "absolute path is rejected",
    "absolute",
  );
});

test("parent segment", () => {
  throwsCode(
    () => list(archive([file("package/../escape.txt", "x"), endBlocks()])),
    "ETARUNSAFE",
    ".. segment is rejected",
    "parent",
  );
});

test("the archive root itself", () => {
  // `npm pack` emits no directory entries at all, but other packers emit the root as `package/`.
  // It describes the directory tuckbox is already unpacking into, so it is skipped, not an error.
  const entries = list(archive([directory("package/"), file("package/x.js", "x"), endBlocks()]));
  eq(entries.length, 1, "an explicit package/ directory entry is dropped");
  eq(entries[0].path, "x.js", "the rest of the archive is unaffected");

  // A nameless *file* would land directly in the store root with no path to check, so it stays
  // an error: the type decides, not the empty string on its own.
  throwsCode(
    () => list(archive([file("package/", "x"), endBlocks()])),
    "ETARUNSAFE",
    "a file entry that normalizes to empty is rejected",
    "empty path",
  );
});

test("truncated data", () => {
  throwsCode(
    () => list(archive([header({ name: "package/x", size: 100 }), Buffer.alloc(10)])),
    "ETRUNCATED",
    "data cut mid-payload is rejected",
    "ends inside",
  );
});

test("truncated padding", () => {
  throwsCode(
    () => list(archive([header({ name: "package/x", size: 1 }), Buffer.from("x")])),
    "ETRUNCATED",
    "missing block padding is rejected",
  );
});

test("unknown typeflag", () => {
  throwsCode(
    () => list(archive([header({ name: "package/dev", type: "3", size: 0 }), endBlocks()])),
    "ETARUNSAFE",
    "character device is rejected",
    "typeflag",
  );
  throwsCode(
    () => list(archive([header({ name: "package/fifo", type: "6", size: 0 }), endBlocks()])),
    "ETARUNSAFE",
    "fifo is rejected",
  );
  throwsCode(
    () => list(archive([header({ name: "package/contig", type: "7", size: 0 }), endBlocks()])),
    "ETARUNSAFE",
    "contiguous file is rejected",
  );
});

test("file linkname field is ignored", () => {
  const entries = list(
    archive([file("package/f.txt", "x", { linkname: "not-a-link" }), endBlocks()]),
  );
  eq(entries[0].linkname, "", "file: linkname is empty even when the header field is set");
});

test("links are returned as data, not followed", () => {
  const tar = archive([
    header({ name: "package/link.js", type: "2", linkname: "../outside.js", size: 0 }),
    header({ name: "package/hard.js", type: "1", linkname: "index.js", size: 0 }),
    endBlocks(),
  ]);
  const entries = list(tar);
  eq(entries.length, 2, "links: two entries");
  eq(entries[0].type, "symlink", "links: symlink type");
  eq(entries[0].linkname, "../outside.js", "links: symlink target preserved verbatim");
  eq(entries[0].data, null, "links: symlink has no data");
  eq(entries[1].type, "hardlink", "links: hardlink type");
  eq(entries[1].linkname, "index.js", "links: hardlink target preserved");
});

test("TarError is the thrown type", () => {
  try {
    list(archive([file("/absolute", "x"), endBlocks()]));
    failures.push("TarError type: expected a throw");
  } catch (error) {
    ok(error instanceof TarError, "TarError type: error is a TarError instance");
    eq(error.name, "TarError", "TarError type: name is TarError");
  }
});

// ---------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------

for (const { name, fn } of tests) {
  try {
    fn();
  } catch (error) {
    failures.push(
      `${name}: unexpected exception: ${error && error.stack ? error.stack : String(error)}`,
    );
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`not ok tar: ${failure}`);
  console.error(`not ok tar ${failures.length} failure(s), ${passed} assertion(s) passed`);
  process.exit(1);
}

console.log(`ok tar ${passed} assertions`);
