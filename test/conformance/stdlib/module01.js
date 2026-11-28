"use strict";
const Module = require("module");
console.log(typeof Module, Array.isArray(Module.builtinModules));
console.log(
    Module.builtinModules.includes("path"),
    Module.isBuiltin("node:path"),
    Module.isBuiltin("not-a-module"),
);
const { createRequire } = Module;
const requireFromRoot = createRequire("file://" + process.cwd() + "/package.json");
console.log(typeof requireFromRoot);
console.log(requireFromRoot("path").join("a", "b"));
