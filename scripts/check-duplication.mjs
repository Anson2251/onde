#!/usr/bin/env node
// Stdlib duplication guard.
//
// What it catches: a `function` declaration in `js/**/*.js` whose normalised body is identical to
// another declaration with the same name in a different file. Comments and whitespace are dropped
// and string/number literals become placeholders, so a copy that only renames its error messages
// still counts. It does not catch a paraphrase, a method moved into a class, or
// cross-file logic that was never a function; those stay review work.
//
// The history matters: the 2026-11 audit found 28 such clone clusters and ~350 redundant lines
// across the stdlib. A0-A4 and B1-B2 collapsed most of them. This script is the ratchet: new
// duplicates fail CI unless they are a deliberate §6 exception.
//
// How to add an allowlist entry: only for a copy that
// `docs/stdlib-consolidation-plan.md` §6 says must stay duplicated. Add the exact function name,
// the complete sorted list of files that copy it today, and a one-line reason. An entry matches on
// name plus file set, not on a body hash, so a native/fallback shape (the `bytes.js` /
// `textcodec.js` pattern) is one decision even when the two bodies are not clones. The file list
// is exact on purpose: adding a third copy is a new decision, not a silent extension of the old
// one. A stale entry (no matching cluster) also fails, so the list cannot rot.
//
// Run: node scripts/check-duplication.mjs

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JS_ROOT = path.join(ROOT, "js");

// Redundant lines allowed across every cluster, allowlisted ones included. The allowlist exempts a
// cluster from the hard "no new duplicate" rule; this budget caps how much deliberate duplication
// may accumulate in total.
const REDUNDANT_LINE_BUDGET = 40;

// Every entry is a §6 decision, not a convenience. Keep the list sorted by name.
const ALLOWLIST = [
  {
    name: "createInterface",
    files: ["js/lib/readline-promises.js", "js/lib/readline.js"],
    reason: "readline/promises extends readline's Interface; its factory constructs the subclass",
  },
  {
    name: "createServer",
    files: ["js/lib/http.js", "js/lib/https.js"],
    reason: "https is http plus TLS setup; the two entry points stay separate (§6)",
  },
  {
    name: "hostObject",
    files: ["js/lib/os.js", "js/lib/readline.js", "js/lib/tty.js"],
    reason: "a two-line host capture; a shared module would add a load-order edge for no gain (§6)",
  },
  {
    name: "processObject",
    files: ["js/lib/console.js", "js/lib/os.js"],
    reason: "a two-line process capture; same load-order argument as hostObject (§6)",
  },
  {
    name: "validateString",
    files: ["js/lib/path.js", "js/lib/url.js"],
    reason: "path and url are hold-zone modules with their own message wording (§6)",
  },
];

// ---------------------------------------------------------------------------------------------
// Source masking
//
// Comments become spaces and each string/template/regex literal becomes one placeholder character
// (newlines preserved), so brace matching and the normalised hash cannot be confused by punctuation
// inside them. Regex literals are recognised well enough to keep a `{` or `}` in a pattern out of
// the brace counters.
// ---------------------------------------------------------------------------------------------

const REGEX_PRECEDERS = new Set([
  "(",
  "[",
  "{",
  ",",
  ";",
  ":",
  "=",
  "!",
  "&",
  "|",
  "?",
  "+",
  "-",
  "*",
  "%",
  "^",
  "~",
  "<",
  ">",
]);

const REGEX_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "case",
  "do",
  "else",
  "void",
  "delete",
  "throw",
  "new",
  "yield",
  "await",
]);

function maskSource(source) {
  const out = source.split("");
  const length = source.length;
  let i = 0;
  let lastSignificant = "";
  let lastWord = "";

  const blank = (start, end, marker) => {
    for (let k = start; k < end; k++) {
      if (source[k] !== "\n" && source[k] !== "\r") out[k] = " ";
    }
    // Keep one token for a literal, so `f("x")` is still distinguishable from `f()`.
    if (marker !== undefined) out[start] = marker;
  };

  const regexAllowed = () => {
    if (lastSignificant === "") return true;
    if (REGEX_PRECEDERS.has(lastSignificant)) return true;
    return REGEX_KEYWORDS.has(lastWord);
  };

  while (i < length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      let end = i + 2;
      while (end < length && source[end] !== "\n") end++;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && next === "*") {
      let end = i + 2;
      while (end < length && !(source[end] === "*" && source[end + 1] === "/")) end++;
      end = Math.min(length, end + 2);
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      let end = i + 1;
      while (end < length) {
        if (source[end] === "\\") {
          end += 2;
          continue;
        }
        if (source[end] === quote) {
          end++;
          break;
        }
        end++;
      }
      blank(i, end, "\u0001");
      i = end;
      lastSignificant = quote;
      lastWord = "";
      continue;
    }
    if (ch === "/" && regexAllowed()) {
      let end = i + 1;
      let inClass = false;
      while (end < length) {
        const c = source[end];
        if (c === "\\") {
          end += 2;
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) {
          end++;
          break;
        } else if (c === "\n") break;
        end++;
      }
      blank(i, end, "\u0002");
      i = end;
      lastSignificant = "/";
      lastWord = "";
      continue;
    }

    if (/[A-Za-z_$]/.test(ch)) {
      let end = i + 1;
      while (end < length && /[A-Za-z0-9_$]/.test(source[end])) end++;
      lastWord = source.slice(i, end);
      lastSignificant = "a";
      i = end;
      continue;
    }
    if (!/\s/.test(ch)) {
      lastSignificant = ch;
      lastWord = "";
    }
    i++;
  }
  return out.join("");
}

