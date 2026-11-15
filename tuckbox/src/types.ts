/**
 * Shared shapes for tuckbox.
 *
 * These are the npm registry's wire types (abbreviated packument), not a general model of
 * package.json: tuckbox reads exactly the fields it acts on and ignores the rest.
 */

/** One published version, as it appears in an abbreviated packument. */
export interface PackumentVersion {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  /** Set when the package needs a build step; tuckbox refuses rather than half-installing. */
  gypfile?: boolean;
  scripts?: Record<string, string>;
  os?: string[];
  cpu?: string[];
  dist: {
    tarball: string;
    /** `sha512-<base64>`; the preferred integrity value. */
    integrity?: string;
    /** Legacy sha1 hex, used only when `integrity` is absent. */
    shasum?: string;
  };
}

/** The abbreviated packument (`application/vnd.npm.install-v1+json`). */
export interface Packument {
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, PackumentVersion>;
}

/** One installed package, keyed in the lockfile by its install path. */
export interface LockEntry {
  name: string;
  version: string;
  /** Absolute tarball URL, so `ci` never asks the registry to resolve a range. */
  resolved: string;
  /** `sha512-<base64>` or `sha1-<base64>`; verified before the tarball is unpacked. */
  integrity: string;
  /** The dependency ranges this version declared, for `ci` consistency checks. */
  dependencies: Record<string, string>;
  /** True when the package was reached through `devDependencies` at the root. */
  dev?: boolean;
}

/** `tuckbox.lock.json`, version 1. Keyed by install path (`node_modules/a/node_modules/b`). */
export interface Lockfile {
  lockfileVersion: 1;
  name?: string;
  version?: string;
  packages: Record<string, LockEntry>;
}

/** An entry read out of a tar stream. */
export interface TarEntry {
  /** Path inside the archive, normalized with `/` and stripped of any `package/` prefix. */
  path: string;
  type: "file" | "dir" | "symlink" | "hardlink";
  /** Unix mode bits as stored (0o644, 0o755, ...). */
  mode: number;
  /** File contents for `file`; `null` for every other type. */
  data: Buffer | null;
  /** Link target for `symlink`/`hardlink`; empty otherwise. */
  linkname: string;
}

/** Where a resolution placed one package. */
export interface Placement {
  /** Install path relative to the project root, e.g. `node_modules/debug`. */
  path: string;
  entry: LockEntry;
}
