"use strict";

// Unit tests for `dist/lib/store.js`. Plain CommonJS, no framework: the same file runs under
// `node` and under `lite`, and prints a single `ok store <N> assertions` line on success.
//
// The archives are generated in code and gzipped here, so the test exercises the real
// gunzip -> tar.list -> disk path without committing a binary fixture.

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const store = require("../dist/lib/store.js");

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

/** Record a throw of any shape; used where the errno is incidental to the cleanup being tested. */
function throwsAny(fn, message) {
  try {
    fn();
    failures.push(`${message} (expected a throw)`);
    return null;
  } catch (error) {
    passed += 1;
    return error;
  }
}

// ---------------------------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------------------------

function putString(block, offset, value, length) {
  block.write(value, offset, length, "utf8");
}

function putOctal(block, offset, value, width) {
  block.write(value.toString(8).padStart(width - 1, "0"), offset, width - 1, "ascii");
  block[offset + width - 1] = 0;
}

function header(options) {
  const config = options || {};
  const name = config.name === undefined ? "" : config.name;
  const mode = config.mode === undefined ? 0o644 : config.mode;
  const size = config.size === undefined ? 0 : config.size;
  const type = config.type === undefined ? "0" : config.type;
  const linkname = config.linkname === undefined ? "" : config.linkname;

  const block = Buffer.alloc(BLOCK);
  putString(block, 0, name, 100);
  putOctal(block, 100, mode, 8);
  putOctal(block, 108, 0, 8); // uid
  putOctal(block, 116, 0, 8); // gid
  putOctal(block, 124, size, 12);
  putOctal(block, 136, 0, 12); // mtime
  block.fill(0x20, 148, 156);
  putString(block, 156, type, 1);
  putString(block, 157, linkname, 100);
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");

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

function archive(parts) {
  return Buffer.concat(parts.concat([Buffer.alloc(BLOCK * 2)]));
}

// ---------------------------------------------------------------------------------------------
// Fixture package
// ---------------------------------------------------------------------------------------------

const PACKAGE_JSON = '{"name":"probe","version":"1.0.0"}\n';
const INDEX_JS = "module.exports = 42;\n";
const DEEP_JS = "module.exports = 'deep';\n";
const CLI_JS = "#!/usr/bin/env node\nconsole.log('cli');\n";

function packageTar() {
  return archive([
    directory("package/lib/"),
    file("package/package.json", PACKAGE_JSON),
    file("package/lib/index.js", INDEX_JS),
    // No directory entry for lib/sub: npm tarballs do not list directories, so unpack has to
    // create the parents of a file itself.
    file("package/lib/sub/deep.js", DEEP_JS),
    file("package/bin/cli.js", CLI_JS, { mode: 0o755 }),
    file("package/suid.js", "no setuid\n", { mode: 0o4755 }),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Scratch space
// ---------------------------------------------------------------------------------------------

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tuckbox-store-test-"));
const storeDir = path.join(root, "store");

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------------------------
// Hashing and integrity
// ---------------------------------------------------------------------------------------------

test("sha512 helpers", () => {
  eq(
    store.sha512Hex(Buffer.alloc(0)),
    "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e",
    "sha512Hex: sha512 of the empty buffer",
  );
  eq(
    store.sha512Integrity(Buffer.from("abc")),
    "sha512-3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==",
    "sha512Integrity: sha512-<base64> of abc",
  );
  ok(/^[0-9a-f]{128}$/.test(store.sha512Hex(Buffer.from("tuckbox"))), "sha512Hex: lowercase hex");
  eq(
    store.storePath("/tmp/store", "abc"),
    path.join("/tmp/store", "abc"),
    "storePath: joins the hash under the store directory",
  );
});

test("verifyIntegrity accepts the published forms", () => {
  const abc = Buffer.from("abc");
  const integrity = store.sha512Integrity(abc);

  ok(store.verifyIntegrity(abc, integrity), "sha512: matching integrity verifies");
  ok(!store.verifyIntegrity(Buffer.from("abd"), integrity), "sha512: mismatch rejects");

  // dist.shasum is a sha1 hex; the registry workstream passes it as `sha1-<hex>`.
  ok(
    store.verifyIntegrity(abc, "sha1-a9993e364706816aba3e25717850c26c9cd0d89d"),
    "sha1: hex shasum verifies",
  );
  ok(
    store.verifyIntegrity(abc, "sha1-qZk+NkcGgWq6PiVxeFDCbJzQ2J0="),
    "sha1: base64 digest verifies",
  );
  ok(
    !store.verifyIntegrity(abc, "sha1-0000000000000000000000000000000000000000"),
    "sha1: mismatch rejects",
  );

  // SRI permits several hashes in one field; a matching supported one is a pass.
  ok(
    store.verifyIntegrity(
      abc,
      `sha1-0000000000000000000000000000000000000000 ${integrity}`,
    ),
    "multi-hash: any matching entry verifies",
  );
});

test("verifyIntegrity returns false for malformed values and never throws", () => {
  const abc = Buffer.from("abc");
  const malformed = [
    "",
    "nonsense",
    "sha512-",
    "sha512-not base64",
    "sha512-abc",
    "sha256-3a81oZNherrMQXNJriBBM",
    "SHA512-3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==",
  ];
  for (const value of malformed) {
    let result;
    let threw = false;
    try {
      result = store.verifyIntegrity(abc, value);
    } catch (_) {
      threw = true;
    }
    ok(!threw && result === false, `malformed ${JSON.stringify(value)} is false, not a throw`);
  }

  let threw = false;
  try {
    // A caller bug (null) must still not escape as an exception.
    store.verifyIntegrity(abc, null);
  } catch (_) {
    threw = true;
  }
  ok(!threw, "verifyIntegrity never throws, even for a non-string");
});

// ---------------------------------------------------------------------------------------------
// unpack
// ---------------------------------------------------------------------------------------------

const gz = zlib.gzipSync(packageTar());
const gzHex = store.sha512Hex(gz);
const gzIntegrity = store.sha512Integrity(gz);

test("unpack writes the package under its content hash", () => {
  const unpacked = store.unpack(storeDir, gz, gzIntegrity);

  eq(unpacked, path.join(storeDir, gzHex), "unpack: returns store/<sha512 hex>");
  ok(fs.existsSync(unpacked), "unpack: store directory exists");
  eq(
    fs.readFileSync(path.join(unpacked, "package.json"), "utf8"),
    PACKAGE_JSON,
    "unpack: package.json contents",
  );
  eq(
    fs.readFileSync(path.join(unpacked, "lib/index.js"), "utf8"),
    INDEX_JS,
    "unpack: nested file contents",
  );
  eq(
    fs.readFileSync(path.join(unpacked, "lib/sub/deep.js"), "utf8"),
    DEEP_JS,
    "unpack: parents created for files without directory entries",
  );
  ok(fs.statSync(path.join(unpacked, "lib")).isDirectory(), "unpack: explicit directory entry");

  // Files are masked to 0o666, so an executable bit in the tarball is not reproduced.
  eq(
    fs.statSync(path.join(unpacked, "bin/cli.js")).mode & 0o111,
    0,
    "unpack: files never get execute bits",
  );
  eq(
    fs.statSync(path.join(unpacked, "suid.js")).mode & 0o6000,
    0,
    "unpack: setuid/setgid bits are cleared",
  );
  eq(
    fs.statSync(path.join(unpacked, "lib")).mode & 0o6000,
    0,
    "unpack: directories never get setuid/setgid bits",
  );
});

test("unpack is idempotent", () => {
  const first = path.join(storeDir, gzHex);
  const before = fs.readdirSync(storeDir).sort();
  const second = store.unpack(storeDir, gz, gzIntegrity);

  eq(second, first, "idempotent: second unpack returns the same path");
  eq(
    fs.readdirSync(storeDir).sort().join("|"),
    before.join("|"),
    "idempotent: the store gains no second copy",
  );
  ok(
    !fs.readdirSync(storeDir).some((name) => name.startsWith(".tmp-")),
    "idempotent: no temporary directory is left behind",
  );
  eq(
    fs.readFileSync(path.join(second, "package.json"), "utf8"),
    PACKAGE_JSON,
    "idempotent: existing package contents are untouched",
  );
});

test("integrity mismatch writes nothing", () => {
  const badStoreDir = path.join(root, "bad-store");
  const wrong = `sha512-${"A".repeat(86)}==`;

  throwsCode(
    () => store.unpack(badStoreDir, gz, wrong),
    "EINTEGRITY",
    "integrity mismatch is EINTEGRITY",
    "expected",
  );
  ok(!fs.existsSync(badStoreDir), "integrity mismatch: store directory was never created");
});

test("a tarball that is not gzip is ETARBALL", () => {
  // Some registries still serve plain `.tar`; the gzip failure must not surface as a bare zlib
  // error with no code, because the caller branches on the code.
  const plainTar = archive([file("package/package.json", PACKAGE_JSON)]);
  const plainIntegrity = `sha512-${createHash("sha512").update(plainTar).digest("base64")}`;

  throwsCode(
    () => store.unpack(path.join(root, "plain-store"), plainTar, plainIntegrity),
    "ETARBALL",
    "uncompressed tar is ETARBALL",
    "gzip",
  );
  ok(!fs.existsSync(path.join(root, "plain-store")), "uncompressed tar: nothing was written");
});

test("symlink entries are rejected", () => {
  const symlinkTar = zlib.gzipSync(
    archive([
      file("package/package.json", PACKAGE_JSON),
      header({ name: "package/link.js", type: "2", linkname: "/etc/passwd", size: 0 }),
    ]),
  );
  const symlinkHex = store.sha512Hex(symlinkTar);

  throwsCode(
    () => store.unpack(storeDir, symlinkTar, store.sha512Integrity(symlinkTar)),
    "ETARBALL",
    "symlink entry is ETARBALL",
    "symlink",
  );
  ok(!fs.existsSync(path.join(storeDir, symlinkHex)), "symlink entry: nothing is stored");
  ok(
    !fs.readdirSync(storeDir).some((name) => name.startsWith(".tmp-")),
    "symlink entry: no temporary directory is left behind",
  );
});

test("hardlink entries are rejected", () => {
  const hardlinkTar = zlib.gzipSync(
    archive([
      file("package/package.json", PACKAGE_JSON),
      header({ name: "package/hard.js", type: "1", linkname: "package.json", size: 0 }),
    ]),
  );
  const hardlinkHex = store.sha512Hex(hardlinkTar);

  throwsCode(
    () => store.unpack(storeDir, hardlinkTar, store.sha512Integrity(hardlinkTar)),
    "ETARBALL",
    "hardlink entry is ETARBALL",
    "hardlink",
  );
  ok(!fs.existsSync(path.join(storeDir, hardlinkHex)), "hardlink entry: nothing is stored");
});

test("a failed write cleans up the temporary directory", () => {
  // `a` as a file and `a/b` as a file cannot both exist; the second write fails partway through.
  const conflictTar = zlib.gzipSync(
    archive([file("package/a", "x"), file("package/a/b", "y")]),
  );
  const conflictHex = store.sha512Hex(conflictTar);

  throwsAny(
    () => store.unpack(storeDir, conflictTar, store.sha512Integrity(conflictTar)),
    "conflicting entry writes fail",
  );
  ok(
    !fs.existsSync(path.join(storeDir, conflictHex)),
    "failed write: the final path is not published",
  );
  ok(
    !fs.readdirSync(storeDir).some((name) => name.startsWith(".tmp-")),
    "failed write: the temporary directory is removed",
  );
});

// ---------------------------------------------------------------------------------------------
// materialize
// ---------------------------------------------------------------------------------------------

test("materialize hardlinks the tree", () => {
  const from = path.join(storeDir, gzHex);
  const to = path.join(root, "node_modules", "probe");

  store.materialize(from, to);

  ok(fs.statSync(to).isDirectory(), "materialize: destination directory is created");
  eq(
    fs.readFileSync(path.join(to, "package.json"), "utf8"),
    PACKAGE_JSON,
    "materialize: file contents",
  );
  eq(
    fs.readFileSync(path.join(to, "lib/sub/deep.js"), "utf8"),
    DEEP_JS,
    "materialize: nested file contents",
  );

  const sourceStat = fs.statSync(path.join(from, "package.json"));
  const targetStat = fs.statSync(path.join(to, "package.json"));
  ok(targetStat.ino === sourceStat.ino, "materialize: package.json is a hardlink (same inode)");
  ok(sourceStat.nlink >= 2, "materialize: the source link count increased");
  ok(
    fs.statSync(path.join(to, "lib/index.js")).ino ===
      fs.statSync(path.join(from, "lib/index.js")).ino,
    "materialize: nested file is a hardlink (same inode)",
  );
});

test("re-materialize replaces a modified file", () => {
  const from = path.join(storeDir, gzHex);
  const to = path.join(root, "node_modules", "probe");
  const target = path.join(to, "lib/index.js");

  // Break the hardlink before overwriting so the store itself is not modified.
  fs.unlinkSync(target);
  fs.writeFileSync(target, "tampered\n");
  eq(fs.readFileSync(target, "utf8"), "tampered\n", "re-materialize: destination was modified");

  store.materialize(from, to);

  eq(fs.readFileSync(target, "utf8"), INDEX_JS, "re-materialize: modified file is restored");
  ok(
    fs.statSync(target).ino === fs.statSync(path.join(from, "lib/index.js")).ino,
    "re-materialize: restored file is hardlinked again",
  );

  // Running it again over an already-correct tree must be a no-op, not an EEXIST failure.
  store.materialize(from, to);
  eq(fs.readFileSync(path.join(to, "package.json"), "utf8"), PACKAGE_JSON, "re-materialize: idempotent");
});

test("materialize refuses a symlink in the source", () => {
  const from = path.join(root, "weird-source");
  fs.mkdirSync(from, { recursive: true });
  fs.symlinkSync("target", path.join(from, "link"));
  throwsCode(
    () => store.materialize(from, path.join(root, "weird-destination")),
    "ETARBALL",
    "materialize: a non-file entry is refused",
  );
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

fs.rmSync(root, { recursive: true, force: true });

if (failures.length > 0) {
  for (const failure of failures) console.error(`not ok store: ${failure}`);
  console.error(`not ok store ${failures.length} failure(s), ${passed} assertion(s) passed`);
  process.exit(1);
}

console.log(`ok store ${passed} assertions`);