// ---------------------------------------------------------------------------------------------
// Function extraction
// ---------------------------------------------------------------------------------------------

function findMatching(source, start, open, close) {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractFunctions(source) {
  const masked = maskSource(source);
  const functions = [];
  const declaration = /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g;
  let match;

  while ((match = declaration.exec(masked)) !== null) {
    const name = match[1];
    const before = masked[match.index - 1];
    if (before !== undefined && /[\w$.]/.test(before)) continue;

    const openParen = masked.indexOf("(", match.index);
    const closeParen = findMatching(masked, openParen, "(", ")");
    if (closeParen === -1) continue;

    let openBrace = closeParen + 1;
    while (openBrace < masked.length && /\s/.test(masked[openBrace])) openBrace++;
    if (masked[openBrace] !== "{") continue;
    const closeBrace = findMatching(masked, openBrace, "{", "}");
    if (closeBrace === -1) continue;

    const maskedBody = masked.slice(openBrace, closeBrace + 1);
    const rawBody = source.slice(openBrace, closeBrace + 1);
    functions.push({
      name,
      line: source.slice(0, match.index).split("\n").length,
      lines: rawBody.split("\n").length,
      normalized: normalizeBody(maskedBody),
    });
    // Keep scanning inside the body: a nested declaration is still a declaration.
    declaration.lastIndex = openBrace + 1;
  }
  return functions;
}

const NUMBER =
  /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?n?)/g;

function normalizeBody(maskedBody) {
  return maskedBody
    .replace(NUMBER, "0")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------------------------
// Scan and cluster
// ---------------------------------------------------------------------------------------------

function walk(dir, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(full);
  }
}

const files = [];
walk(JS_ROOT, files);
files.sort();

const clusters = new Map();
let declarationCount = 0;

for (const file of files) {
  const relative = path.relative(ROOT, file).split(path.sep).join("/");
  const source = readFileSync(file, "utf8");
  for (const fn of extractFunctions(source)) {
    declarationCount++;
    const digest = createHash("sha256").update(`${fn.name}\u0000${fn.normalized}`).digest("hex");
    let cluster = clusters.get(digest);
    if (cluster === undefined) {
      cluster = { name: fn.name, copies: [] };
      clusters.set(digest, cluster);
    }
    cluster.copies.push({ file: relative, line: fn.line, lines: fn.lines });
  }
}

const grouped = [];
for (const cluster of clusters.values()) {
  const fileSet = new Set(cluster.copies.map((copy) => copy.file));
  if (fileSet.size < 2) continue;
  const sortedFiles = [...fileSet].sort();
  const representativeLines = Math.max(...cluster.copies.map((copy) => copy.lines));
  grouped.push({
    name: cluster.name,
    files: sortedFiles,
    copies: cluster.copies.sort((a, b) =>
      a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
    ),
    lines: representativeLines,
    redundant: representativeLines * (cluster.copies.length - 1),
  });
}

grouped.sort((a, b) => a.name.localeCompare(b.name) || a.files.join().localeCompare(b.files.join()));

function allowlistKey(name, files) {
  return `${name}\u0000${[...files].sort().join("\u0000")}`;
}

const allowed = new Map();
for (const entry of ALLOWLIST) {
  const key = allowlistKey(entry.name, entry.files);
  if (allowed.has(key)) {
    console.error(`duplication guard: duplicate allowlist entry for ${entry.name}`);
    process.exit(1);
  }
  allowed.set(key, entry);
}

const seen = new Set();
const unallowlisted = [];
let allowlistedRedundant = 0;

for (const cluster of grouped) {
  const key = allowlistKey(cluster.name, cluster.files);
  const entry = allowed.get(key);
  const label = `${cluster.name} [${cluster.files.join(", ")}]`;
  if (entry !== undefined) {
    seen.add(key);
    allowlistedRedundant += cluster.redundant;
    console.log(`allowlisted  ${label} — ${cluster.redundant} redundant lines`);
    console.log(`             ${entry.reason}`);
    for (const copy of cluster.copies) {
      console.log(`             ${copy.file}:${copy.line} (${copy.lines} lines)`);
    }
  } else {
    unallowlisted.push(cluster);
    console.log(`DUPLICATE    ${label} — ${cluster.redundant} redundant lines`);
    for (const copy of cluster.copies) {
      console.log(`             ${copy.file}:${copy.line} (${copy.lines} lines)`);
    }
  }
}

const stale = [...allowed.entries()].filter(([key]) => !seen.has(key));
const unallowlistedRedundant = unallowlisted.reduce((total, cluster) => total + cluster.redundant, 0);
const totalRedundant = allowlistedRedundant + unallowlistedRedundant;

console.log("");
console.log(`scanned ${files.length} files, ${declarationCount} function declarations`);
console.log(
  `allowlisted clusters: ${seen.size} (${allowlistedRedundant} redundant lines, exempt from the no-new-cluster rule)`,
);
console.log(
  `unallowlisted clusters: ${unallowlisted.length} (${unallowlistedRedundant} redundant lines)`,
);
console.log(`total redundant lines: ${totalRedundant} (budget ${REDUNDANT_LINE_BUDGET})`);

let failed = false;
if (stale.length > 0) {
  failed = true;
  for (const [, entry] of stale) {
    console.error(`stale allowlist entry: ${entry.name} [${entry.files.join(", ")}] has no cluster`);
  }
}
if (unallowlisted.length > 0) failed = true;
if (totalRedundant > REDUNDANT_LINE_BUDGET) {
  failed = true;
  console.error(
    `duplication guard: ${totalRedundant} redundant lines exceed the budget of ${REDUNDANT_LINE_BUDGET}`,
  );
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log("ok");
}
