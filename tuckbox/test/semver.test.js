"use strict";

// Unit tests for src/lib/semver.ts. Plain CommonJS on purpose: the same file must run under both
// `node test/semver.test.js` and `../target/debug/onde test/semver.test.js`.
//
// Expectations were checked against npm's own semver (v7.8.5) while writing this file, but are
// hardcoded here so the suite has no dependency on npm's install location.

const semver = require("../dist/lib/semver.js");

let assertions = 0;
const failures = [];

function check(label, actual, expected) {
  assertions += 1;
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  if (actualText !== expectedText) {
    failures.push(`${label}: expected ${expectedText}, got ${actualText}`);
  }
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

// [input, major, minor, patch, prerelease, normalized]
const versionCases = [
  ["1.2.3", 1, 2, 3, [], "1.2.3"],
  ["v1.2.3", 1, 2, 3, [], "1.2.3"],
  ["=1.2.3", 1, 2, 3, [], "1.2.3"],
  [" 1.2.3 ", 1, 2, 3, [], "1.2.3"],
  ["0.0.0", 0, 0, 0, [], "0.0.0"],
  ["10.20.30", 10, 20, 30, [], "10.20.30"],
  ["1.2.3-beta.1", 1, 2, 3, ["beta", 1], "1.2.3-beta.1"],
  ["1.2.3-beta.11", 1, 2, 3, ["beta", 11], "1.2.3-beta.11"],
  ["1.2.3-0", 1, 2, 3, [0], "1.2.3-0"],
  ["1.2.3-0A", 1, 2, 3, ["0A"], "1.2.3-0A"],
  ["1.2.3+build", 1, 2, 3, [], "1.2.3"],
  ["1.2.3-beta.1+exp.sha.5114f85", 1, 2, 3, ["beta", 1], "1.2.3-beta.1"],
];

for (const [input, major, minor, patch, prerelease, normalized] of versionCases) {
  assertions += 1;
  const parsed = semver.parse(input);
  if (parsed === null) {
    failures.push(`parse(${JSON.stringify(input)}): expected a version, got null`);
    continue;
  }
  const actual = [parsed.major, parsed.minor, parsed.patch, parsed.prerelease];
  const expected = [major, minor, patch, prerelease];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`parse(${JSON.stringify(input)}): expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  check(`valid(${JSON.stringify(input)})`, semver.valid(input), normalized);
  check(`raw(${JSON.stringify(input)})`, parsed.raw, input);
}

// Invalid versions: both parse and valid must answer null, never throw.
const invalidVersions = [
  "",
  "1",
  "1.2",
  "1.2.3.4",
  "01.2.3",
  "1.02.3",
  "1.2.03",
  "1.2.3-",
  "1.2.3+",
  "1.2.3-beta..1",
  "1.2.3-beta.01",
  "1.2.3-beta_1",
  "v",
  "=v1.2.3",
  "latest",
  "*",
  "x",
  "file:../1.2.3",
  "http://example.com/1.2.3",
];

for (const input of invalidVersions) {
  check(`parse(${JSON.stringify(input)})`, semver.parse(input), null);
  check(`valid(${JSON.stringify(input)})`, semver.valid(input), null);
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

// [a, b, expected sign of compare(a, b)]
const compareCases = [
  ["1.2.3", "1.2.3", 0],
  ["1.2.3", "1.2.4", -1],
  ["1.3.0", "1.2.9", 1],
  ["2.0.0", "10.0.0", -1],
  ["1.0.0-alpha", "1.0.0", -1],
  ["1.0.0", "1.0.0-alpha", 1],
  ["1.0.0-alpha", "1.0.0-alpha.1", -1],
  ["1.0.0-alpha.1", "1.0.0-alpha.beta", -1],
  ["1.0.0-alpha.beta", "1.0.0-beta", -1],
  ["1.0.0-beta", "1.0.0-beta.2", -1],
  ["1.0.0-beta.2", "1.0.0-beta.11", -1],
  ["1.0.0-beta.11", "1.0.0-rc.1", -1],
  ["1.0.0-rc.1", "1.0.0", -1],
  ["1.0.0-1", "1.0.0-alpha", -1],
  ["1.0.0-2", "1.0.0-10", -1],
  ["1.0.0-alpha", "1.0.0-1", 1],
  ["1.0.0+build.1", "1.0.0+build.2", 0],
  ["v1.2.3", "=1.2.3", 0],
  ["1.2.3", "1.2.3-bogus", 1],
  ["2.0.0-rc.1", "1.9.9", 1],
  ["1.0.0-alpha.1", "1.0.0-alpha.1+build", 0],
];

for (const [a, b, expected] of compareCases) {
  check(`compare(${a}, ${b})`, semver.compare(a, b), expected);
  check(`compare(${b}, ${a})`, semver.compare(b, a), expected === 0 ? 0 : -expected);
}

// Documented divergence from npm: compare never throws on garbage.
check('compare("not-a-version", "1.0.0")', semver.compare("not-a-version", "1.0.0"), 0);

// ---------------------------------------------------------------------------
// Ranges: (version, range, expected)
// ---------------------------------------------------------------------------

const satisfiesCases = [
  // Exact versions, wildcards, and the resolver sentinels.
  ["1.2.3", "1.2.3", true],
  ["1.2.4", "1.2.3", false],
  ["1.2.3", "=1.2.3", true],
  ["1.2.3", "v1.2.3", true],
  ["1.2.3", "1.2.3+build.7", true],
  ["1.2.3+build.7", "1.2.3", true],
  ["1.2.3", "*", true],
  ["1.2.3", "", true],
  ["1.2.3", "x", true],
  ["1.2.3", "X", true],
  ["1.2.3", "latest", true],
  ["1.2.3", "any", true],
  ["1.2.3", "1.x", true],
  ["1.2.3", "1.2.x", true],
  ["1.9.9", "1", true],
  ["2.0.0", "1", false],
  ["1.3.0", "1.2.x", false],
  ["1.2.3-beta.1", "*", false],
  ["1.2.3-beta.1", "", false],
  ["1.2.3-beta.1", "latest", false],
  ["1.2.3-beta.1", "1.2.3", false],
  ["1.2.3-beta.1", "1.2.3-beta.1", true],
  ["1.2.3-beta.2", "1.2.3-beta.1", false],

  // Caret: the upper bound depends on the leftmost non-zero component.
  ["1.2.3", "^1.2.3", true],
  ["1.2.2", "^1.2.3", false],
  ["1.9.9", "^1.2.3", true],
  ["2.0.0", "^1.2.3", false],
  ["0.2.5", "^0.2.3", true],
  ["0.3.0", "^0.2.3", false],
  ["0.0.3", "^0.0.3", true],
  ["0.0.4", "^0.0.3", false],
  ["0.0.5", "^0.0", true],
  ["0.1.0", "^0.0", false],

  // Tilde: patch changes are allowed, minor changes are not.
  ["1.2.3", "~1.2.3", true],
  ["1.2.9", "~1.2.3", true],
  ["1.3.0", "~1.2.3", false],
  ["1.2.9", "~1.2", true],
  ["1.2.0", "~1.2", true],
  ["1.9.9", "~1", true],
  ["2.0.0", "~1", false],
  ["1.2.4", "~1.2.3-beta.2", true],
  ["1.3.0-beta", "~1.2.3", false],

  // Plain comparators, including wildcarded partials.
  ["1.2.3", ">1.2.2", true],
  ["1.2.3", ">1.2.3", false],
  ["1.2.3", ">=1.2.3", true],
  ["1.2.3", "<1.2.4", true],
  ["1.2.4", "<1.2.4", false],
  ["1.2.3", "<=1.2.3", true],
  ["1.2.4", "<=1.2.3", false],
  ["1.3.0", ">1.2", true],
  ["1.2.9", ">1.2", false],
  ["1.2.9", "<=1.2", true],
  ["1.3.0", "<=1.2", false],
  ["1.2.9", "<1.2", false],
  ["1.2.3", ">=1.2.3 <2.0.0", true],
  ["2.0.0", ">=1.2.3 <2.0.0", false],

  // Hyphen ranges: a wildcard endpoint widens that side.
  ["1.2.3", "1.2.3 - 2.3.4", true],
  ["2.3.4", "1.2.3 - 2.3.4", true],
  ["2.3.5", "1.2.3 - 2.3.4", false],
  ["1.2.2", "1.2.3 - 2.3.4", false],
  ["2.3.3", "1.2 - 2.3.4", true],
  ["2.3.4", "1.2.3 - 2.3", true],
  ["2.4.0", "1.2.3 - 2.3", false],
  ["2.9.9", "1.2.3 - 2", true],
  ["3.0.0", "1.2.3 - 2", false],
  ["2.3.4-beta", "1.2.3 - 2.3.4", false],
  ["2.3.4-beta", "1.2.3 - 2.3.4-beta", true],

  // Unions.
  ["2.0.0", "1.2.3 || 2.0.0", true],
  ["1.5.0", "^1.2.3 || ~2.0.0", true],
  ["2.0.5", "^1.2.3 || ~2.0.0", true],
  ["2.1.0", "^1.2.3 || ~2.0.0", false],
  ["1.2.3-beta.1", "1.2.3-beta.1 || 2.0.0", true],

  // The prerelease rule: a stable range never picks a prerelease, and a prerelease range only
  // opts in prereleases sharing its major.minor.patch.
  ["1.2.3-beta.1", "^1.0.0", false],
  ["1.2.3-beta.1", ">=1.2.3-beta.0", true],
  ["1.2.3-beta.1", "^1.2.3-beta.0", true],
  ["1.2.4-beta.1", "^1.2.3-beta.0", false],
  ["1.2.3-beta.1", ">=1.2.3-beta.2", false],
  ["1.2.3", "^1.2.3-beta.0", true],
  ["0.0.3-beta.1", "^0.0.3", false],
  ["2.0.0-beta.1", "^1.2.3", false],
  ["1.2.3-beta.2", ">=1.2.3-beta.1 <2.0.0", true],
  ["1.2.4-beta.2", ">=1.2.3-beta.1 <2.0.0", false],

  // Invalid input is always false, never an exception.
  ["not-a-version", "*", false],
  ["1.2.3", "not a range", false],
  ["1.2.3", "1.x.3", false],
  ["1.2.3", "|||", false],
  ["1.2.3", "1.2.3 -", false],
  ["1.2.3", "file:../x", false],
];

for (const [version, range, expected] of satisfiesCases) {
  check(
    `satisfies(${JSON.stringify(version)}, ${JSON.stringify(range)})`,
    semver.satisfies(version, range),
    expected,
  );
}

// ---------------------------------------------------------------------------
// validRange normalization
// ---------------------------------------------------------------------------

// [input, normalized or null]
const rangeCases = [
  ["^1.2.3", ">=1.2.3 <2.0.0"],
  ["^0.2.3", ">=0.2.3 <0.3.0"],
  ["^0.0.3", ">=0.0.3 <0.0.4"],
  ["^0.0", "<0.1.0"],
  ["^1.2.3-beta.1", ">=1.2.3-beta.1 <2.0.0"],
  ["~1.2.3", ">=1.2.3 <1.3.0"],
  ["~1.2", ">=1.2.0 <1.3.0"],
  ["~1", ">=1.0.0 <2.0.0"],
  ["~>1.2.3", ">=1.2.3 <1.3.0"],
  ["1.x", ">=1.0.0 <2.0.0"],
  ["1.2", ">=1.2.0 <1.3.0"],
  ["1.2.3 - 2.3.4", ">=1.2.3 <=2.3.4"],
  ["1.2.3 || 2.0.0", "1.2.3||2.0.0"],
  ["", "*"],
  ["*", "*"],
  ["latest", "*"],
  ["any", "*"],
  ["1.2.3", "1.2.3"],
  ["=1.2.3", "1.2.3"],
  [">= 1.2.3", ">=1.2.3"],
  ["1.2.3+build", "1.2.3"],

  // Invalid ranges.
  ["1.x.3", null],
  ["V1.2.3", null],
  ["1.2.3 -", null],
  ["1.2.3.4", null],
  ["file:../x", null],
];

for (const [input, expected] of rangeCases) {
  check(`validRange(${JSON.stringify(input)})`, semver.validRange(input), expected);
}

// ---------------------------------------------------------------------------
// maxSatisfying
// ---------------------------------------------------------------------------

// Deliberately unsorted, and includes a leading-`v` entry and one unparseable entry.
const published = [
  "1.10.0",
  "2.0.0-beta.1",
  "not-a-version",
  "1.2.3",
  "v1.4.0",
  "0.9.0",
  "1.9.9",
  "2.0.0",
  "1.2.3-beta.1",
];

check('maxSatisfying(published, "^1.0.0")', semver.maxSatisfying(published, "^1.0.0"), "1.10.0");
check('maxSatisfying(published, "~1.2.0")', semver.maxSatisfying(published, "~1.2.0"), "1.2.3");
check('maxSatisfying(published, "*")', semver.maxSatisfying(published, "*"), "2.0.0");
check(
  'maxSatisfying(published, "2.0.0-beta.1")',
  semver.maxSatisfying(published, "2.0.0-beta.1"),
  "2.0.0-beta.1",
);
check(
  'maxSatisfying(published, ">=1.2.3-beta.0 <1.2.3")',
  semver.maxSatisfying(published, ">=1.2.3-beta.0 <1.2.3"),
  "1.2.3-beta.1",
);
check('maxSatisfying(published, "^3.0.0")', semver.maxSatisfying(published, "^3.0.0"), null);
check('maxSatisfying(published, "7.x")', semver.maxSatisfying(published, "7.x"), null);
check('maxSatisfying(published, "not-a-range")', semver.maxSatisfying(published, "not-a-range"), null);
check('maxSatisfying([], "*")', semver.maxSatisfying([], "*"), null);
check(
  'maxSatisfying(["garbage", "v1.2.3", "1.2.2"], "^1.2.3")',
  semver.maxSatisfying(["garbage", "v1.2.3", "1.2.2"], "^1.2.3"),
  "v1.2.3",
);
check('maxSatisfying(["garbage"], "*")', semver.maxSatisfying(["garbage"], "*"), null);

// Input order must not matter.
const reversed = published.slice().reverse();
check('maxSatisfying(reversed, "^1.0.0")', semver.maxSatisfying(reversed, "^1.0.0"), "1.10.0");
check('maxSatisfying(reversed, "~1.2.0")', semver.maxSatisfying(reversed, "~1.2.0"), "1.2.3");

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

if (failures.length > 0) {
  for (const failure of failures) {
    console.log(`fail ${failure}`);
  }
  console.log(`${failures.length} of ${assertions} assertions failed`);
  process.exit(1);
}

console.log(`ok semver ${assertions} assertions`);
