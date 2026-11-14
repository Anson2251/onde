"use strict";
const first = require("./fixtures/basic-lib");
const second = require("./fixtures/basic-lib");
console.log(first === second);
const resolved = require.resolve("./fixtures/basic-lib");
console.log(typeof require.cache[resolved], require.cache[resolved].loaded);
delete require.cache[resolved];
const third = require("./fixtures/basic-lib");
console.log(first === third);
