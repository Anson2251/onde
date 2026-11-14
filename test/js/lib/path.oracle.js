"use strict";

// Node-only differential oracle for js/lib/path.js.
//
//   node test/js/lib/path.oracle.js
//
// Compares every exported path operation against Node's own `path` module for
// both flavors over a large table of fixed and pseudo-random inputs. Exits
// nonzero (via node:assert) on the first mismatch batch, printing the inputs.

const assert = require("node:assert");
const nodePath = require("node:path");
const ours = require("../../../js/lib/path.js");

const FLAVORS = ["posix", "win32"];
const METHODS = [
  "join",
  "normalize",
  "isAbsolute",
  "relative",
  "resolve",
  "basename",
  "dirname",
  "extname",
  "parse",
  "format",
  "toNamespacedPath",
];

let comparisons = 0;
let mismatchCount = 0;
const firstMismatches = [];
const covered = new Set();

function repr(value) {
  if (typeof value === "string") return "string " + JSON.stringify(value);
  if (typeof value === "bigint") return "bigint " + String(value) + "n";
  if (typeof value === "symbol") return "symbol " + String(value);
  if (typeof value === "function") return "function " + (value.name || "(anonymous)");
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "object") {
    try {
      return "object " + JSON.stringify(value);
    } catch (_) {
      return "object " + String(value);
    }
  }
  return typeof value + " " + String(value);
}

function invoke(target, method, args) {
  try {
    return { threw: false, value: target[method](...args) };
  } catch (err) {
    return { threw: true, name: err && err.name, code: err && err.code };
  }
}

function outcome(result) {
  if (result.threw) return "throw " + result.name + " code=" + String(result.code);
  return "return " + repr(result.value);
}

function compare(flavor, method, args) {
  comparisons++;
  covered.add(method);

  const actual = invoke(ours[flavor], method, args);
  const expected = invoke(nodePath[flavor], method, args);

  const actualText = outcome(actual);
  const expectedText = outcome(expected);
  if (actualText === expectedText) return;

  mismatchCount++;
  if (firstMismatches.length < 8) {
    firstMismatches.push({
      flavor,
      method,
      args,
      actual: actualText,
      expected: expectedText,
    });
  }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

let seed = 0x9e3779b9;
function nextRandom() {
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed / 0x100000000;
}

const ALPHABET = [
  "a", "b", "c", "C", "D", "Z", ".", "..", "/", "\\", ":", "?", " ", "1", "-", "_",
  "COM1", "CON", "UNC", "İ",
];

function randomPath(maxLength) {
  const length = Math.floor(nextRandom() * (maxLength + 1));
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET[Math.floor(nextRandom() * ALPHABET.length)];
  }
  return out;
}

