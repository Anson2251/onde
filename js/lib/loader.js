"use strict";

// The CommonJS loader and builtin registry.
//
// This file is evaluated by `bootstrap.js` *before* any stdlib module, with no `require` in
// scope: it is the thing that defines one. Everything it needs from the host arrives through
// `install(host)`.
//
// Shape (architecture.md §6): resolution lives in Rust (`ln-modules`), compilation with the real
// filename lives in the engine (`host.evalCjs`), and the module record, cache, `module` object
// and `require` function live here. That split keeps `node_modules` semantics testable without
// QuickJS and keeps stack traces pointing at user files.

let host = null;

// filename -> Module. This object *is* `require.cache` (Node exposes a plain object there).
const moduleCache = Object.create(null);
// builtin name -> Module. Builtins are deliberately not in `require.cache`, like Node.
const builtinCache = Object.create(null);
// The entry module, exposed as `require.main`.
let mainModule = null;

function install(hostObject) {
  host = hostObject;
  return module.exports;
}

// --- tiny path helpers -----------------------------------------------------------------------
// The loader must work before `path` is loadable, so it carries the two functions it needs. They
// are separator-aware, not Unicode-aware: `path` itself is the public implementation.

function isWindows() {
  return host !== null && host.platform === "win32";
}

function dirname(filename) {
  const separator = isWindows() ? "\\" : "/";
  const normalized = filename.replace(/[\\/]+$/, "");
  const index = normalized.lastIndexOf(separator);
  if (index <= 0) return isWindows() ? normalized.slice(0, 2) || "." : index === 0 ? "/" : ".";
  if (isWindows() && index === 1 && normalized.length >= 2 && normalized[1] === ":") {
    return normalized.slice(0, 3);
  }
  return normalized.slice(0, index);
}

function basename(filename) {
  const separator = isWindows() ? "\\" : "/";
  const normalized = filename.replace(/[\\/]+$/, "");
  const index = normalized.lastIndexOf(separator);
  return index === -1 ? normalized : normalized.slice(index + 1);
}

function joinPath(base, name) {
  const separator = isWindows() ? "\\" : "/";
  if (base.endsWith(separator) || base.endsWith("/")) return base + name;
  return base + separator + name;
}

function nodeModulePaths(fromDirectory) {
  const separator = isWindows() ? "\\" : "/";
  const paths = [];
  let current = fromDirectory;
  for (;;) {
    const trimmed = current.replace(/[\\/]+$/, "");
    const last = trimmed.slice(trimmed.lastIndexOf(separator) + 1);
    if (last !== "node_modules") paths.push(joinPath(trimmed || separator, "node_modules"));
    const parent = dirname(trimmed);
    if (parent === current || parent === trimmed || parent === "." ) {
      if (!isWindows()) paths.push("/node_modules");
      break;
    }
    current = parent;
  }
  return paths;
}

// --- errors ----------------------------------------------------------------------------------

function codedError(Base, code, message, properties) {
  const error = new Base(message);
  error.code = code;
  if (properties !== undefined) Object.assign(error, properties);
  return error;
}

function invalidArgType(name, expected, actual) {
  let received;
  try {
    received = typeof actual === "string" ? `'${actual}'` : String(actual);
  } catch (_) {
    received = "<unprintable>";
  }
  return codedError(
    TypeError,
    "ERR_INVALID_ARG_TYPE",
    `The "${name}" argument must be of type ${expected}. Received ${received}`,
  );
}

// --- module records --------------------------------------------------------------------------

function makeModule(filename, parent) {
  const module = {
    id: filename,
    path: dirname(filename),
    filename,
    exports: {},
    loaded: false,
    children: [],
    parent: parent || null,
    paths: nodeModulePaths(dirname(filename)),
  };
  module.require = createRequire(filename, module);
  if (parent) parent.children.push(module);
  return module;
}

function createRequire(fromFile, parentModule) {
  if (typeof fromFile !== "string") {
    throw invalidArgType("filename", "string", fromFile);
  }

  function require(specifier) {
    if (typeof specifier !== "string") {
      throw invalidArgType("id", "string", specifier);
    }
    // Builtin sources live in a virtual tree (`<lite:buffer>`), not on disk: resolve their
    // sibling requires against the embedded registry instead of the filesystem.
    if (fromFile.startsWith("<lite:")) {
      const internal = resolveInternalSpecifier(specifier);
      if (internal !== null) return requireBuiltin(internal);
    }
    const resolution = host.resolve(specifier, fromFile, "require");
    switch (resolution.type) {
      case "builtin":
        return requireBuiltin(resolution.name);
      case "json":
        return loadJsonFile(resolution.path, parentModule || null);
      case "esm":
        throw requireEsmError(resolution.path, fromFile);
      case "addon":
        throw codedError(
          Error,
          "ERR_DLOPEN_FAILED",
          `Cannot load native addon '${resolution.path}': lite-node does not support N-API modules`,
        );
      default:
        return loadCjsFile(resolution.path, parentModule || null);
    }
  }

  require.resolve = function resolve(specifier) {
    if (typeof specifier !== "string") {
      throw invalidArgType("request", "string", specifier);
    }
    const resolution = host.resolve(specifier, fromFile, "require");
    if (resolution.type !== "builtin") return resolution.path;
    // Node preserves the spelling the caller used: `require.resolve("node:path")` is
    // "node:path", while `require.resolve("path")` is "path".
    return specifier.startsWith("node:") ? `node:${resolution.name}` : resolution.name;
  };
  require.resolve.paths = function paths(specifier) {
    if (typeof specifier !== "string") {
      throw invalidArgType("request", "string", specifier);
    }
    const resolution = host.resolve(specifier, fromFile, "require");
    return resolution.type === "builtin" ? null : nodeModulePaths(dirname(fromFile));
  };
  require.cache = moduleCache;
  Object.defineProperty(require, "main", {
    enumerable: true,
    configurable: true,
    get() {
      return mainModule;
    },
  });

  return require;
}

