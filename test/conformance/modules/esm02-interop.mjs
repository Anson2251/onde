import double, { kind } from "./fixtures/fn.js";
import { alpha, beta, gamma } from "./fixtures/cjs-named.js";
import path, { join } from "node:path";
import { EventEmitter } from "node:events";
import { cwd as processCwd } from "node:process";

console.log(double(3), kind, alpha, beta, gamma);
console.log(path.sep, join("a", "b"), typeof EventEmitter);
console.log(typeof processCwd() === "string", processCwd().startsWith("/"));
