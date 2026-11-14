"use strict";

// Generates the M2 smoke tree: 30 CommonJS packages and 10 ESM packages, each exercising a
// resolution or interop pattern the milestone claims. The tree is generated (not committed) so
// the repository stays small and every run starts from a clean cache.
//
//   node test/smoke/generate.js target/smoke
//
// The packages are intentionally tiny and dependency-free: the point is the loader, not the
// libraries.

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(process.argv[2] || "target/smoke");
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });

function write(relative, contents) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function packageJson(name, fields) {
  return JSON.stringify({ name, version: "1.0.0", ...fields }, null, 2) + "\n";
}

// 1-10: plain CJS packages with a legacy `main`.
const plain = [];
for (let index = 1; index <= 10; index += 1) {
  const name = `plain${index}`;
  plain.push(name);
  write(`node_modules/${name}/package.json`, packageJson(name, { main: "lib/main.js" }));
  write(
    `node_modules/${name}/lib/main.js`,
    `"use strict";\nexports.value = ${index};\nexports.kind = "plain";\n`,
  );
}

// 11-18: `exports` maps with require/import conditions and a subpath.
const conditional = [];
for (let index = 1; index <= 8; index += 1) {
  const name = `exp${index}`;
  conditional.push(name);
  write(
    `node_modules/${name}/package.json`,
    packageJson(name, {
      exports: {
        ".": { import: "./index.mjs", require: "./index.cjs", default: "./index.cjs" },
        "./feature": "./feature.js",
      },
    }),
  );
  write(
    `node_modules/${name}/index.cjs`,
    `"use strict";\nexports.value = ${index};\nexports.kind = "exp-require";\n`,
  );
  write(
    `node_modules/${name}/index.mjs`,
    `export const value = ${index};\nexport const kind = "exp-import";\n`,
  );
  write(
    `node_modules/${name}/feature.js`,
    `"use strict";\nexports.value = ${index * 10};\n`,
  );
}

// 19-22: packages that depend on another package (node_modules walk from inside node_modules).
const nested = [];
for (let index = 1; index <= 4; index += 1) {
  const name = `nested${index}`;
  nested.push(name);
  write(`node_modules/${name}/package.json`, packageJson(name, { main: "index.js" }));
  write(
    `node_modules/${name}/index.js`,
    `"use strict";\nconst base = require("plain${index}");\nexports.sum = base.value + ${index};\n`,
  );
}

// 23-25: JSON modules required from CJS.
const jsonPackages = [];
for (let index = 1; index <= 3; index += 1) {
  const name = `jsonpkg${index}`;
  jsonPackages.push(name);
  write(`node_modules/${name}/package.json`, packageJson(name, { main: "index.js" }));
  write(
    `node_modules/${name}/index.js`,
    `"use strict";\nconst data = require("./data.json");\nexports.count = data.numbers.length;\nexports.greeting = data.greeting;\n`,
  );
  write(
    `node_modules/${name}/data.json`,
    JSON.stringify({ greeting: `hello${index}`, numbers: [index, index, index] }),
  );
}

// 26-28: named-export patterns the ESM facade must discover.
const named = [];
for (let index = 1; index <= 3; index += 1) {
  const name = `named${index}`;
  named.push(name);
  write(`node_modules/${name}/package.json`, packageJson(name, { main: "index.js" }));
  write(
    `node_modules/${name}/index.js`,
    `"use strict";\nexports.alpha = ${index};\nexports.beta = ${index + 1};\nmodule.exports.gamma = ${index + 2};\n`,
  );
}

// 29-30: a require cycle.
const cycles = ["cycleA", "cycleB"];
write(`node_modules/cycleA/package.json`, packageJson("cycleA", { main: "index.js" }));
write(
  `node_modules/cycleA/index.js`,
  `"use strict";\nexports.a = 1;\nconst b = require("cycleB");\nexports.seen = b.sawA;\n`,
);
write(`node_modules/cycleB/package.json`, packageJson("cycleB", { main: "index.js" }));
write(
  `node_modules/cycleB/index.js`,
  `"use strict";\nconst a = require("cycleA");\nexports.sawA = a.a;\nexports.b = 2;\n`,
);

// ESM packages: native modules with exports maps, relative imports and CJS interop.
const esm = [];
for (let index = 1; index <= 10; index += 1) {
  const name = `esm${index}`;
  esm.push(name);
  write(
    `node_modules/${name}/package.json`,
    packageJson(name, { type: "module", exports: { ".": "./index.js" } }),
  );
  const extra =
    index === 2
      ? `import { value as first } from "esm1";\nexport const linked = first + 1;\n`
      : index === 5
        ? `import plain, { value as cjsValue } from "plain5";\nexport const bridged = plain.value + cjsValue;\n`
        : "";
  write(
    `node_modules/${name}/index.js`,
    `import { sep } from "node:path";\n${extra}export const value = ${index};\nexport const kind = "esm";\nexport const separator = sep;\nexport default "esm${index}";\n`,
  );
}

// Entry points. The CJS entry requires every package; the ESM entry imports every ESM package,
// plus one CJS package and the named-export facade.
write(
  "main.cjs",
  `"use strict";
const cjs = ${JSON.stringify([...plain, ...conditional, ...nested, ...jsonPackages, ...named, ...cycles])};
for (const name of cjs) {
  const loaded = require(name);
  const parts = [];
  for (const key of ["value", "kind", "sum", "count", "greeting", "alpha", "beta", "gamma", "seen"]) {
    if (loaded[key] !== undefined) parts.push(key + "=" + loaded[key]);
  }
  console.log(name, parts.join(" "));
}
const feature = require("exp3/feature");
console.log("exp3/feature", feature.value);
`,
);
write(
  "main.mjs",
  `import * as esm1 from "esm1";
import * as esm2 from "esm2";
import * as esm5 from "esm5";
import { kind as conditionalKind } from "exp4";
import cjsDefault, { alpha, beta, gamma } from "named2";
import plainDefault, { value as plainValue } from "plain1";

const results = [];
for (const [name, ns, extra] of [
  ["esm1", esm1, ns => ns.value],
  ["esm2", esm2, ns => ns.linked],
  ["esm5", esm5, ns => ns.bridged],
]) {
  results.push(name + "=" + extra(ns) + ":" + ns.kind + ":" + ns.default);
}
console.log(results.join(","));
console.log("conditional", conditionalKind);
console.log("cjs", cjsDefault.value, plainDefault.value, plainValue, alpha, beta, gamma);
`,
);

console.log(`smoke tree: ${root}`);
