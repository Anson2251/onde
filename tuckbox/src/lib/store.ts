/**
 * The content-addressed store: integrity checks, unpacking, and the hardlink farm.
 *
 * Filled in by the tarball workstream; see `docs/tuckbox.md` §1 and §4. Uses `fs` only; no
 * network, so the registry workstream owns fetching.
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

import type { TarEntry } from "../types";
import { list, TarError } from "./tar";

/** An `Error` with the stable `code` tests and callers branch on. */
interface CodedError extends Error {
  code: string;
}

function codedError(code: string, message: string): CodedError {
  const error = new Error(message) as CodedError;
  error.code = code;
  return error;
}

/** The `code` of a Node-style errno error, or `undefined` when `error` is not one. */
function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Decode standard base64 strictly enough that garbage cannot accidentally equal a digest.
 * `Buffer.from(..., "base64")` silently ignores invalid characters, so the round-trip is checked.
 */
function decodeBase64(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const unpadded = value.replace(/=+$/, "");
  if (unpadded.length % 4 === 1) return null;
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== unpadded) return null;
  return decoded;
}

/** A sha1 digest may be published as 40 hex characters (`dist.shasum`) or as base64. */
function decodeSha1(value: string): Buffer | null {
  if (/^[0-9a-fA-F]{40}$/.test(value)) return Buffer.from(value, "hex");
  const decoded = decodeBase64(value);
  return decoded !== null && decoded.length === 20 ? decoded : null;
}

/**
 * `sha512` of `data`, lowercase hex. This is the store's directory name, which makes the store
 * idempotent: unpacking the same tarball twice is a no-op.
 */
export function sha512Hex(data: Buffer): string {
  return createHash("sha512").update(data).digest("hex");
}

/** `sha512-<base64>`, the form npm puts in `dist.integrity`. */
export function sha512Integrity(data: Buffer): string {
  return `sha512-${createHash("sha512").update(data).digest("base64")}`;
}

/**
 * Whether `data` matches an `integrity` string.
 *
 * Handles the `sha512-<base64>` form and, because older packages only publish it, a bare sha1 hex
 * `shasum` passed as `sha1-<hex-or-base64>`. Returns `false` (never throws) on a malformed value.
 */
export function verifyIntegrity(data: Buffer, integrity: string): boolean {
  try {
    if (typeof integrity !== "string") return false;

    // SRI allows several hashes in one field; any matching supported one is a pass.
    for (const token of integrity.trim().split(/\s+/)) {
      if (token.length === 0) continue;
      const dash = token.indexOf("-");
      if (dash <= 0 || dash === token.length - 1) continue;

      // SRI algorithm names are lowercase; anything else is simply not a form we know.
      const algorithm = token.slice(0, dash);
      const encoded = token.slice(dash + 1);

      if (algorithm === "sha512") {
        // `dist.integrity` uses standard base64, never the legacy hex form.
        const expected = decodeBase64(encoded);
        if (expected === null || expected.length !== 64) continue;
        if (createHash("sha512").update(data).digest().equals(expected)) return true;
      } else if (algorithm === "sha1") {
        const expected = decodeSha1(encoded);
        if (expected === null) continue;
        if (createHash("sha1").update(data).digest().equals(expected)) return true;
      }
    }

    return false;
  } catch {
    // The contract is a boolean: a bogus algorithm or encoding is simply "does not match".
    return false;
  }
}

/**
 * Gunzip and read the archive.
 *
 * A tarball that is not gzip (some registries still serve plain `.tar`) surfaces as `ETARBALL`
 * rather than zlib's bare error, which carries no code a caller can branch on.
 */
function unzip(tarball: Buffer): TarEntry[] {
  let compressed: Buffer;
  try {
    compressed = gunzipSync(tarball);
  } catch (error) {
    throw codedError("ETARBALL", `not a gzip tarball: ${(error as Error).message}`);
  }
  try {
    return list(compressed);
  } catch (error) {
    if (error instanceof TarError) throw error;
    throw codedError("ETARBALL", `unreadable tarball: ${(error as Error).message}`);
  }
}

/** The store directory for one content hash. */
export function storePath(storeDir: string, hex: string): string {
  return join(storeDir, hex);
}

let tempCounter = 0;

/** Create and return a unique temporary sibling of the final store directory. */
function makeTempDir(storeDir: string): string {
  for (;;) {
    tempCounter += 1;
    const candidate = join(storeDir, `.tmp-${process.pid}-${tempCounter}`);
    try {
      mkdirSync(candidate, { mode: 0o755 });
      return candidate;
    } catch (error) {
      // A leftover from a previous run of this pid is fine to skip past.
      if (errnoCode(error) !== "EEXIST") throw error;
    }
  }
}

