/**
 * A semver implementation for the ranges npm packages actually publish.
 *
 * Filled in by the semver workstream; see `docs/tuckbox.md` §3. Pure: no `fs`, no `process`.
 *
 * Deliberate differences from npm's own `semver`:
 *
 * - `parse` accepts a leading `=` as well as `v` (`=1.2.3`); npm's `parse` only accepts `v`.
 * - `validRange` accepts the resolver sentinels `latest` and `any` as synonyms for `*`; npm
 *   rejects both. tuckbox substitutes `latest` from `dist-tags` before it reaches this module, but
 *   the resolver can safely pass it through, and `any` is convenient in manifests.
 * - Normalized ranges print plain upper bounds (`<2.0.0`), not npm's `<2.0.0-0`. The two forms
 *   accept exactly the same versions once the prerelease rule below is applied; npm's `-0` only
 *   makes that exclusion visible to its comparator test.
 * - `compare` returns 0 when either argument is not a parseable version instead of throwing. The
 *   contract says callers may assume valid input; this keeps an unexpected registry value from
 *   crashing the resolver.
 *
 * The prerelease rule is the subtle part: a version carrying a prerelease satisfies a comparator
 * set only when some comparator in that set carries a prerelease on the *same* major.minor.patch.
 * Without the guard `^1.0.0` would accept `1.2.3-beta.1` — numerically it is greater than 1.0.0 and
 * less than 2.0.0 — but a stable range must never select an unstable release. The tuple test
 * matters too: `>=1.2.3-beta.0` should admit `1.2.3-beta.1` but not `1.2.4-beta.1`, even though
 * both are numerically greater than the lower bound.
 */

/** A parsed version. `prerelease` holds numeric identifiers as numbers, per semver's ordering. */
export interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease: ReadonlyArray<string | number>;
  /** The input string, before any normalization (leading `v`, whitespace). */
  raw: string;
}

const MAX_SAFE_VERSION_NUMBER = Number.MAX_SAFE_INTEGER;

// One prerelease/build identifier, or a dot-separated list of them. The outer regexes reject
// empty identifiers, empty lists, and characters outside semver 2.0.0's ASCII set.
const IDENTIFIER = "[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*";

const VERSION_RE = new RegExp(
  `^[v=]?([0-9]+)\\.([0-9]+)\\.([0-9]+)(?:-(${IDENTIFIER}))?(?:\\+(${IDENTIFIER}))?$`,
);

// Partial versions drive ranges: `1`, `1.2`, `1.2.x`, `*`. Missing components are wildcards.
const PARTIAL_RE = new RegExp(
  `^([0-9]+|[xX*])(?:\\.([0-9]+|[xX*]))?(?:\\.([0-9]+|[xX*]))?(?:-(${IDENTIFIER}))?(?:\\+(${IDENTIFIER}))?$`,
);

const OPERATOR_RE = /^(<=|>=|~>|<|>|=|~|\^)/;

// `1.2.3 - 2.3.4`. A hyphen range is a whole whitespace-separated branch, not a token inside one.
const HYPHEN_RE = /^(\S+)\s+-\s+(\S+)$/;

// npm tolerates `>= 1.2.3`; collapse the operator/version gap before tokenizing.
const OPERATOR_SPACE_RE = /(<=|>=|~>|<|>|=|~|\^)\s+/g;

type Operator = "=" | ">" | ">=" | "<" | "<=";

interface Comparator {
  readonly operator: Operator;
  readonly version: Version;
}

/** Comparators that must all hold. An empty set is `*`. */
type ComparatorSet = ReadonlyArray<Comparator>;

interface PartialVersion {
  readonly major: number | null;
  readonly minor: number | null;
  readonly patch: number | null;
  readonly prerelease: ReadonlyArray<string | number>;
}

