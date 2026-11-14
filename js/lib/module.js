"use strict";

// The `module` builtin: a thin facade over the loader installed by bootstrap.js.
//
// The loader owns the cache and the `require` function; this file gives users Node's public
// surface (`Module`, `createRequire`, `builtinModules`, `isBuiltin`) without exposing the
// loader's internals as a module of their own.

let hooks = null;

class Module {
  constructor(id = "", parent = null) {
    this.id = id;
    this.path = "";
    this.exports = {};
    this.filename = null;
    this.loaded = false;
    this.children = [];
    this.parent = parent;
    this.paths = [];
  }

  require(specifier) {
    if (this.filename === null) {
      const error = new Error("Module.require is only valid on a loaded module");
      error.code = "ERR_INVALID_ARG_VALUE";
      throw error;
    }
    return hooks.createRequire(this.filename)(specifier);
  }
}

function createRequire(filename) {
  if (hooks === null) {
    throw new Error("lite-node: module system is not installed");
  }
  if (typeof filename !== "string") {
    const error = new TypeError(
      `The "filename" argument must be of type string. Received ${String(filename)}`,
    );
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
  let resolved = filename;
  if (resolved.startsWith("file:")) {
    // Lazy require avoids a cycle: `url` itself does not need `module`, but bootstrap loads
    // `module` after `url` anyway, and createRequire is only called from user code.
    resolved = require("url").fileURLToPath(resolved);
  }
  return hooks.createRequire(resolved);
}

function isBuiltin(name) {
  return hooks !== null && hooks.isBuiltin(name);
}

function install(moduleHooks) {
  hooks = moduleHooks;
  Module.builtinModules = moduleHooks.builtinModules.slice().sort();
  Module._cache = moduleHooks.cache;
  Object.defineProperty(Module, "main", {
    enumerable: false,
    configurable: true,
    get() {
      return hooks.main;
    },
  });
}

// Node exposes `Module` itself as the module's export, with these members attached.
Module.Module = Module;
Module.createRequire = createRequire;
Module.isBuiltin = isBuiltin;
Module.builtinModules = [];
Module.syncBuiltinESMExports = function syncBuiltinESMExports() {};
Module._install = install;
Object.defineProperty(Module, "_install", { enumerable: false });

module.exports = Module;
