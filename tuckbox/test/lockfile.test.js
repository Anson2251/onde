"use strict";

// Unit tests for `dist/lib/lockfile.js`. Plain CommonJS, no framework: the same file runs under
// `node` and under `lite`, and prints a single `ok lockfile <N> assertions` line on success.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const lockfile = require("../dist/lib/lockfile.js");

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
  ok(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function deepEq(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, `${message} (expected ${b}, got ${a})`);
}

/** Object-key-order-insensitive comparison, for parsed values: only serialization fixes order. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = canonical(value[key]);
    return sorted;
  }
  return value;
}

function deepEqOrderless(actual, expected, message) {
  deepEq(canonical(actual), canonical(expected), message);
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

function makeLock(overrides) {
  const lock = {
    lockfileVersion: 1,
    name: "fixture-app",
    version: "1.0.0",
    packages: {
      "node_modules/alpha": lockfile.makeEntry({
        name: "alpha",
        version: "1.0.0",
        resolved: "https://registry.example/alpha/-/alpha-1.0.0.tgz",
        integrity: "sha512-alpha",
        dependencies: { zeta: "^1.0.0", beta: "^2.0.0" },
      }),
      "node_modules/zeta": lockfile.makeEntry({
        name: "zeta",
        version: "3.0.0",
        resolved: "https://registry.example/zeta/-/zeta-3.0.0.tgz",
        integrity: "sha512-zeta",
        dev: true,
      }),
    },
  };
  return Object.assign(lock, overrides);
}

function entryFor(name, version, extra) {
  return lockfile.makeEntry(
    Object.assign(
      {
        name,
        version,
        resolved: `https://registry.example/${name}/-/${name}-${version}.tgz`,
        integrity: `sha512-${name}-${version}`,
      },
      extra,
    ),
  );
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tuckbox-lockfile-"));

try {
  // --- 1. path -------------------------------------------------------------------------------

  eq(lockfile.lockfilePath("/tmp/project"), path.join("/tmp/project", "tuckbox.lock.json"), "lockfilePath");

  // --- 2. makeEntry --------------------------------------------------------------------------

  const bare = lockfile.makeEntry({
    name: "bare",
    version: "1.0.0",
    resolved: "https://registry.example/bare/-/bare-1.0.0.tgz",
    integrity: "sha512-bare",
  });
  deepEq(bare.dependencies, {}, "makeEntry defaults dependencies to {}");
  ok(!("dev" in bare), "makeEntry omits dev when it is not passed");
  ok(!("dev" in entryFor("x", "1.0.0", { dev: false })), "makeEntry omits dev when false");
  ok(entryFor("x", "1.0.0", { dev: true }).dev === true, "makeEntry keeps dev when true");

  const supplied = { a: "^1.0.0" };
  const withDeps = entryFor("deps", "1.0.0", { dependencies: supplied });
  supplied.a = "^9.9.9";
  eq(withDeps.dependencies.a, "^1.0.0", "makeEntry copies dependencies instead of aliasing the caller's object");

  // --- 3. deterministic serialization --------------------------------------------------------

  const forward = makeLock();
  const reverse = makeLock({
    packages: {
      "node_modules/zeta": entryFor("zeta", "3.0.0", { integrity: "sha512-zeta", dev: true }),
      "node_modules/alpha": entryFor("alpha", "1.0.0", {
        integrity: "sha512-alpha",
        dependencies: { beta: "^2.0.0", zeta: "^1.0.0" },
      }),
    },
  });

  const text = lockfile.serialize(forward);
  ok(text.endsWith("\n"), "serialize ends with a newline");
  ok(text.includes('\n  "packages"'), "serialize uses two-space indentation");
  eq(text, lockfile.serialize(reverse), "serialize is byte-identical across two insertion orders");

  const parsed = JSON.parse(text);
  deepEq(Object.keys(parsed), ["lockfileVersion", "name", "version", "packages"], "top-level key order");
  deepEq(
    Object.keys(parsed.packages),
    ["node_modules/alpha", "node_modules/zeta"],
    "package keys are sorted by install path",
  );
  deepEq(
    Object.keys(parsed.packages["node_modules/alpha"]),
    ["name", "version", "resolved", "integrity", "dependencies"],
    "entry key order without dev",
  );
  deepEq(
    Object.keys(parsed.packages["node_modules/zeta"]),
    ["name", "version", "resolved", "integrity", "dependencies", "dev"],
    "entry key order with dev",
  );
  deepEq(
    Object.keys(parsed.packages["node_modules/alpha"].dependencies),
    ["beta", "zeta"],
    "dependency keys are sorted",
  );

  // A nested install path sorts after its parent, not next to its bare name.
  const nested = makeLock({
    packages: {
      "node_modules/zeta": entryFor("zeta", "3.0.0"),
      "node_modules/alpha/node_modules/beta": entryFor("beta", "2.0.0"),
      "node_modules/alpha": entryFor("alpha", "1.0.0"),
      "node_modules/@scope/thing": entryFor("@scope/thing", "1.0.0"),
    },
  });
  deepEq(
    Object.keys(JSON.parse(lockfile.serialize(nested)).packages),
    [
      "node_modules/@scope/thing",
      "node_modules/alpha",
      "node_modules/alpha/node_modules/beta",
      "node_modules/zeta",
    ],
    "scoped and nested install paths sort by full path",
  );

  // Omitting name/version is legal and still ordered correctly.
  const unnamed = lockfile.serialize({ lockfileVersion: 1, packages: {} });
  deepEq(Object.keys(JSON.parse(unnamed)), ["lockfileVersion", "packages"], "optional name/version are omitted");
  eq(unnamed, '{\n  "lockfileVersion": 1,\n  "packages": {}\n}\n', "empty lockfile serialization");

  // --- 4. write / read round trip ------------------------------------------------------------

  const project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });
  lockfile.write(project, forward);

  const written = fs.readFileSync(lockfile.lockfilePath(project), "utf8");
  eq(written, lockfile.serialize(forward), "write stores serialize()'s exact bytes");

  const loaded = lockfile.read(project);
  ok(loaded !== null, "read returns the written lockfile");
  deepEqOrderless(loaded, forward, "read round-trips the lockfile");
  eq(lockfile.serialize(loaded), written, "re-serializing a read lockfile is byte-identical");

  const leftovers = fs
    .readdirSync(project)
    .filter((name) => name !== "tuckbox.lock.json" && name.indexOf("tuckbox.lock.json.tmp") === 0);
  deepEq(leftovers, [], "atomic write leaves no .tmp file behind");

  // Overwriting is still atomic and leaves one file.
  lockfile.write(project, nested);
  deepEq(fs.readdirSync(project), ["tuckbox.lock.json"], "a second write leaves exactly one file");

  // --- 5. absent and malformed files ---------------------------------------------------------

  const empty = path.join(root, "empty");
  fs.mkdirSync(empty, { recursive: true });
  eq(lockfile.read(empty), null, "read returns null when the lockfile is absent");

  const badFile = path.join(root, "bad");
  fs.mkdirSync(badFile, { recursive: true });
  fs.writeFileSync(lockfile.lockfilePath(badFile), "{ not json", "utf8");
  throwsCode(
    () => lockfile.read(badFile),
    "ELOCKFILE",
    "read maps malformed JSON to ELOCKFILE",
    lockfile.lockfilePath(badFile),
  );

  // --- 6. validation -------------------------------------------------------------------------

  const SOURCE = "fixture.lock.json";
  const parse = (value) => lockfile.parse(JSON.stringify(value), SOURCE);
  const valid = () => makeLock();

  deepEq(parse(valid()).packages["node_modules/alpha"].dependencies, { zeta: "^1.0.0", beta: "^2.0.0" }, "parse accepts a valid lockfile");
  eq(parse(valid()).lockfileVersion, 1, "parse preserves lockfileVersion");

  const scopedValid = valid();
  scopedValid.packages["node_modules/@scope/thing"] = entryFor("@scope/thing", "1.0.0");
  scopedValid.packages["node_modules/alpha/node_modules/@scope/thing"] = entryFor("@scope/thing", "1.0.0");
  const scopedParsed = parse(scopedValid);
  eq(Object.keys(scopedParsed.packages).length, 4, "parse accepts scoped names, root and nested");

  throwsCode(
    () => parse(Object.assign(valid(), { lockfileVersion: 2 })),
    "ELOCKFILE",
    "lockfileVersion 2 is rejected",
    SOURCE,
  );
  throwsCode(
    () => parse(Object.assign(valid(), { lockfileVersion: undefined })),
    "ELOCKFILE",
    "a missing lockfileVersion is rejected",
    SOURCE,
  );
  throwsCode(
    () => parse(Object.assign(valid(), { packages: [] })),
    "ELOCKFILE",
    "an array packages field is rejected",
    SOURCE,
  );
  throwsCode(
    () => parse(Object.assign(valid(), { packages: null })),
    "ELOCKFILE",
    "a null packages field is rejected",
    SOURCE,
  );

  for (const field of ["name", "version", "resolved", "integrity"]) {
    const bad = valid();
    delete bad.packages["node_modules/alpha"][field];
    throwsCode(
      () => parse(bad),
      "ELOCKFILE",
      `a missing entry ${field} is rejected`,
      "node_modules/alpha",
    );
  }

  throwsCode(
    () => {
      const bad = valid();
      bad.packages["node_modules/alpha"].version = 1;
      parse(bad);
    },
    "ELOCKFILE",
    "a non-string entry version is rejected",
    "node_modules/alpha",
  );
  throwsCode(
    () => {
      const bad = valid();
      delete bad.packages["node_modules/alpha"].dependencies;
      parse(bad);
    },
    "ELOCKFILE",
    "missing entry dependencies is rejected",
    "node_modules/alpha",
  );
  throwsCode(
    () => {
      const bad = valid();
      bad.packages["node_modules/alpha"].dependencies = [];
      parse(bad);
    },
    "ELOCKFILE",
    "an array dependencies field is rejected",
    "node_modules/alpha",
  );
  throwsCode(
    () => {
      const bad = valid();
      bad.packages["node_modules/alpha"].dev = "yes";
      parse(bad);
    },
    "ELOCKFILE",
    "a non-boolean dev flag is rejected",
    "node_modules/alpha",
  );

  for (const key of ["alpha", "node_modules/", "node_modules/../escape", "node_modules/alpha/extra"]) {
    throwsCode(
      () => {
        const bad = valid();
        bad.packages[key] = entryFor("alpha", "1.0.0");
        parse(bad);
      },
      "ELOCKFILE",
      `invalid install path ${JSON.stringify(key)} is rejected`,
      key,
    );
  }

  throwsCode(
    () => {
      const bad = valid();
      bad.packages["node_modules/alpha"] = null;
      parse(bad);
    },
    "ELOCKFILE",
    "a null entry is rejected",
    "node_modules/alpha",
  );

  // A parsed lockfile can be serialized again byte-for-byte, which is what `ci` needs.
  eq(
    lockfile.serialize(parse(valid())),
    lockfile.serialize(forward),
    "parse(serialize(lock)) is stable",
  );
} catch (error) {
  failures.push(`unexpected exception: ${error && error.stack ? error.stack : String(error)}`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`not ok lockfile: ${failure}`);
  console.error(`not ok lockfile ${failures.length} failure(s), ${passed} assertion(s) passed`);
  process.exit(1);
}

console.log(`ok lockfile ${passed} assertions`);