/** Parse `1.2.3`, `v1.2.3`, `1.2.3-beta.1`. Returns `null` for anything else. */
export function parse(input: string): Version | null {
  if (typeof input !== "string") return null;

  const match = VERSION_RE.exec(input.trim());
  if (!match) return null;

  const majorText = match[1];
  const minorText = match[2];
  const patchText = match[3];
  if (majorText === undefined || minorText === undefined || patchText === undefined) return null;

  const major = parseNumber(majorText);
  const minor = parseNumber(minorText);
  const patch = parseNumber(patchText);
  if (major === null || minor === null || patch === null) return null;

  const prereleaseText = match[4];
  const prerelease = prereleaseText === undefined ? [] : parsePrerelease(prereleaseText);
  if (prerelease === null) return null;

  // Build metadata is syntactically validated by the regex but deliberately discarded: semver
  // 2.0.0 says it never takes part in ordering or equality.
  return { major, minor, patch, prerelease, raw: input };
}

/** The normalized `1.2.3` form, or `null` when `input` is not a version. */
export function valid(input: string): string | null {
  const version = parse(input);
  return version === null ? null : formatVersion(version);
}

/** `-1 | 0 | 1`, ignoring build metadata and ordering prereleases per semver 2.0.0. */
export function compare(a: Version | string, b: Version | string): -1 | 0 | 1 {
  const left = typeof a === "string" ? parse(a) : a;
  const right = typeof b === "string" ? parse(b) : b;
  // Documented contract: never throw on input we cannot parse. Returning 0 makes a malformed
  // registry version tie with everything, which is the least disruptive failure for resolution.
  if (left === null || right === null) return 0;
  return compareVersions(left, right);
}

/**
 * Whether `version` satisfies `range`.
 *
 * `range` may be `*`, `latest`, or a full range. The literal sentinels `latest`, `*`, `x`, `X`,
 * `any`, and the empty string all mean "any non-prerelease version" — a prerelease still needs an
 * explicit prerelease comparator, exactly as with npm's `*`.
 */
export function satisfies(version: string, range: string): boolean {
  const parsedVersion = parse(version);
  if (parsedVersion === null) return false;

  const sets = parseRange(range);
  if (sets === null) return false;

  return sets.some((set) => testSet(set, parsedVersion));
}

/** The highest entry of `versions` satisfying `range`, or `null`. Input order is irrelevant. */
export function maxSatisfying(versions: readonly string[], range: string): string | null {
  const sets = parseRange(range);
  if (sets === null) return null;

  let best: Version | null = null;
  let bestRaw: string | null = null;

  for (const candidate of versions) {
    const version = parse(candidate);
    if (version === null) continue; // registry metadata can contain junk; ignore it here.
    if (!sets.some((set) => testSet(set, version))) continue;

    if (best === null || compareVersions(version, best) > 0) {
      best = version;
      bestRaw = candidate;
    }
  }

  return bestRaw;
}

/** `range` normalized, or `null` when it is not a range tuckbox understands. */
export function validRange(range: string): string | null {
  const sets = parseRange(range);
  return sets === null ? null : formatRange(sets);
}