const FIXED_INPUTS = [
  "",
  ".",
  "..",
  "...",
  "./",
  "../",
  ".//",
  "..//",
  "a",
  "a/",
  "a//",
  "a/b",
  "a//b",
  "a/b/",
  "a/b//",
  "a/./b",
  "a/../b",
  "a/../../b",
  "/",
  "//",
  "///",
  "////",
  "\\",
  "\\\\",
  "\\\\\\",
  "/a",
  "//a",
  "///a",
  "/a/",
  "/a//",
  "/a/b",
  "/a/b/",
  "/a//b",
  "/a/./b",
  "/a/../b",
  "/a/b/../../c",
  "foo",
  "foo.",
  "foo..",
  ".foo",
  ".gitignore",
  "foo.txt",
  "foo.tar.gz",
  "base.tar.gz",
  "...a",
  "a...",
  "a.b.c",
  "a..b",
  "/foo",
  "/foo/",
  "/foo/bar",
  "/foo/bar/",
  "/foo/bar.txt",
  "/foo/.gitignore",
  "/foo/bar.tar.gz",
  "/foo/bar/..",
  "/foo/bar/../baz",
  "C:",
  "C:.",
  "C:..",
  "C:\\",
  "C:/",
  "C:\\\\",
  "C:foo",
  "C:foo\\bar",
  "C:foo/bar",
  "C:\\foo",
  "C:/foo",
  "C:\\foo\\",
  "C:\\foo\\bar",
  "C:/foo/bar/",
  "C:\\foo\\..\\bar",
  "C:\\foo/../bar",
  "c:\\Foo\\BAR.TXT",
  "\\\\.",
  "\\\\.\\",
  "\\\\.\\pipe\\x",
  "\\\\?",
  "\\\\?\\",
  "\\\\?\\C:",
  "\\\\?\\C:\\",
  "\\\\?\\C:\\foo",
  "\\\\?\\C:\\foo\\bar",
  "\\\\?\\COM1",
  "\\\\?\\COM1\\x",
  "\\\\?\\UNC\\server\\share\\x",
  "\\\\server",
  "\\\\server\\",
  "\\\\server\\share",
  "\\\\server\\share\\",
  "\\\\server\\share\\x",
  "\\\\server\\share\\x\\",
  "\\\\server\\share\\..\\x",
  "//server/share",
  "//server/share/",
  "//server/share/x",
  "//server",
  "//server/",
  "a\\b",
  "a\\b\\",
  "..\\..\\a",
  "a\\..\\b",
  "foo/bar\\baz",
  "foo\\bar/baz",
  "COM1",
  "COM1:",
  "COM1:foo",
  "CON",
  "NUL",
  "con:foo",
  "lpt9.txt",
  "C:\\COM1",
  "C:\\foo\\COM1",
  "a:b",
  "a:b:c",
  "foo:bar",
  ":foo",
  "a:",
  "::",
  "\\?\\C:\\foo",
  "?C:\\foo",
  " ",
  "  ",
  "a b",
  "a\u0000b",
  "🙂/x",
  "İ",
  "C:\\İ",
  "C:\\İ\\x",
  "c:\\i̇\\y",
  "ß",
  "C:\\ẞ\\x",
  "a".repeat(60) + "/b",
];

const inputTable = FIXED_INPUTS.slice();
for (let i = 0; i < 600; i++) inputTable.push(randomPath(16));

const SUFFIXES = [
  undefined,
  "",
  ".",
  "..",
  ".txt",
  "txt",
  ".gz",
  ".tar.gz",
  ".gitignore",
  "/",
  "\\",
];

const FORMAT_OBJECTS = [
  {},
  { dir: "/foo", base: "bar.txt" },
  { root: "/", base: "bar" },
  { dir: "/x", root: "/", base: "a" },
  { name: "a", ext: "b" },
  { name: "a", ext: ".b" },
  { name: "a", ext: "" },
  { base: "a", name: "b", ext: ".c" },
  { dir: "", root: "", base: "" },
  { dir: null, root: undefined, base: null },
  { name: "", ext: "" },
  { dir: "/a/b", name: "file", ext: ".js" },
  { dir: "C:\\foo", base: "bar.txt" },
  { root: "C:\\", base: "bar" },
  { dir: "C:\\foo", root: "C:\\", base: "bar" },
  { root: "\\\\server\\share\\", base: "x" },
  { dir: "//server/share", base: "x" },
  { name: 5, ext: 6 },
  { name: "a", ext: { toString() { return ".weird"; } } },
  { base: 0, name: "fallback" },
  { dir: 0, root: "/", base: "x" },
  new Date(0),
  /re/,
  new Map(),
  Object.create(null),
];

// ---------------------------------------------------------------------------
// Comparisons
// ---------------------------------------------------------------------------

const pairTable = [];
for (let i = 0; i < FIXED_INPUTS.length; i += 7) {
  for (let j = 0; j < FIXED_INPUTS.length; j += 11) {
    pairTable.push([FIXED_INPUTS[i], FIXED_INPUTS[j]]);
  }
}
for (let i = 0; i < 1000; i++) pairTable.push([randomPath(12), randomPath(12)]);

