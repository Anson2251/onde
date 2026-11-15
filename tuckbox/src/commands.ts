/**
 * The five commands. Each returns the process exit code and owns its user-facing output.
 *
 * The split of labour is deliberate: `resolve` never writes, `install` never resolves, and `ci`
 * never talks to the registry to decide *what* to install. That is what makes `ci` trustworthy and
 * `install` reproducible.
 */

import type { Lockfile } from "./types";
import { materializeLock, type MaterializeOptions } from "./lib/install";
import * as lockfile from "./lib/lockfile";
import * as manifestLib from "./lib/manifest";
import * as registry from "./lib/registry";
import { resolve } from "./lib/resolve";
import * as semver from "./lib/semver";

export interface CommandContext {
  /** Project directory. */
  dir: string;
  registry: string;
  prod: boolean;
  verbose: boolean;
  out: (line: string) => void;
  err: (line: string) => void;
}

function fail(context: CommandContext, message: string): number {
  context.err(`tuckbox: ${message}`);
  return 1;
}

/** Progress goes to stderr so `tuckbox ls` and piped output stay clean. */
function installOptions(context: CommandContext): MaterializeOptions {
  return {
    dir: context.dir,
    prod: context.prod,
    log: context.verbose ? (line) => context.err(line) : undefined,
  };
}

function registryOptions(context: CommandContext): registry.RegistryOptions {
  return { registry: context.registry, verbose: context.verbose };
}

/**
 * `tuckbox ci`'s whole value is refusing to install a tree that does not match the manifest. A
 * missing entry, or one whose version no longer satisfies the range, is a failure with the command
 * that fixes it - not a silent partial install.
 */
function checkManifest(lock: Lockfile, manifest: manifestLib.Manifest, prod: boolean): string | null {
  for (const dependency of manifestLib.allDependencies(manifest)) {
    if (prod && dependency.dev) continue;

    const entry = lock.packages[`node_modules/${dependency.name}`];
    if (entry === undefined) {
      return `package.json requires ${dependency.name}@"${dependency.range}" but the lockfile has no node_modules/${dependency.name}`;
    }
    if (!semver.satisfies(entry.version, dependency.range)) {
      return `the lockfile pins ${dependency.name}@${entry.version}, which does not satisfy "${dependency.range}"`;
    }
  }
  return null;
}

/** `tuckbox install`: resolve, write the lockfile, materialize the tree. */
export async function install(context: CommandContext): Promise<number> {
  const manifest = manifestLib.read(context.dir);
  if (manifest === null) return fail(context, `no package.json in ${context.dir}`);

  const lock = await resolve(context.dir, {
    dev: !context.prod,
    registry: registryOptions(context),
    log: context.verbose ? (line) => context.err(line) : undefined,
  });
  lockfile.write(context.dir, lock);

  const count = await materializeLock(lock, installOptions(context));
  context.out(`installed ${count} package${count === 1 ? "" : "s"}`);
  return 0;
}

/** `tuckbox ci`: materialize strictly from the lockfile. */
export async function ci(context: CommandContext): Promise<number> {
  const lock = lockfile.read(context.dir);
  if (lock === null) return fail(context, "no tuckbox.lock.json - run `tuckbox install` first");

  const manifest = manifestLib.read(context.dir);
  if (manifest !== null) {
    const problem = checkManifest(lock, manifest, context.prod);
    if (problem !== null) {
      return fail(context, `${problem} - run \`tuckbox install\` to update the lockfile`);
    }
  }

  const count = await materializeLock(lock, installOptions(context));
  context.out(`installed ${count} package${count === 1 ? "" : "s"}`);
  return 0;
}

/** `tuckbox add <name>[@range]...`. A bare name is pinned to `^latest`, as npm does. */
export async function add(context: CommandContext, specs: string[]): Promise<number> {
  const manifest = manifestLib.read(context.dir);
  if (manifest === null) return fail(context, `no package.json in ${context.dir}`);

  const dependencies: Record<string, string> = { ...(manifest.dependencies ?? {}) };

  for (const spec of specs) {
    const parsed = manifestLib.parseSpec(spec);
    let wanted = parsed.range;

    if (wanted === null) {
      const packument = await registry.getPackument(parsed.name, registryOptions(context));
      const latest = packument["dist-tags"].latest;
      if (latest === undefined) return fail(context, `${parsed.name} has no "latest" dist-tag`);
      wanted = `^${latest}`;
    }

    dependencies[parsed.name] = wanted;
    if (manifest.devDependencies !== undefined) delete manifest.devDependencies[parsed.name];
    context.out(`added ${parsed.name}@"${wanted}"`);
  }

  manifest.dependencies = dependencies;
  manifestLib.write(context.dir, manifest);
  return install(context);
}

/** `tuckbox remove <name>...`. */
export async function remove(context: CommandContext, names: string[]): Promise<number> {
  const manifest = manifestLib.read(context.dir);
  if (manifest === null) return fail(context, `no package.json in ${context.dir}`);

  let removed = 0;
  for (const name of names) {
    let found = false;
    if (manifest.dependencies !== undefined && name in manifest.dependencies) {
      delete manifest.dependencies[name];
      found = true;
    }
    if (manifest.devDependencies !== undefined && name in manifest.devDependencies) {
      delete manifest.devDependencies[name];
      found = true;
    }
    if (!found) {
      context.err(`tuckbox: ${name} is not a dependency`);
      continue;
    }
    context.out(`removed ${name}`);
    removed += 1;
  }

  if (removed === 0) return 1;
  manifestLib.write(context.dir, manifest);
  return install(context);
}

/** `tuckbox ls`: print the resolved tree from the lockfile, indented by nesting. */
export async function ls(context: CommandContext): Promise<number> {
  const lock = lockfile.read(context.dir);
  if (lock === null) return fail(context, "no tuckbox.lock.json - run `tuckbox install` first");

  const paths = Object.keys(lock.packages).sort();
  for (const path of paths) {
    const entry = lock.packages[path];
    if (entry === undefined) continue;
    // `/node_modules/` appears once more for each level of nesting.
    const depth = path.split("node_modules/").length - 2;
    const marker = entry.dev === true ? " (dev)" : "";
    context.out(`${"  ".repeat(depth)}${entry.name}@${entry.version}${marker}`);
  }
  context.out(`\n${paths.length} package${paths.length === 1 ? "" : "s"}`);
  return 0;
}
