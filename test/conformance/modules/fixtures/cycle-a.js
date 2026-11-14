"use strict";
exports.a = 1;
const b = require("./cycle-b");
exports.b = b.b;
exports.seen = b.sawA;