for (const flavor of FLAVORS) {
  for (const input of inputTable) {
    compare(flavor, "normalize", [input]);
    compare(flavor, "isAbsolute", [input]);
    compare(flavor, "dirname", [input]);
    compare(flavor, "extname", [input]);
    compare(flavor, "parse", [input]);
    compare(flavor, "toNamespacedPath", [input]);
    compare(flavor, "join", [input]);
    compare(flavor, "resolve", [input]);

    for (const suffix of SUFFIXES) {
      compare(flavor, "basename", suffix === undefined ? [input] : [input, suffix]);
    }

    const parsed = nodePath[flavor].parse(input);
    compare(flavor, "format", [parsed]);
    compare(flavor, "format", [Object.assign({}, parsed, { ext: "no-dot" })]);
    compare(flavor, "format", [Object.assign({}, parsed, { ext: ".with-dot" })]);
  }

  for (const object of FORMAT_OBJECTS) {
    compare(flavor, "format", [object]);
  }

  for (const [from, to] of pairTable) {
    compare(flavor, "join", [from, to]);
    compare(flavor, "relative", [from, to]);
    compare(flavor, "resolve", [from, to]);
    compare(flavor, "join", [from, to, randomPath(6)]);
    compare(flavor, "resolve", [from, to, randomPath(6)]);
  }

  // Error handling: every method that validates a string argument.
  const badValues = [
    null,
    undefined,
    1,
    1.5,
    Number.NaN,
    true,
    false,
    {},
    [],
    [1, 2],
    function namedFn() {},
    Symbol("sym"),
    10n,
    new String("boxed"),
  ];

  for (const value of badValues) {
    compare(flavor, "normalize", [value]);
    compare(flavor, "isAbsolute", [value]);
    compare(flavor, "dirname", [value]);
    compare(flavor, "extname", [value]);
    compare(flavor, "parse", [value]);
    compare(flavor, "toNamespacedPath", [value]);
    compare(flavor, "basename", [value]);
    compare(flavor, "basename", ["a", value]);
    compare(flavor, "join", [value]);
    compare(flavor, "join", ["a", value]);
    compare(flavor, "resolve", [value]);
    compare(flavor, "relative", [value, "a"]);
    compare(flavor, "relative", ["a", value]);
    compare(flavor, "format", [value]);
  }
}

// ---------------------------------------------------------------------------
// Surface parity
// ---------------------------------------------------------------------------

const platformFlavor = process.platform === "win32" ? "win32" : "posix";

for (const flavor of FLAVORS) {
  for (const method of METHODS) {
    assert.strictEqual(
      typeof ours[flavor][method],
      "function",
      "path." + flavor + "." + method + " must be a function",
    );
  }
  assert.strictEqual(ours[flavor].sep, nodePath[flavor].sep, flavor + ".sep");
  assert.strictEqual(ours[flavor].delimiter, nodePath[flavor].delimiter, flavor + ".delimiter");
  assert.strictEqual(ours[flavor].posix, ours.posix, flavor + ".posix wiring");
  assert.strictEqual(ours[flavor].win32, ours.win32, flavor + ".win32 wiring");
}

assert.strictEqual(ours, ours[platformFlavor], "default export must be the platform flavor");
assert.strictEqual(ours.sep, nodePath.sep, "default export sep");
assert.strictEqual(ours.delimiter, nodePath.delimiter, "default export delimiter");

const notCovered = METHODS.filter((method) => !covered.has(method));
assert.deepStrictEqual(notCovered, [], "every path method must be compared");

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (mismatchCount > 0) {
  for (const mismatch of firstMismatches) {
    console.error(
      "MISMATCH path." +
        mismatch.flavor +
        "." +
        mismatch.method +
        "(" +
        mismatch.args.map(repr).join(", ") +
        ")",
    );
    console.error("  ours: " + mismatch.actual);
    console.error("  node: " + mismatch.expected);
  }
  if (mismatchCount > firstMismatches.length) {
    console.error(
      "... and " + (mismatchCount - firstMismatches.length) + " more mismatch(es)",
    );
  }
}

assert.strictEqual(
  mismatchCount,
  0,
  "path oracle: " + mismatchCount + " mismatch(es) out of " + comparisons + " comparisons",
);

console.log(
  "# path.oracle: " + comparisons + " comparisons, 0 mismatches across " + METHODS.length + " methods",
);