/** Write one entry under the temp root, applying the mode masks the store promises. */
function writeEntry(root: string, entry: TarEntry): void {
  const target = join(root, entry.path);
  // `list()` already rejects `..` and absolute paths; this is the last line of defense before a
  // write, in case a future caller ever constructs entries some other way.
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + sep)) {
    throw codedError("ETARBALL", `entry escapes the store directory: ${entry.path}`);
  }

  if (entry.type === "dir") {
    mkdirSync(target, { recursive: true, mode: entry.mode & 0o777 });
    return;
  }

  mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
  // 0o666 clears execute bits and, with the umask applied by the OS, never sets setuid/setgid.
  writeFileSync(target, entry.data ?? Buffer.alloc(0), { mode: entry.mode & 0o666 });
}

/**
 * Unpack `tarball` (still gzipped) into the store under its content hash, and return that path.
 *
 * Refuses an archive whose integrity does not match. Unpacking is atomic: the entries are written
 * to a temporary sibling directory and renamed into place, so an interrupted run never leaves a
 * half-unpacked package that later looks complete. Rejects an archive containing anything but
 * regular files and directories (npm tarballs never contain symlinks tuckbox should follow).
 */
export function unpack(storeDir: string, tarball: Buffer, integrity: string): string {
  // Integrity is checked before the archive is even decompressed: a corrupted download must not
  // reach the filesystem at all.
  if (!verifyIntegrity(tarball, integrity)) {
    throw codedError(
      "EINTEGRITY",
      `tarball integrity mismatch: expected ${integrity}, actual ${sha512Integrity(tarball)}`,
    );
  }

  const entries = unzip(tarball);

  // npm tarballs contain only files and directories. A symlink or hardlink is how an archive
  // escapes the directory it is unpacked into, so it is rejected before anything is written.
  for (const entry of entries) {
    if (entry.type === "symlink" || entry.type === "hardlink") {
      throw codedError(
        "ETARBALL",
        `refusing ${entry.type} entry in tarball: ${entry.path}`,
      );
    }
  }

  const hex = sha512Hex(tarball);
  const finalPath = storePath(storeDir, hex);
  if (existsSync(finalPath)) return finalPath;

  mkdirSync(storeDir, { recursive: true, mode: 0o755 });
  const tempDir = makeTempDir(storeDir);

  try {
    for (const entry of entries) writeEntry(tempDir, entry);

    try {
      // The rename publishes a fully written tree in one step; readers never observe a partial
      // package at `finalPath`.
      renameSync(tempDir, finalPath);
    } catch (error) {
      // Another process may have unpacked the same tarball while this one worked. The existing
      // tree is as valid as ours, so discard the temp copy and reuse it.
      const code = errnoCode(error);
      if ((code === "EEXIST" || code === "ENOTEMPTY") && existsSync(finalPath)) {
        rmSync(tempDir, { recursive: true, force: true });
        return finalPath;
      }
      throw error;
    }

    return finalPath;
  } catch (error) {
    // Any failure leaves no half-unpacked tree behind for a later run to mistake for complete.
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

/** Hardlink (or copy) one file, replacing whatever is already at the destination. */
function linkFile(source: string, target: string): void {
  try {
    // A previous install (or a re-materialize) may have left a file here. Hardlinking over an
    // existing name fails EEXIST, so the old name is removed first.
    unlinkSync(target);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }

  try {
    linkSync(source, target);
  } catch (error) {
    if (errnoCode(error) !== "EXDEV") throw error;
    // The store and the destination can be on different filesystems; a copy is the only way to
    // place the file there. It is not hardlinked, so the duplication is unavoidable.
    copyFileSync(source, target);
  }
}

/** Recurse over one directory without ever following a symlink. */
function materializeTree(from: string, to: string): void {
  const entries = readdirSync(from, { withFileTypes: true });
  for (const entry of entries) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);

    if (entry.isDirectory()) {
      const mode = statSync(source).mode & 0o777;
      mkdirSync(target, { recursive: true, mode });
      materializeTree(source, target);
    } else if (entry.isFile()) {
      mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
      linkFile(source, target);
    } else {
      // The store is built by `unpack`, which rejects links; anything else here would mean the
      // store was corrupted, and following it could duplicate data from outside the store.
      throw codedError("ETARBALL", `refusing non-file entry while materializing: ${source}`);
    }
  }
}

/**
 * Recreate the directory tree at `from` under `to`, hardlinking every file.
 *
 * Existing files at `to` are replaced. A hardlink that fails with `EXDEV` (a store on another
 * filesystem) falls back to a copy; any other failure propagates. Used to place a package into
 * `node_modules` without duplicating its bytes.
 */
export function materialize(from: string, to: string): void {
  mkdirSync(to, { recursive: true, mode: 0o755 });
  materializeTree(from, to);
}
