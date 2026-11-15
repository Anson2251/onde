/**
 * The resolver: ranges to versions, then a place in the tree for each.
 *
 * Two phases in one pass. A breadth-first walk over dependency edges picks versions; for each edge
 * it then decides *where* that version goes (see `placementFor`). Doing both at once is what makes
 * the dedupe honest: a hoisted package is only reused when the version already at the root
 * actually satisfies the range that asked for it, so the lockfile never records a package at a path
 * where Node's resolver would not find it.
 */

import type { LockEntry, Lockfile, Packument } from "../types";
import * as manifestLib from "./manifest";
import { getPackument, type RegistryOptions } from "./registry";
import * as semver from "./semver";

export interface ResolveOptions {
  /** Include the root manifest's `devDependencies` (default `true`, as `npm install` does). */
  dev?: boolean;
  registry?: RegistryOptions;
  /** Report each decision: the version chosen and the path it was placed at. */
  log?: (line: string) => void;
}

/** A guard against a pathological graph, not a real limit: npm's own trees are far below this. */
const MAX_PACKAGES = 5000;

/**
 * Specs tuckbox does not implement. Naming them is the difference between "tuckbox cannot do this"
 * and a confusing "no version satisfies file:../x".
 */
const UNSUPPORTED = /^(file:|link:|portal:|workspace:|git\+|git:|github:|https?:|npm:)/;

interface Request {
  /** Install path of the package that asked, or `""` for the root manifest. */
  parent: string;
  name: string;
  range: string;
  /** Reached through the root's `devDependencies`. */
  dev: boolean;
}

function coded(code: string, message: string): Error {
  const error = new Error(message);
  (error as Error & { code?: string }).code = code;
  return error;
}

/**
 * Where a request should be installed.
 *
 * 1. The root's own dependencies always go to the root.
 * 2. A dependency whose name is still free at the root is hoisted there, which is what makes
 *    `require("ms")` work from any package in the tree.
 * 3. If the root already holds a version that satisfies the range, that copy is reused.
 * 4. Otherwise the dependency is nested under the package that asked for it, which is the only
 *    layout in which two conflicting versions can coexist.
 */
function placementFor(request: Request, placed: Map<string, LockEntry>): string {
  const root = `node_modules/${request.name}`;
  if (request.parent === "") return root;

  const occupant = placed.get(root);
  if (occupant === undefined) return root;
  if (occupant.name === request.name && semver.satisfies(occupant.version, request.range)) return root;

  return `${request.parent}/node_modules/${request.name}`;
}

/** Choose a version for one edge, fetching the packument at most once per package name. */
async function pickVersion(
  request: Request,
  packuments: Map<string, Packument>,
  options: ResolveOptions,
): Promise<{ version: string; packument: Packument }> {
  const range = request.range.trim();
  if (UNSUPPORTED.test(range)) {
    throw coded(
      "ESPEC",
      `${request.name}: unsupported specifier "${request.range}" (tuckbox installs registry ranges)`,
    );
  }

  let packument = packuments.get(request.name);
  if (packument === undefined) {
    packument = await getPackument(request.name, options.registry);
    packuments.set(request.name, packument);
  }

  // `latest` and the empty range mean "whatever the registry calls current". `*` does not: it is a
  // range, so it picks the highest version that is not a prerelease, which can be newer than the
  // `latest` tag.
  if (range === "" || range === "latest") {
    const latest = packument["dist-tags"].latest;
    if (latest === undefined) throw coded("ETARGET", `${request.name} has no "latest" dist-tag`);
    return { version: latest, packument };
  }

  if (semver.validRange(range) === null) {
    throw coded("EBADRANGE", `${request.name}: cannot understand range "${request.range}"`);
  }

  const candidates = Object.keys(packument.versions).filter((version) =>
    semver.satisfies(version, range),
  );
  const best = semver.maxSatisfying(candidates, range);
  if (best === null) {
    throw coded("ETARGET", `no version of ${request.name} satisfies "${request.range}"`);
  }
  return { version: best, packument };
}

/**
 * Resolve the `package.json` in `dir` into a complete, path-keyed lockfile.
 *
 * Deterministic: nothing depends on registry ordering or on Promise scheduling, because edges are
 * processed in a fixed breadth-first order and the version choice is `maxSatisfying`.
 */
export async function resolve(dir: string, options: ResolveOptions = {}): Promise<Lockfile> {
  const manifest = manifestLib.read(dir);
  if (manifest === null) throw coded("ENOENT", `no package.json in ${dir}`);

  const includeDev = options.dev !== false;
  const packuments = new Map<string, Packument>();
  const placed = new Map<string, LockEntry>();

  const queue: Request[] = [];
  for (const dependency of manifestLib.allDependencies(manifest)) {
    if (dependency.dev && !includeDev) continue;
    queue.push({ parent: "", name: dependency.name, range: dependency.range, dev: dependency.dev });
  }

  // An index instead of `shift()`: same breadth-first order, and no O(n^2) array rescan on a tree
  // with hundreds of edges.
  for (let index = 0; index < queue.length; index += 1) {
    const request = queue[index];
    if (request === undefined) continue;

    const target = placementFor(request, placed);
    const existing = placed.get(target);

    if (existing !== undefined) {
      // The slot is taken. Reuse is only valid when the occupant satisfies this root; anything
      // else means two incompatible versions want the same path, which is a bug in this resolver.
      if (!semver.satisfies(existing.version, request.range)) {
        throw coded(
          "EGRAPH",
          `cannot place ${request.name}@"${request.range}" at ${target}: ${existing.version} is already there`,
        );
      }
      if (!request.dev) existing.dev = false;
      continue;
    }

    const { version, packument } = await pickVersion(request, packuments, options);
    const published = packument.versions[version];
    if (published === undefined) {
      throw coded("EBADPACKUMENT", `${request.name}@${version} is missing from its own packument`);
    }

    const integrity =
      published.dist.integrity ??
      (published.dist.shasum === undefined ? undefined : `sha1-${published.dist.shasum}`);
    if (integrity === undefined) {
      throw coded("EBADPACKUMENT", `${request.name}@${version} publishes neither integrity nor shasum`);
    }

    const entry: LockEntry = {
      name: request.name,
      version,
      resolved: published.dist.tarball,
      integrity,
      dependencies: published.dependencies ?? {},
    };
    if (request.dev) entry.dev = true;

    placed.set(target, entry);
    if (placed.size > MAX_PACKAGES) {
      throw coded("EGRAPH", `refusing to resolve more than ${MAX_PACKAGES} packages`);
    }
    options.log?.(`+ ${request.name}@${version} -> ${target}`);

    for (const [name, range] of Object.entries(published.dependencies ?? {})) {
      queue.push({ parent: target, name, range, dev: request.dev });
    }

    const optional = Object.keys(published.optionalDependencies ?? {});
    if (optional.length > 0) {
      options.log?.(`  ${request.name}@${version}: skipping optional ${optional.join(", ")}`);
    }
  }

  const lock: Lockfile = { lockfileVersion: 1, packages: {} };
  if (manifest.name !== undefined) lock.name = manifest.name;
  if (manifest.version !== undefined) lock.version = manifest.version;

  for (const path of [...placed.keys()].sort()) {
    const entry = placed.get(path);
    if (entry !== undefined) lock.packages[path] = entry;
  }
  return lock;
}