function parseNumber(text: string): number | null {
  // semver 2.0.0 forbids leading zeroes in numeric identifiers, so `01.2.3` is invalid rather than
  // equal to `1.2.3`. Rejecting matches npm's strict parser.
  if (text.length > 1 && text.startsWith("0")) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

function parsePrerelease(text: string): ReadonlyArray<string | number> | null {
  const identifiers: Array<string | number> = [];

  for (const identifier of text.split(".")) {
    if (identifier === "") return null;

    if (/^[0-9]+$/.test(identifier)) {
      if (identifier.length > 1 && identifier.startsWith("0")) return null;
      const value = Number(identifier);
      // npm keeps identifiers at or above MAX_SAFE_INTEGER as strings so ordering never silently
      // loses digits; mirror that, and compare such identifiers as strings.
      identifiers.push(value < MAX_SAFE_VERSION_NUMBER ? value : identifier);
    } else {
      identifiers.push(identifier);
    }
  }

  return identifiers;
}

function makeVersion(
  major: number,
  minor: number,
  patch: number,
  prerelease: ReadonlyArray<string | number> = [],
): Version {
  const base = `${major}.${minor}.${patch}`;
  const raw = prerelease.length === 0 ? base : `${base}-${prerelease.join(".")}`;
  return { major, minor, patch, prerelease, raw };
}

function formatVersion(version: Version): string {
  const base = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease.length === 0 ? base : `${base}-${version.prerelease.join(".")}`;
}

function compareNumbers(a: number, b: number): -1 | 0 | 1 {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function compareIdentifiers(a: string | number, b: string | number): -1 | 0 | 1 {
  // Numeric identifiers form their own class below every alphanumeric one. Within that class the
  // comparison is numeric, so `1.0.0-2` precedes `1.0.0-10` (a plain string compare would not).
  if (typeof a === "number") {
    if (typeof b === "number") return compareNumbers(a, b);
    return -1;
  }
  if (typeof b === "number") return 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function compareVersions(a: Version, b: Version): -1 | 0 | 1 {
  const core = compareNumbers(a.major, b.major) || compareNumbers(a.minor, b.minor) ||
    compareNumbers(a.patch, b.patch);
  if (core !== 0) return core;

  const aPre = a.prerelease;
  const bPre = b.prerelease;

  if (aPre.length === 0 && bPre.length === 0) return 0;
  // A release outranks any prerelease of the same major.minor.patch.
  if (aPre.length === 0) return 1;
  if (bPre.length === 0) return -1;

  const length = Math.max(aPre.length, bPre.length);
  for (let index = 0; index < length; index += 1) {
    const left = aPre[index];
    const right = bPre[index];
    // A shorter list of identifiers has lower precedence when the shared prefix is equal.
    if (left === undefined) return -1;
    if (right === undefined) return 1;

    const result = compareIdentifiers(left, right);
    if (result !== 0) return result;
  }

  return 0;
}

function isAnyRange(range: string): boolean {
  // Sentinels and wholly-wildcard ranges. tuckbox's resolver substitutes `latest` from
  // `dist-tags`, so seeing it here just means "do not constrain the choice".
  const normalized = range.toLowerCase();
  return (
    normalized === "" ||
    normalized === "*" ||
    normalized === "x" ||
    normalized === "latest" ||
    normalized === "any"
  );
}

function parseRange(range: string): ReadonlyArray<ComparatorSet> | null {
  if (typeof range !== "string") return null;

  const trimmed = range.trim();
  if (isAnyRange(trimmed)) return [[]];

  const sets: ComparatorSet[] = [];
  for (const branch of trimmed.split("||")) {
    const set = parseBranch(branch.trim());
    if (set === null) return null;
    sets.push(set);
  }
  return sets;
}

function parseBranch(branch: string): ComparatorSet | null {
  // An empty `||` branch behaves like `*`, matching npm (and `a || b` stays a real union).
  if (branch === "") return [];

  const hyphen = HYPHEN_RE.exec(branch);
  if (hyphen) {
    const from = hyphen[1];
    const to = hyphen[2];
    if (from === undefined || to === undefined) return null;
    return parseHyphen(from, to);
  }

  let comparators: Comparator[] = [];
  for (const token of branch.replace(OPERATOR_SPACE_RE, "$1").split(/\s+/)) {
    const expanded = expandToken(token);
    if (expanded === null) return null;
    comparators = comparators.concat(expanded);
  }
  return normalizeSet(comparators);
}

function expandToken(token: string): ReadonlyArray<Comparator> | null {
  const operatorMatch = OPERATOR_RE.exec(token);
  const operator = operatorMatch === null ? "" : operatorMatch[1] ?? "";
  const rest = stripV(operatorMatch === null ? token : token.slice(operatorMatch[0].length));

  const partial = parsePartial(rest);
  if (partial === null) return null;

  return expandComparator(operator, partial);
}

function stripV(text: string): string {
  return text.startsWith("v") ? text.slice(1) : text;
}

function parsePartial(text: string): PartialVersion | null {
  const match = PARTIAL_RE.exec(text);
  if (!match) return null;

  const major = parsePartialComponent(match[1]);
  const minor = parsePartialComponent(match[2]);
  const patch = parsePartialComponent(match[3]);
  if (!major.valid || !minor.valid || !patch.valid) return null;

  // Components after a wildcard must be absent, so `1.x.3` and `x.2.3` are not ranges.
  if (major.value === null) {
    if (minor.value !== null || patch.value !== null) return null;
  } else if (minor.value === null) {
    if (patch.value !== null) return null;
  }

  const prereleaseText = match[4];
  const buildText = match[5];
  const concrete = major.value !== null && minor.value !== null && patch.value !== null;

  // A prerelease or build marker needs a complete version to attach to. npm quietly ignores
  // `1.2.x-beta`; treating it as invalid is safer than guessing which bound it belonged to.
  if ((prereleaseText !== undefined || buildText !== undefined) && !concrete) return null;

  const prerelease = prereleaseText === undefined ? [] : parsePrerelease(prereleaseText);
  if (prerelease === null) return null;

  return {
    major: major.value,
    minor: minor.value,
    patch: patch.value,
    prerelease,
  };
}

interface PartialComponent {
  /** False when the text was a number semver rejects (leading zero, overflow). */
  readonly valid: boolean;
  /** `null` means wildcard (missing or `x`/`X`/`*`). */
  readonly value: number | null;
}

function parsePartialComponent(text: string | undefined): PartialComponent {
  if (text === undefined || text === "x" || text === "X" || text === "*") {
    return { valid: true, value: null };
  }
  const value = parseNumber(text);
  return value === null ? { valid: false, value: null } : { valid: true, value };
}

function expandComparator(operator: string, partial: PartialVersion): ReadonlyArray<Comparator> | null {
  const { major, minor, patch, prerelease } = partial;

  switch (operator) {
    case "":
    case "=":
      return expandXRange(major, minor, patch, prerelease);

    case "~":
    case "~>":
      if (major === null) return [];
      if (minor === null) {
        return [atLeast(major, 0, 0), below(major + 1, 0, 0)];
      }
      return [
        atLeast(major, minor, patch ?? 0, patch === null ? [] : prerelease),
        below(major, minor + 1, 0),
      ];

    case "^":
      return expandCaret(major, minor, patch, prerelease);

    case ">=":
      if (major === null) return []; // `>=*` constrains nothing.
      if (minor === null) return [atLeast(major, 0, 0)];
      if (patch === null) return [atLeast(major, minor, 0)];
      return [atLeast(major, minor, patch, prerelease)];

    case ">":
      if (major === null) return [below(0, 0, 0)]; // no version can be greater than a wildcard
      if (minor === null) return [atLeast(major + 1, 0, 0)]; // >1.x means >=2.0.0
      if (patch === null) return [atLeast(major, minor + 1, 0)]; // >1.2.x means >=1.3.0
      return [{ operator: ">", version: makeVersion(major, minor, patch, prerelease) }];

    case "<":
      if (major === null) return [below(0, 0, 0)];
      if (minor === null) return [below(major, 0, 0)]; // <1.x means <1.0.0
      if (patch === null) return [below(major, minor, 0)]; // <1.2.x means <1.2.0
      return [{ operator: "<", version: makeVersion(major, minor, patch, prerelease) }];

    case "<=":
      if (major === null) return [];
      if (minor === null) return [below(major + 1, 0, 0)]; // <=1.x means <2.0.0
      if (patch === null) return [below(major, minor + 1, 0)]; // <=1.2.x means <1.3.0
      return [{ operator: "<=", version: makeVersion(major, minor, patch, prerelease) }];

    default:
      return null;
  }
}

function expandXRange(
  major: number | null,
  minor: number | null,
  patch: number | null,
  prerelease: ReadonlyArray<string | number>,
): ReadonlyArray<Comparator> {
  if (major === null) return [];
  if (minor === null) return [atLeast(major, 0, 0), below(major + 1, 0, 0)];
  if (patch === null) return [atLeast(major, minor, 0), below(major, minor + 1, 0)];
  return [{ operator: "=", version: makeVersion(major, minor, patch, prerelease) }];
}

function expandCaret(
  major: number | null,
  minor: number | null,
  patch: number | null,
  prerelease: ReadonlyArray<string | number>,
): ReadonlyArray<Comparator> {
  if (major === null) return [];

  // `^0.0.x` is the case people forget: the leftmost non-zero component is what may increase, so
  // 0.0.x lives below 0.1.0, not below 1.0.0. A bare `^0` is the same rule with every component
  // wildcarded, hence <1.0.0.
  if (minor === null) return [atLeast(major, 0, 0), below(major + 1, 0, 0)];

  const lowerPatch = patch ?? 0;
  const lowerPre = patch === null ? [] : prerelease;
  const upper =
    major > 0
      ? makeVersion(major + 1, 0, 0)
      : minor > 0
        ? makeVersion(0, minor + 1, 0)
        : patch === null
          ? makeVersion(0, 1, 0)
          : makeVersion(0, 0, patch + 1);

  return [atLeast(major, minor, lowerPatch, lowerPre), { operator: "<", version: upper }];
}

function parseHyphen(from: string, to: string): ComparatorSet | null {
  const lower = parsePartial(stripV(from));
  const upper = parsePartial(stripV(to));
  if (lower === null || upper === null) return null;

  const comparators: Comparator[] = [];

  if (lower.major !== null) {
    if (lower.minor === null) {
      comparators.push(atLeast(lower.major, 0, 0));
    } else if (lower.patch === null) {
      comparators.push(atLeast(lower.major, lower.minor, 0));
    } else {
      comparators.push(atLeast(lower.major, lower.minor, lower.patch, lower.prerelease));
    }
  }

  if (upper.major !== null) {
    if (upper.minor === null) {
      comparators.push(below(upper.major + 1, 0, 0));
    } else if (upper.patch === null) {
      comparators.push(below(upper.major, upper.minor + 1, 0));
    } else {
      comparators.push({
        operator: "<=",
        version: makeVersion(upper.major, upper.minor, upper.patch, upper.prerelease),
      });
    }
  }

  return normalizeSet(comparators);
}

function atLeast(
  major: number,
  minor: number,
  patch: number,
  prerelease: ReadonlyArray<string | number> = [],
): Comparator {
  return { operator: ">=", version: makeVersion(major, minor, patch, prerelease) };
}

function below(major: number, minor: number, patch: number): Comparator {
  return { operator: "<", version: makeVersion(major, minor, patch) };
}

function comparatorText(comparator: Comparator): string {
  const version = formatVersion(comparator.version);
  // Exact comparators print bare, like npm (`1.2.3`, not `=1.2.3`).
  return comparator.operator === "=" ? version : `${comparator.operator}${version}`;
}

function normalizeSet(comparators: ReadonlyArray<Comparator>): ComparatorSet {
  const seen = new Set<string>();
  const result: Comparator[] = [];

  for (const comparator of comparators) {
    // `>=0.0.0` is true for every version semver can express, so npm drops it; dropping it keeps
    // `^0.0` normalized to `<0.1.0` instead of `>=0.0.0 <0.1.0`.
    if (
      comparator.operator === ">=" &&
      comparator.version.major === 0 &&
      comparator.version.minor === 0 &&
      comparator.version.patch === 0 &&
      comparator.version.prerelease.length === 0
    ) {
      continue;
    }

    const key = comparatorText(comparator);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(comparator);
  }

  return result;
}

function formatRange(sets: ReadonlyArray<ComparatorSet>): string {
  // For normalization a union containing `*` collapses to `*`, as npm does. `satisfies` still
  // tests every branch, so a prerelease branch next to `*` keeps working.
  if (sets.some((set) => set.length === 0)) return "*";
  return sets.map((set) => set.map(comparatorText).join(" ")).join("||");
}

function testSet(set: ComparatorSet, version: Version): boolean {
  for (const comparator of set) {
    if (!testComparator(comparator, version)) return false;
  }

  if (version.prerelease.length === 0) return true;

  // Prerelease versions are opt-in: the range must mention a prerelease on the same tuple.
  return set.some(
    (comparator) =>
      comparator.version.prerelease.length > 0 &&
      comparator.version.major === version.major &&
      comparator.version.minor === version.minor &&
      comparator.version.patch === version.patch,
  );
}

function testComparator(comparator: Comparator, version: Version): boolean {
  const result = compareVersions(version, comparator.version);
  switch (comparator.operator) {
    case "=":
      return result === 0;
    case ">":
      return result > 0;
    case ">=":
      return result >= 0;
    case "<":
      return result < 0;
    case "<=":
      return result <= 0;
    default:
      return false;
  }
}
