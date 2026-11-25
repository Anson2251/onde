"use strict";

// Adapted from test/conformance/stdlib/path01.js and path02.js.
//
// The conformance cases print `path` results for a byte comparison; this version asserts the same
// values. Only the explicit `path.posix` and `path.win32` flavours are used so the file does not
// depend on which platform runs it, and nothing touches the working directory, which keeps the
// assertions stable under both Node and `onde --test`.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

test.describe("posix", () => {
  test("join, normalize and resolve", () => {
    assert.strictEqual(path.posix.join("a", "b", "..", "c"), "a/c");
    assert.strictEqual(path.posix.normalize("/a//b/../c/"), "/a/c/");
    assert.strictEqual(path.posix.resolve("/a", "b", "../c"), "/a/c");
    assert.strictEqual(path.posix.relative("/a/b", "/a/c/d"), "../c/d");
    assert.strictEqual(path.posix.relative("/a/b/c", "/a/d"), "../../d");
    assert.strictEqual(path.posix.join("a", "/b"), "a/b");
  });

  test.describe("parse and format", () => {
    test("component names", () => {
      assert.strictEqual(path.posix.dirname("/a/b/c.txt"), "/a/b");
      assert.strictEqual(path.posix.basename("/a/b/c.txt"), "c.txt");
      assert.strictEqual(path.posix.extname("/a/b/c.txt"), ".txt");
      assert.strictEqual(path.posix.basename("/a/b/c/"), "c");
      assert.strictEqual(path.posix.extname(".gitignore"), "");
    });

    test("objects round-trip", () => {
      assert.deepStrictEqual(path.posix.parse("/a/b.tar.gz"), {
        root: "/",
        dir: "/a",
        base: "b.tar.gz",
        ext: ".gz",
        name: "b.tar",
      });
      assert.strictEqual(path.posix.format({ dir: "/a", name: "x", ext: ".js" }), "/a/x.js");
    });
  });
});

test.describe("win32", () => {
  test("separators and normalization", () => {
    assert.strictEqual(path.win32.join("a", "\\b"), "a\\b");
    assert.strictEqual(path.win32.normalize("C:\\temp\\\\foo\\..\\bar\\"), "C:\\temp\\bar\\");
    assert.strictEqual(path.win32.basename("C:\\temp\\file.txt"), "file.txt");
    assert.strictEqual(path.win32.dirname("C:\\temp\\file.txt"), "C:\\temp");
    assert.strictEqual(path.win32.extname("C:\\temp\\file.tar.gz"), ".gz");
  });

  test("absolute paths and drive roots", () => {
    assert.strictEqual(path.win32.isAbsolute("C:\\x"), true);
    assert.strictEqual(path.win32.isAbsolute("\\x"), true);
    assert.strictEqual(path.win32.isAbsolute("x"), false);
    assert.strictEqual(path.win32.parse("\\\\server\\share\\dir\\file.js").root, "\\\\server\\share\\");
  });
});
