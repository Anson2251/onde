"use strict";
// fs.statfs: key set and numeric shape. Values are filesystem dependent, so only the stable
// parts are printed (keys, types, positivity, bigint option).
const fs = require("fs");
const os = require("os");

const stats = fs.statfsSync(os.tmpdir());
console.log("keys", Object.keys(stats).join(","));
console.log("types", typeof stats.type, typeof stats.bsize, typeof stats.blocks);
console.log("positive", stats.bsize > 0, stats.blocks > 0, stats.files > 0);
console.log("sums", stats.bfree <= stats.blocks, stats.bavail <= stats.bfree);

const bigint = fs.statfsSync(os.tmpdir(), { bigint: true });
console.log("bigint", typeof bigint.type, typeof bigint.blocks);
