"use strict";

// Self-checking, runtime-agnostic tests for js/lib/path.js.
//
// Must pass unchanged under `node` and under `lite`:
//   node test/js/lib/path.test.js
//
// Only the module under test is required; no `node:` builtins are used.

const path = require("../../../js/lib/path.js");

let passed = 0;
let failed = 0;

function show(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return String(value) + "n";
  if (typeof value === "symbol") return String(value);
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function ok(label, actual, expected) {
  if (actual === expected) {
    passed++;
    console.log("ok " + label);
    return;
  }
  failed++;
  console.error("FAIL " + label);
  console.error("  expected: " + show(expected));
  console.error("  actual:   " + show(actual));
}

function okJson(label, actual, expected) {
  ok(label, JSON.stringify(actual), JSON.stringify(expected));
}

function throwsTypeError(label, fn, code) {
  try {
    const value = fn();
    failed++;
    console.error("FAIL " + label);
    console.error("  expected: TypeError with code " + show(code));
    console.error("  actual:   returned " + show(value));
  } catch (err) {
    if (err instanceof TypeError && err.code === code) {
      passed++;
      console.log("ok " + label);
    } else {
      failed++;
      console.error("FAIL " + label);
      console.error("  expected: TypeError with code " + show(code));
      console.error("  actual:   " + (err && err.name) + " with code " + show(err && err.code));
    }
  }
}

function table(label, cases, fn) {
  for (const entry of cases) {
    const args = entry[0];
    ok(label + "(" + args.map(show).join(", ") + ")", fn(...args), entry[1]);
  }
}

function objectTable(label, cases, fn) {
  for (const entry of cases) {
    const args = entry[0];
    okJson(label + "(" + args.map(show).join(", ") + ")", fn(...args), entry[1]);
  }
}

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

const methods = [
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

for (const flavor of ["posix", "win32"]) {
  for (const method of methods) {
    ok(
      "surface: path." + flavor + "." + method + " is a function",
      typeof path[flavor][method],
      "function",
    );
  }
}

ok("surface: path.posix.sep", path.posix.sep, "/");
ok("surface: path.posix.delimiter", path.posix.delimiter, ":");
ok("surface: path.win32.sep", path.win32.sep, "\\");
ok("surface: path.win32.delimiter", path.win32.delimiter, ";");
ok("surface: path.posix.posix is path.posix", path.posix.posix, path.posix);
ok("surface: path.posix.win32 is path.win32", path.posix.win32, path.win32);
ok("surface: path.win32.posix is path.posix", path.win32.posix, path.posix);
ok("surface: path.win32.win32 is path.win32", path.win32.win32, path.win32);

if (process.platform === "win32") {
  ok("surface: default export is win32 on win32", path, path.win32);
  ok("surface: default sep on win32", path.sep, "\\");
  ok("surface: default delimiter on win32", path.delimiter, ";");
} else {
  ok("surface: default export is posix on posix", path, path.posix);
  ok("surface: default sep on posix", path.sep, "/");
  ok("surface: default delimiter on posix", path.delimiter, ":");
}

// ---------------------------------------------------------------------------
// posix
// ---------------------------------------------------------------------------

table(
  "posix.join",
  [
    [[], "."],
    [[""], "."],
    [["", ""], "."],
    [["a"], "a"],
    [["a", "b"], "a/b"],
    [["a/", "b"], "a/b"],
    [["a", "/b"], "a/b"],
    [["/a", "/b"], "/a/b"],
    [["/a/", "/b/"], "/a/b/"],
    [["a", ".."], "."],
    [["a", "..", ".."], ".."],
    [["/a", "..", ".."], "/"],
    [["/a", "../.."], "/"],
    [["a", ".", "b"], "a/b"],
    [["//server", "share"], "/server/share"],
    [["/foo", "", "bar", ""], "/foo/bar"],
    [[".gitignore"], ".gitignore"],
    [["base", "tar.gz"], "base/tar.gz"],
  ],
  (...args) => path.posix.join(...args),
);

table(
  "posix.normalize",
  [
    [[""], "."],
    [["."], "."],
    [[".."], ".."],
    [["..//"], "../"],
    [["../"], "../"],
    [["./"], "./"],
    [["a/../"], "./"],
    [["//"], "/"],
    [["///"], "/"],
    [["//foo"], "/foo"],
    [["foo//"], "foo/"],
    [["foo/"], "foo/"],
    [["a/../b"], "b"],
    [["a//b//"], "a/b/"],
    [["/../"], "/"],
    [["/.."], "/"],
    [["/a/b/../../.."], "/"],
    [["a/b/../../.."], ".."],
    [["/foo/./bar"], "/foo/bar"],
  ],
  (input) => path.posix.normalize(input),
);

table(
  "posix.isAbsolute",
  [
    [[""], false],
    [["."], false],
    [["a"], false],
    [["a/b"], false],
    [["/"], true],
    [["//"], true],
    [["/a"], true],
    [["\\a"], false],
  ],
  (input) => path.posix.isAbsolute(input),
);

table(
  "posix.dirname",
  [
    [[""], "."],
    [["."], "."],
    [[".."], "."],
    [["foo"], "."],
    [["foo/bar"], "foo"],
    [["foo/bar/"], "foo"],
    [["/"], "/"],
    [["/foo"], "/"],
    [["/foo/"], "/"],
    [["/foo/bar"], "/foo"],
    [["/foo/bar/"], "/foo"],
    [["/foo//bar"], "/foo/"],
    [["//foo"], "//"],
    [["///foo"], "//"],
    [["/a/./b"], "/a/."],
  ],
  (input) => path.posix.dirname(input),
);

table(
  "posix.basename",
  [
    [[""], ""],
    [["/"], ""],
    [["//"], ""],
    [["."], "."],
    [[".."], ".."],
    [["foo"], "foo"],
    [["/foo"], "foo"],
    [["/foo/"], "foo"],
    [["/foo/bar"], "bar"],
    [["/foo/bar/"], "bar"],
    [["foo/bar"], "bar"],
    [[".gitignore"], ".gitignore"],
    [["/foo/.gitignore"], ".gitignore"],
    [["base.tar.gz"], "base.tar.gz"],
    [["base.tar.gz", ".gz"], "base.tar"],
    [["base.tar.gz", ".tar.gz"], "base"],
    [["foo.txt", ".txt"], "foo"],
    [["foo.txt", "txt"], "foo."],
    [["/", "/"], ""],
    [["foo.txt", ""], "foo.txt"],
    [["foo.txt", "bar"], "foo.txt"],
  ],
  (input, suffix) => path.posix.basename(input, suffix),
);

table(
  "posix.extname",
  [
    [[""], ""],
    [["."], ""],
    [[".."], ""],
    [["..."], "."],
    [["foo"], ""],
    [["foo."], "."],
    [["foo.."], "."],
    [[".gitignore"], ""],
    [[".foo.bar"], ".bar"],
    [["foo.txt"], ".txt"],
    [["foo.tar.gz"], ".gz"],
    [["a.b.c"], ".c"],
    [["..a"], ".a"],
    [["/foo/bar.txt"], ".txt"],
    [["/foo/.gitignore"], ""],
    [["/foo/bar."], "."],
    [["/foo/bar/baz"], ""],
  ],
  (input) => path.posix.extname(input),
);

objectTable(
  "posix.parse",
  [
    [
      [""],
      { root: "", dir: "", base: "", ext: "", name: "" },
    ],
    [
      ["."],
      { root: "", dir: "", base: ".", ext: "", name: "." },
    ],
    [
      ["/"],
      { root: "/", dir: "/", base: "", ext: "", name: "" },
    ],
    [
      ["/foo"],
      { root: "/", dir: "/", base: "foo", ext: "", name: "foo" },
    ],
    [
      ["/foo/bar.txt"],
      { root: "/", dir: "/foo", base: "bar.txt", ext: ".txt", name: "bar" },
    ],
    [
      ["/foo/bar.tar.gz"],
      { root: "/", dir: "/foo", base: "bar.tar.gz", ext: ".gz", name: "bar.tar" },
    ],
    [
      ["/foo/.gitignore"],
      { root: "/", dir: "/foo", base: ".gitignore", ext: "", name: ".gitignore" },
    ],
    [
      ["/foo/bar/"],
      { root: "/", dir: "/foo", base: "bar", ext: "", name: "bar" },
    ],
    [
      ["/a/b/.."],
      { root: "/", dir: "/a/b", base: "..", ext: "", name: ".." },
    ],
    [
      ["/.."],
      { root: "/", dir: "/", base: "..", ext: ".", name: "." },
    ],
    [
      ["//server/share"],
      { root: "/", dir: "//server", base: "share", ext: "", name: "share" },
    ],
    [
      ["foo"],
      { root: "", dir: "", base: "foo", ext: "", name: "foo" },
    ],
  ],
  (input) => path.posix.parse(input),
);

// Compare parse objects as JSON, one assertion each.

table(
  "posix.format",
  [
    [[{ dir: "/foo", base: "bar.txt" }], "/foo/bar.txt"],
    [[{ root: "/", base: "bar" }], "/bar"],
    [[{ dir: "/x", root: "/", base: "a" }], "/x/a"],
    [[{ name: "a", ext: "b" }], "a.b"],
    [[{ name: "a", ext: ".b" }], "a.b"],
    [[{ name: "a", ext: "" }], "a"],
    [[{ base: "a", name: "b", ext: ".c" }], "a"],
    [[{}], ""],
    [[{ dir: "", root: "", base: "" }], ""],
    [[{ name: "a" }], "a"],
    [[{ ext: ".x" }], ".x"],
    [[{ root: "/", name: "a", ext: ".b" }], "/a.b"],
  ],
  (object) => path.posix.format(object),
);

table(
  "posix.relative",
  [
    [["/a/b", "/a/b"], ""],
    [["/a/b/", "/a/c"], "../c"],
    [["/a/b", "/a/b/c"], "c"],
    [["/a/b/c", "/a/b"], ".."],
    [["/a", "/"], ".."],
    [["/", "/a"], "a"],
    [["/", "/"], ""],
    [["/a/b", "/a/b/../c"], "../c"],
    [["a", "a/b"], "b"],
    [["/foo/bar/baz", "/foo/bar"], ".."],
    [["/foo/bar", "/foo/bar/baz"], "baz"],
    [["/a/b", "/a/c"], "../c"],
  ],
  (from, to) => path.posix.relative(from, to),
);

table(
  "posix.resolve",
  [
    [["/a", "b"], "/a/b"],
    [["/a", "b", "c"], "/a/b/c"],
    [["a", "/b"], "/b"],
    [["/a", "/b"], "/b"],
    [["/a/b/../c"], "/a/c"],
    [["/a", ""], "/a"],
    [["/a", "."], "/a"],
    [["/a", ".."], "/"],
    [["//server", "share"], "/server/share"],
  ],
  (...args) => path.posix.resolve(...args),
);

if (process.platform !== "win32") {
  ok("posix.resolve() is process.cwd()", path.posix.resolve(), process.cwd());
  ok("posix.resolve('') is process.cwd()", path.posix.resolve(""), process.cwd());
  ok("posix.resolve('.') is process.cwd()", path.posix.resolve("."), process.cwd());
  ok(
    "posix.resolve('relative') is cwd/relative",
    path.posix.resolve("relative"),
    process.cwd() + "/relative",
  );
}

table(
  "posix.toNamespacedPath",
  [
    [["/foo/bar"], "/foo/bar"],
    [["foo"], "foo"],
    [[""], ""],
    [["C:\\foo"], "C:\\foo"],
  ],
  (input) => path.posix.toNamespacedPath(input),
);

// ---------------------------------------------------------------------------
// win32
// ---------------------------------------------------------------------------

table(
  "win32.join",
  [
    [[], "."],
    [[""], "."],
    [["", ""], "."],
    [["a"], "a"],
    [["a", "b"], "a\\b"],
    [["a/", "b"], "a\\b"],
    [["a", "/b"], "a\\b"],
    [["a", "b/"], "a\\b\\"],
    [["/a", "/b"], "\\a\\b"],
    [["C:", "foo"], "C:\\foo"],
    [["C:\\", "foo"], "C:\\foo"],
    [["C:\\foo", "..", "bar"], "C:\\bar"],
    [["C:\\foo\\bar", "baz"], "C:\\foo\\bar\\baz"],
    [["a", ".."], "."],
    [["a", "..", ".."], ".."],
    [["//server", "share"], "\\\\server\\share\\"],
    [["\\\\server\\share", "x"], "\\\\server\\share\\x"],
    [["C:", ".."], "C:\\"],
    [["foo", "", "bar"], "foo\\bar"],
    [["C:", "foo/bar"], "C:\\foo\\bar"],
  ],
  (...args) => path.win32.join(...args),
);

table(
  "win32.normalize",
  [
    [[""], "."],
    [["."], "."],
    [[".."], ".."],
    [["/"], "\\"],
    [["\\"], "\\"],
    [["//"], "\\"],
    [["\\\\"], "\\"],
    [["///"], "\\"],
    [["a"], "a"],
    [["C:"], "C:."],
    [["C:\\"], "C:\\"],
    [["C:/"], "C:\\"],
    [["C:\\foo"], "C:\\foo"],
    [["C:/foo"], "C:\\foo"],
    [["C:foo"], "C:foo"],
    [["C:foo\\.."], "C:."],
    [["C:\\foo\\.."], "C:\\"],
    [["C:\\foo\\bar"], "C:\\foo\\bar"],
    [["C:\\foo\\bar\\"], "C:\\foo\\bar\\"],
    [["C:/foo/../bar"], "C:\\bar"],
    [["c:\\foo\\BAR.TXT"], "c:\\foo\\BAR.TXT"],
    [["a\\..\\b"], "b"],
    [["a/../../b"], "..\\b"],
    [["..\\..\\a"], "..\\..\\a"],
    [["\\\\server\\share"], "\\\\server\\share\\"],
    [["\\\\server\\share\\"], "\\\\server\\share\\"],
    [["\\\\server\\share\\x"], "\\\\server\\share\\x"],
    [["\\\\server\\share\\x\\.."], "\\\\server\\share\\"],
    [["\\\\?\\C:\\foo"], "\\\\?\\C:\\foo"],
    [["\\\\?\\UNC\\server\\share\\x"], "\\\\?\\UNC\\server\\share\\x"],
    [["foo:bar"], "foo:bar"],
    [["COM1:foo"], ".\\COM1:foo"],
    [["COM1"], "COM1"],
    [["C:\\COM1"], "C:\\COM1"],
  ],
  (input) => path.win32.normalize(input),
);

table(
  "win32.isAbsolute",
  [
    [[""], false],
    [["."], false],
    [["a"], false],
    [["C:"], false],
    [["C:foo"], false],
    [["C:\\foo"], true],
    [["C:/foo"], true],
    [["C:\\\\foo"], true],
    [["\\foo"], true],
    [["/foo"], true],
    [["\\\\server\\share"], true],
    [["\\\\server\\share\\x"], true],
  ],
  (input) => path.win32.isAbsolute(input),
);

table(
  "win32.dirname",
  [
    [[""], "."],
    [["."], "."],
    [["foo"], "."],
    [["foo\\bar"], "foo"],
    [["foo\\bar\\"], "foo"],
    [["foo/bar"], "foo"],
    [["/"], "/"],
    [["\\"], "\\"],
    [["//"], "/"],
    [["\\\\"], "\\"],
    [["C:"], "C:"],
    [["C:foo"], "C:"],
    [["C:\\"], "C:\\"],
    [["C:\\foo"], "C:\\"],
    [["C:\\foo\\"], "C:\\"],
    [["C:\\foo\\bar"], "C:\\foo"],
    [["C:\\foo\\bar\\"], "C:\\foo"],
    [["C:/foo/bar"], "C:/foo"],
    [["\\\\server\\share"], "\\\\server\\share"],
    [["\\\\server\\share\\"], "\\\\server\\share\\"],
    [["\\\\server\\share\\file"], "\\\\server\\share\\"],
  ],
  (input) => path.win32.dirname(input),
);

table(
  "win32.basename",
  [
    [[""], ""],
    [["C:"], ""],
    [["C:\\"], ""],
    [["\\"], ""],
    [["foo"], "foo"],
    [["C:\\foo"], "foo"],
    [["C:\\foo\\"], "foo"],
    [["C:\\foo\\bar.txt"], "bar.txt"],
    [["C:foo.txt"], "foo.txt"],
    [["C:/foo/bar.txt"], "bar.txt"],
    [["\\\\server\\share\\file.txt"], "file.txt"],
    [["foo/bar"], "bar"],
    [["C:\\foo\\.gitignore"], ".gitignore"],
    [["C:\\foo\\bar.txt", ".txt"], "bar"],
    [["C:\\foo\\bar.txt", "txt"], "bar."],
    [["C:\\foo\\bar.tar.gz", ".tar.gz"], "bar"],
    [["C:\\foo\\bar.txt", ""], "bar.txt"],
  ],
  (input, suffix) => path.win32.basename(input, suffix),
);

table(
  "win32.extname",
  [
    [[""], ""],
    [["C:"], ""],
    [["C:foo"], ""],
    [["C:\\"], ""],
    [[".gitignore"], ""],
    [[".."], ""],
    [["..."], "."],
    [["foo."], "."],
    [["foo.."], "."],
    [["foo.txt"], ".txt"],
    [["a.b.c"], ".c"],
    [["C:\\foo\\bar.txt"], ".txt"],
    [["C:\\foo\\bar.tar.gz"], ".gz"],
    [["C:foo.txt"], ".txt"],
    [["C:/foo/bar.txt"], ".txt"],
    [["\\\\server\\share\\a.b"], ".b"],
    [["/foo/bar.baz"], ".baz"],
  ],
  (input) => path.win32.extname(input),
);

const win32ParseCases = [
  [
    "",
    { root: "", dir: "", base: "", ext: "", name: "" },
  ],
  [
    "C:",
    { root: "C:", dir: "C:", base: "", ext: "", name: "" },
  ],
  [
    "C:\\",
    { root: "C:\\", dir: "C:\\", base: "", ext: "", name: "" },
  ],
  [
    "C:\\foo\\bar.txt",
    { root: "C:\\", dir: "C:\\foo", base: "bar.txt", ext: ".txt", name: "bar" },
  ],
  [
    "C:foo.txt",
    { root: "C:", dir: "C:", base: "foo.txt", ext: ".txt", name: "foo" },
  ],
  [
    "C:\\foo\\",
    { root: "C:\\", dir: "C:\\", base: "foo", ext: "", name: "foo" },
  ],
  [
    "C:\\foo\\.gitignore",
    { root: "C:\\", dir: "C:\\foo", base: ".gitignore", ext: "", name: ".gitignore" },
  ],
  [
    "\\\\server\\share",
    { root: "\\\\server\\share", dir: "\\\\server\\share", base: "", ext: "", name: "" },
  ],
  [
    "\\\\server\\share\\x",
    { root: "\\\\server\\share\\", dir: "\\\\server\\share\\", base: "x", ext: "", name: "x" },
  ],
  [
    "\\\\server\\share\\file.txt",
    {
      root: "\\\\server\\share\\",
      dir: "\\\\server\\share\\",
      base: "file.txt",
      ext: ".txt",
      name: "file",
    },
  ],
  [
    "/foo/bar/",
    { root: "/", dir: "/foo", base: "bar", ext: "", name: "bar" },
  ],
  [
    "foo",
    { root: "", dir: "", base: "foo", ext: "", name: "foo" },
  ],
];

// `table` compares strings, so parse uses okJson directly.
for (const [input, expected] of win32ParseCases) {
  okJson(
    "win32.parse(" + show(input) + ")",
    path.win32.parse(input),
    expected,
  );
}

table(
  "win32.format",
  [
    [[{ dir: "C:\\foo", base: "bar.txt" }], "C:\\foo\\bar.txt"],
    [[{ root: "C:\\", base: "bar" }], "C:\\bar"],
    [[{ dir: "C:\\foo", root: "C:\\", base: "bar" }], "C:\\foo\\bar"],
    [[{ name: "a", ext: "b" }], "a.b"],
    [[{ name: "a", ext: ".b" }], "a.b"],
    [[{ name: "a", ext: "" }], "a"],
    [[{ base: "a", name: "b", ext: ".c" }], "a"],
    [[{}], ""],
    [[{ root: "\\\\server\\share\\", base: "x" }], "\\\\server\\share\\x"],
  ],
  (object) => path.win32.format(object),
);

table(
  "win32.relative",
  [
    [["C:\\foo", "C:\\foo"], ""],
    [["C:\\foo", "C:\\bar"], "..\\bar"],
    [["C:\\foo\\bar", "C:\\foo\\baz"], "..\\baz"],
    [["C:\\foo", "C:\\foo\\bar"], "bar"],
    [["C:\\foo\\bar", "C:\\foo"], ".."],
    [["C:\\", "C:\\foo"], "foo"],
    [["C:\\foo", "C:\\"], ".."],
    [["C:\\foo", "D:\\bar"], "D:\\bar"],
    [["c:\\Foo", "C:\\foo\\bar"], "bar"],
    [["C:\\foo", "c:\\FOO\\bar"], "bar"],
    [["C:\\a\\b\\c", "C:\\a\\x"], "..\\..\\x"],
    [["\\\\server\\share\\a", "\\\\server\\share\\b"], "..\\b"],
  ],
  (from, to) => path.win32.relative(from, to),
);

table(
  "win32.resolve",
  [
    [["C:\\foo"], "C:\\foo"],
    [["C:/foo"], "C:\\foo"],
    [["C:\\foo", "..", "bar"], "C:\\bar"],
    [["C:\\foo", "D:\\bar"], "D:\\bar"],
    [["/foo", "bar"], "\\foo\\bar"],
    [["\\\\server\\share\\x"], "\\\\server\\share\\x"],
    [["\\\\server\\share", "x"], "\\\\server\\share\\x"],
  ],
  (...args) => path.win32.resolve(...args),
);

table(
  "win32.toNamespacedPath",
  [
    [[""], ""],
    [["C:\\"], "\\\\?\\C:\\"],
    [["C:\\foo"], "\\\\?\\C:\\foo"],
    [["C:/foo"], "\\\\?\\C:\\foo"],
    [["C:/foo/../bar"], "\\\\?\\C:\\bar"],
    [["\\\\server\\share"], "\\\\?\\UNC\\server\\share\\"],
    [["\\\\server\\share\\x"], "\\\\?\\UNC\\server\\share\\x"],
    [["\\\\?\\C:\\foo"], "\\\\?\\C:\\foo"],
  ],
  (input) => path.win32.toNamespacedPath(input),
);

// toNamespacedPath intentionally does not validate (Node parity).
ok("win32.toNamespacedPath(non-string) passes through", path.win32.toNamespacedPath(42), 42);
ok("posix.toNamespacedPath(non-string) passes through", path.posix.toNamespacedPath(42), 42);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const ERR = "ERR_INVALID_ARG_TYPE";

throwsTypeError("posix.join('a', 1) throws", () => path.posix.join("a", 1), ERR);
throwsTypeError("posix.normalize(null) throws", () => path.posix.normalize(null), ERR);
throwsTypeError("posix.isAbsolute(undefined) throws", () => path.posix.isAbsolute(undefined), ERR);
throwsTypeError("posix.resolve('a', 1) throws", () => path.posix.resolve("a", 1), ERR);
throwsTypeError("posix.relative(1, 'a') throws", () => path.posix.relative(1, "a"), ERR);
throwsTypeError("posix.basename('a', 1) throws", () => path.posix.basename("a", 1), ERR);
throwsTypeError("posix.basename(1) throws", () => path.posix.basename(1), ERR);
throwsTypeError("posix.dirname(false) throws", () => path.posix.dirname(false), ERR);
throwsTypeError("posix.extname({}) throws", () => path.posix.extname({}), ERR);
throwsTypeError("posix.parse(1) throws", () => path.posix.parse(1), ERR);
throwsTypeError("posix.format(null) throws", () => path.posix.format(null), ERR);
throwsTypeError("posix.format(undefined) throws", () => path.posix.format(undefined), ERR);
throwsTypeError("posix.format([]) throws", () => path.posix.format([]), ERR);
throwsTypeError("posix.format(1) throws", () => path.posix.format(1), ERR);

throwsTypeError("win32.join('a', 1) throws", () => path.win32.join("a", 1), ERR);
throwsTypeError("win32.normalize(null) throws", () => path.win32.normalize(null), ERR);
throwsTypeError("win32.isAbsolute(undefined) throws", () => path.win32.isAbsolute(undefined), ERR);
throwsTypeError("win32.resolve(1) throws", () => path.win32.resolve(1), ERR);
throwsTypeError("win32.relative(1, 'a') throws", () => path.win32.relative(1, "a"), ERR);
throwsTypeError("win32.basename('a', 1) throws", () => path.win32.basename("a", 1), ERR);
throwsTypeError("win32.dirname(1) throws", () => path.win32.dirname(1), ERR);
throwsTypeError("win32.extname(1) throws", () => path.win32.extname(1), ERR);
throwsTypeError("win32.parse(1) throws", () => path.win32.parse(1), ERR);
throwsTypeError("win32.format(undefined) throws", () => path.win32.format(undefined), ERR);
throwsTypeError("win32.format([]) throws", () => path.win32.format([]), ERR);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

if (failed > 0) {
  console.error("");
  console.error("# path: " + passed + " passed, " + failed + " failed");
  process.exit(1);
}

console.log("");
console.log("# path: " + passed + " passed, 0 failed");
