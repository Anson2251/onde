/**
 * `tuckbox.lock.json`: read, write, and the path-keyed shape described in `docs/tuckbox.md` §1.
 *
 * The lockfile is the contract between `install` and `ci`: it is keyed by install path, carries
 * absolute tarball URLs and integrity values, and never contains a range. Everything here is
 * deterministic so that two machines resolving the same graph produce byte-identical files.
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Lockfile, LockEntry } from "../types";

const FILENAME = "tuckbox.lock.json";

/** `<dir>/tuckbox.lock.json`. */
export function lockfilePath(dir: string): string {
  return join(dir, FILENAME);
}

interface LockfileError extends Error {
  code: string;
}

function fail(source: string, detail: string): LockfileError {
  const error = new Error(`${source}: ${detail}`) as LockfileError;
  error.code = "ELOCKFILE";
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Does `key` name a package install path?
 *
 * A path is one or more `node_modules/<package>` segments; a package is either `name` or
 * `@scope/name`, and a package may itself contain another `node_modules/<package>` chain. The
 * empty, `.` and `..` segments are rejected so a parsed lockfile can never direct a write outside
 * the project.
 */
function isInstallPath(key: string): boolean {
  const parts = key.split("/");
  if (parts[0] !== "node_modules" || parts.length < 2) return false;

  let index = 1;
  while (index < parts.length) {
    const segment = parts[index];
    if (segment === undefined || segment === "" || segment === "." || segment === "..") return false;
    if (segment.includes("\\")) return false;

    if (segment.startsWith("@")) {
      // `@scope` must be followed by its name; both halves are required.
      if (segment.length === 1) return false;
      const name = parts[index + 1];
      if (name === undefined || name === "" || name === "." || name === ".." || name.includes("\\")) {
        return false;
      }
      index += 2;
    } else {
      index += 1;
    }

    if (index === parts.length) return true;
    if (parts[index] !== "node_modules") return false;
    index += 1;
    if (index === parts.length) return false;
  }

  return false;
}

/** The parsed lockfile, or `null` when there is none. A malformed file is an error, not `null`. */
export function read(dir: string): Lockfile | null {
  const file = lockfilePath(dir);
  let json: string;
  try {
    json = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return parse(json, file);
}

/** Write the lockfile atomically (temporary file, then rename). */
export function write(dir: string, lock: Lockfile): void {
  const file = lockfilePath(dir);
  const temporary = `${file}.tmp-${process.pid}`;

  try {
    writeFileSync(temporary, serialize(lock), "utf8");
    renameSync(temporary, file);
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      // The original failure is the one worth reporting.
    }
    throw error;
  }
}

/** Code-unit order, not locale order: the output must not depend on the machine's locale. */
function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortedKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record).sort(compareKeys);
}

function orderedEntry(entry: LockEntry): Record<string, unknown> {
  const dependencies: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const declared = entry.dependencies === undefined ? {} : entry.dependencies;
  for (const name of sortedKeys(declared as Record<string, unknown>)) {
    dependencies[name] = declared[name];
  }

  const ordered: Record<string, unknown> = {
    name: entry.name,
    version: entry.version,
    resolved: entry.resolved,
    integrity: entry.integrity,
    dependencies,
  };
  if (entry.dev === true) ordered.dev = true;
  return ordered;
}

/**
 * Deterministic JSON: install paths in sorted order, and entry keys in a fixed order, so two
 * machines resolving the same graph produce byte-identical lockfiles.
 */
export function serialize(lock: Lockfile): string {
  const packages: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const installPath of sortedKeys(lock.packages as unknown as Record<string, unknown>)) {
    packages[installPath] = orderedEntry(lock.packages[installPath] as LockEntry);
  }

  const ordered: Record<string, unknown> = { lockfileVersion: lock.lockfileVersion };
  if (lock.name !== undefined) ordered.name = lock.name;
  if (lock.version !== undefined) ordered.version = lock.version;
  ordered.packages = packages;

  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** Parse and validate; `source` names the file in error messages. */
export function parse(json: string, source: string): Lockfile {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw fail(source, `not valid JSON (${detail})`);
  }

  if (!isRecord(value)) throw fail(source, "expected a JSON object at the top level");
  if (value.lockfileVersion !== 1) {
    throw fail(source, `lockfileVersion must be 1 (got ${String(value.lockfileVersion)})`);
  }

  const rawPackages = value.packages;
  if (!isRecord(rawPackages)) throw fail(source, "packages must be an object");

  // A normal object, not a null-prototype one: callers may compare parsed values with ordinary
  // object literals. Every key is a validated install path, so none can be `__proto__`.
  const packages: Record<string, LockEntry> = {};
  for (const installPath of Object.keys(rawPackages)) {
    if (!isInstallPath(installPath)) {
      throw fail(source, `invalid install path ${JSON.stringify(installPath)} (expected node_modules/...)`);
    }

    const raw = rawPackages[installPath];
    if (!isRecord(raw)) {
      throw fail(source, `packages[${JSON.stringify(installPath)}] must be an object`);
    }

    for (const field of ["name", "version", "resolved", "integrity"] as const) {
      if (typeof raw[field] !== "string") {
        throw fail(
          source,
          `packages[${JSON.stringify(installPath)}].${field} must be a string`,
        );
      }
    }
    if (!isRecord(raw.dependencies)) {
      throw fail(source, `packages[${JSON.stringify(installPath)}].dependencies must be an object`);
    }

    const entry: LockEntry = {
      name: raw.name as string,
      version: raw.version as string,
      resolved: raw.resolved as string,
      integrity: raw.integrity as string,
      dependencies: { ...(raw.dependencies as Record<string, string>) },
    };
    if (raw.dev !== undefined) {
      if (typeof raw.dev !== "boolean") {
        throw fail(source, `packages[${JSON.stringify(installPath)}].dev must be a boolean`);
      }
      if (raw.dev) entry.dev = true;
    }
    packages[installPath] = entry;
  }

  const lock: Lockfile = { lockfileVersion: 1, packages };
  if (value.name !== undefined) {
    if (typeof value.name !== "string") throw fail(source, "name must be a string");
    lock.name = value.name;
  }
  if (value.version !== undefined) {
    if (typeof value.version !== "string") throw fail(source, "version must be a string");
    lock.version = value.version;
  }
  return lock;
}

/** Build an entry, so callers do not hand-write the `resolved`/`integrity` pair. */
export function makeEntry(init: {
  name: string;
  version: string;
  resolved: string;
  integrity: string;
  dependencies?: Record<string, string>;
  dev?: boolean;
}): LockEntry {
  const entry: LockEntry = {
    name: init.name,
    version: init.version,
    resolved: init.resolved,
    integrity: init.integrity,
    dependencies: init.dependencies === undefined ? {} : { ...init.dependencies },
  };
  if (init.dev) entry.dev = true;
  return entry;
}