function requireEsmError(path, fromFile) {
  return codedError(
    Error,
    "ERR_REQUIRE_ESM",
    `require() of ES Module ${path} from ${fromFile} not supported.\n` +
      `Instead change the require of ${basename(path)} in ${fromFile} to a dynamic import() ` +
      `which is available in all CommonJS modules.`,
  );
}

// --- builtins --------------------------------------------------------------------------------

function canonicalBuiltin(specifier) {
  return specifier.startsWith("node:") ? specifier.slice(5) : specifier;
}

/// Map a require made from an embedded module onto a builtin name, or return null.
function resolveInternalSpecifier(specifier) {
  const name = canonicalBuiltin(specifier);
  if (host.builtinSource(name) !== null && host.builtinSource(name) !== undefined) return name;
  if (name.startsWith("./") || name.startsWith("../")) {
    const base = name.slice(name.lastIndexOf("/") + 1).replace(/\.js$/, "");
    const candidates = [base, `internal/${base}`];
    for (const candidate of candidates) {
      const source = host.builtinSource(candidate);
      if (source !== null && source !== undefined) return candidate;
    }
  }
  return null;
}

function isBuiltin(specifier) {
  if (typeof specifier !== "string") return false;
  const name = canonicalBuiltin(specifier);
  if (name === "process") return true;
  return host.builtinSource(name) !== null && host.builtinSource(name) !== undefined;
}

function builtinNames() {
  return host.builtinNames();
}

function requireBuiltin(specifier) {
  const name = canonicalBuiltin(specifier);
  // `process` is the object bootstrap creates, not an embedded source: it is the process.
  if (name === "process") {
    return globalThis.process;
  }
  const cached = builtinCache[name];
  if (cached !== undefined) return cached.exports;

  const source = host.builtinSource(name);
  if (source === null || source === undefined) {
    throw codedError(
      Error,
      "ERR_UNKNOWN_BUILTIN_MODULE",
      `No such built-in module: ${specifier}`,
    );
  }

  const filename = `<lite:${name}>`;
  const module = makeModule(filename, null);
  module.id = name;
  builtinCache[name] = module;
  try {
    host.evalCjs(filename, source, module.exports, module.require, module, "<lite>");
  } catch (error) {
    delete builtinCache[name];
    throw error;
  }
  module.loaded = true;
  return module.exports;
}

// --- CJS loading -----------------------------------------------------------------------------

function loadCjsFile(filename, parent) {
  const cached = moduleCache[filename];
  if (cached !== undefined) return cached.exports;

  const source = host.readFile(filename);
  const module = makeModule(filename, parent);
  moduleCache[filename] = module;
  try {
    host.evalCjs(
      filename,
      source,
      module.exports,
      module.require,
      module,
      dirname(filename),
    );
  } catch (error) {
    // Node does not keep failed modules in the cache: a later require retries.
    delete moduleCache[filename];
    if (parent) {
      const index = parent.children.indexOf(module);
      if (index !== -1) parent.children.splice(index, 1);
    }
    throw error;
  }
  module.loaded = true;
  return module.exports;
}

function loadJsonFile(filename, parent) {
  const cached = moduleCache[filename];
  if (cached !== undefined) return cached.exports;

  // Node's JSON loader tolerates a UTF-8 BOM; `JSON.parse` does not.
  const source = host.readFile(filename).replace(/^\uFEFF/, "");
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    const syntax = new SyntaxError(
      `${filename}: ${error.message}`,
    );
    syntax.code = "ERR_INVALID_PACKAGE_CONFIG";
    throw syntax;
  }
  const module = makeModule(filename, parent);
  module.exports = parsed;
  module.loaded = true;
  moduleCache[filename] = module;
  return parsed;
}

function runMain(filename) {
  let module = moduleCache[filename];
  if (module === undefined) {
    module = makeModule(filename, null);
    // Node gives the main module the id "." (not its filename), which old CLIs rely on.
    module.id = ".";
    mainModule = module;
    moduleCache[filename] = module;
    const source = host.readFile(filename);
    try {
      host.evalCjs(
        filename,
        source,
        module.exports,
        module.require,
        module,
        dirname(filename),
      );
    } catch (error) {
      delete moduleCache[filename];
      mainModule = null;
      throw error;
    }
    module.loaded = true;
  } else if (mainModule === null) {
    mainModule = module;
  }
  // `process.mainModule` is deprecated in Node but still read by old CLIs.
  if (globalThis.process !== undefined) {
    try {
      globalThis.process.mainModule = module;
    } catch (_) {
      // A frozen process object is not worth failing an entry over.
    }
  }
  return module.exports;
}

/// Evaluate an internal module source (loader, process factory, globals) without putting it in
/// the public registry. Used only by bootstrap.
function evalInternal(name, hostObject) {
  const source = hostObject.builtinSource(name);
  if (source === null || source === undefined) {
    throw codedError(Error, "ERR_UNKNOWN_BUILTIN_MODULE", `No such internal module: ${name}`);
  }
  const filename = `<lite:${name}>`;
  const module = { exports: {}, filename, loaded: false, children: [], parent: null };
  hostObject.evalCjs(filename, source, module.exports, null, module, "<lite>");
  module.loaded = true;
  return module.exports;
}

module.exports = {
  install,
  evalInternal,
  createRequire,
  requireBuiltin,
  isBuiltin,
  builtinNames,
  loadCjsFile,
  loadJsonFile,
  runMain,
  cache: moduleCache,
  builtinCache,
  get main() {
    return mainModule;
  },
};
