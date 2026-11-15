/**
 * Turning a lockfile into a `node_modules` tree.
 *
 * The tree is rebuilt from scratch on every run. That is the `npm ci` behaviour applied to both
 * commands, and it is the reason `install` cannot leave a stale package behind: the lockfile is the
 * only input, so what you resolve is exactly what you get. Rebuilding is cheap here because the
 * bodies come from the content-addressed store as hardlinks - no download, no copy.
 */

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { Lockfile } from "../types";
import * as registry from "./registry";
import * as store from "./store";

export interface MaterializeOptions {
  /** Project directory. */
  dir: string;
  /** Skip entries marked `dev`. */
  prod?: boolean;
  /** Called with one line per installed package, when verbose. */
  log?: (line: string) => void;
}

/** `<dir>/.tuckbox/store` - unpacked packages, keyed by the sha512 of their tarball. */
export function storeDirFor(dir: string): string {
  return join(dir, ".tuckbox", "store");
}

/** `<dir>/.tuckbox/cache` - downloaded tarballs and packuments, so a retry costs nothing. */
export function cacheDirFor(dir: string): string {
  return join(dir, ".tuckbox", "cache");
}

/** Deepest paths last, so a package directory exists before anything is nested inside it. */
function byDepth(left: string, right: string): number {
  const depth = (path: string) => path.split("/").length;
  return depth(left) - depth(right) || (left < right ? -1 : left > right ? 1 : 0);
}

/**
 * Install every entry of `lock` into `<dir>/node_modules`.
 *
 * Returns the number of packages written. An integrity failure or a missing tarball aborts before
 * anything is placed, so a failed run leaves an empty `node_modules` rather than a half tree.
 */
export async function materializeLock(lock: Lockfile, options: MaterializeOptions): Promise<number> {
  const storeDir = storeDirFor(options.dir);
  const cacheDir = cacheDirFor(options.dir);

  rmSync(join(options.dir, "node_modules"), { recursive: true, force: true });
  mkdirSync(storeDir, { recursive: true });

  const paths = Object.keys(lock.packages)
    .filter((path) => {
      const entry = lock.packages[path];
      return !(options.prod === true && entry !== undefined && entry.dev === true);
    })
    .sort(byDepth);

  for (const path of paths) {
    const entry = lock.packages[path];
    if (entry === undefined) continue;

    const tarball = await registry.getTarball(entry.resolved, { cacheDir, verbose: false });
    // `unpack` verifies the integrity itself, so a corrupted cache entry or a tampered download
    // fails here rather than being installed.
    const from = store.unpack(storeDir, tarball, entry.integrity);
    store.materialize(from, join(options.dir, path));
    options.log?.(`+ ${entry.name}@${entry.version}`);
  }

  return paths.length;
}
