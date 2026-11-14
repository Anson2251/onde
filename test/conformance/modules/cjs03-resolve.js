"use strict";
const plain = require("plain-pkg");
const feature = require("exp-pkg/feature");
const flavor = require("exp-pkg");
console.log(plain.entry, feature.feature, flavor.flavor);
console.log(require.resolve("plain-pkg").endsWith("/node_modules/plain-pkg/lib/main.js"));
try {
  require("exp-pkg/secret");
} catch (error) {
  console.log(error.code);
}
