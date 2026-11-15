/**
 * `package.json` reading and the edits `add`/`remove` perform.
 *
 * The manifest is preserved as data: tuckbox edits the two dependency objects and writes the rest
 * back untouched, so `add` does not reformat a hand-maintained file into a different shape.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The fields tuckbox acts on. Everything else in a manifest is preserved untouched on write. */
export interface Manifest {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

function coded(code: string, message: string): Error {
  const error = new Error(message);
  (error as Error & { code?: string }).code = code;
  return error;
}

/** `null` when there is no `package.json` in `dir`. A malformed one is an error, not `null`. */
export function read(dir: string): Manifest | null {
  const path = join(dir, "package.json");
  if (!existsSync(path)) return null;

  const text = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw coded("EJSON", `${path}: ${(cause as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw coded("EJSON", `${path}: expected a JSON object`);
  }
  return parsed as Manifest;
}

/**
 * Write `manifest` back, preserving key order and using two-space indentation (what npm writes).
 *
 * Atomic: a temporary sibling is written and renamed, so an interrupted `tuckbox add` cannot leave
 * the project without a `package.json`.
 */
export function write(dir: string, manifest: Manifest): void {
  const path = join(dir, "package.json");
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(temporary, path);
}

/** The union of `dependencies` and `devDependencies`; a name in both is a runtime dependency. */
export function allDependencies(manifest: Manifest): Array<{ name: string; range: string; dev: boolean }> {
  const result: Array<{ name: string; range: string; dev: boolean }> = [];
  const seen = new Set<string>();

  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    result.push({ name, range, dev: false });
    seen.add(name);
  }
  for (const [name, range] of Object.entries(manifest.devDependencies ?? {})) {
    if (seen.has(name)) continue;
    result.push({ name, range, dev: true });
  }
  return result;
}

/**
 * Split an `add` argument into a name and an optional range.
 *
 * `left-pad` → no range (the caller resolves the latest and pins a caret), `left-pad@^1` → `^1`,
 * `@scope/pkg` → no range, `@scope/pkg@1.2.3` → `1.2.3`. The `lastIndexOf("@")` is what makes the
 * scoped forms work: their leading `@` is at index 0 and is never the split point.
 */
export function parseSpec(spec: string): { name: string; range: string | null } {
  const trimmed = spec.trim();
  if (trimmed === "") throw coded("EUSAGE", "empty package name");

  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return { name: trimmed, range: null };

  const range = trimmed.slice(at + 1).trim();
  return { name: trimmed.slice(0, at), range: range === "" ? null : range };
}
