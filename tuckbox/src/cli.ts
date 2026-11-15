/**
 * `tuckbox` entry point: argument parsing, dispatch, exit codes.
 *
 * Exit codes (docs/tuckbox.md §2): 0 ok, 1 a failure the user can act on, 2 usage.
 */

import { add, ci, install, ls, remove, type CommandContext } from "./commands";

const USAGE = `tuckbox — install npm packages into node_modules

Usage:
  tuckbox install            resolve package.json and install
  tuckbox ci                 install exactly what the lockfile says
  tuckbox add <name>[@range] add a dependency and install
  tuckbox remove <name>      remove a dependency and install
  tuckbox ls                 print the resolved tree

Options:
  --registry <url>   registry to use (default https://registry.npmjs.org)
  --prod             skip devDependencies
  --verbose          report each step
  -h, --help         show this text
`;

export interface ParsedArgs {
  command: "install" | "ci" | "add" | "remove" | "ls" | "help";
  positional: string[];
  registry: string;
  prod: boolean;
  verbose: boolean;
}

const DEFAULT_REGISTRY = "https://registry.npmjs.org";

/** Parse argv (already without `node` and the script path). Throws a usage error message. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: "install",
    positional: [],
    registry: DEFAULT_REGISTRY,
    prod: false,
    verbose: false,
  };

  let index = 0;
  let sawCommand = false;

  while (index < argv.length) {
    const arg = argv[index] as string;
    index += 1;

    if (arg === "-h" || arg === "--help") {
      parsed.command = "help";
      return parsed;
    }
    if (arg === "--registry") {
      const value = argv[index];
      if (value === undefined) throw new Error("--registry needs a value");
      parsed.registry = value;
      index += 1;
      continue;
    }
    if (arg === "--prod") {
      parsed.prod = true;
      continue;
    }
    if (arg === "--verbose") {
      parsed.verbose = true;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);

    if (!sawCommand) {
      if (arg !== "install" && arg !== "ci" && arg !== "add" && arg !== "remove" && arg !== "ls") {
        throw new Error(`unknown command: ${arg}`);
      }
      parsed.command = arg;
      sawCommand = true;
      continue;
    }

    parsed.positional.push(arg);
  }

  if (parsed.command === "help") return parsed;
  if ((parsed.command === "add" || parsed.command === "remove") && parsed.positional.length === 0) {
    throw new Error(`tuckbox ${parsed.command} needs at least one package name`);
  }
  if ((parsed.command === "install" || parsed.command === "ci" || parsed.command === "ls") &&
      parsed.positional.length > 0) {
    throw new Error(`tuckbox ${parsed.command} takes no arguments`);
  }

  return parsed;
}

/** Run one invocation and return the exit code. */
export async function run(argv: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`tuckbox: ${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }

  if (parsed.command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  const context: CommandContext = {
    dir: process.cwd(),
    registry: parsed.registry,
    prod: parsed.prod,
    verbose: parsed.verbose,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };

  try {
    switch (parsed.command) {
      case "install":
        return await install(context);
      case "ci":
        return await ci(context);
      case "add":
        return await add(context, parsed.positional);
      case "remove":
        return await remove(context, parsed.positional);
      case "ls":
        return await ls(context);
    }
  } catch (error) {
    context.err(`tuckbox: ${describe(error)}`);
    if (parsed.verbose && (error as Error).stack !== undefined) {
      context.err((error as Error).stack as string);
    }
    return 1;
  }
}

/** One line for the user: `CODE: message` when the error carries a Node-style code. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" ? `${code}: ${error.message}` : error.message;
}
