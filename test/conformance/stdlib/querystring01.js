"use strict";
const qs = require("querystring");
console.log(JSON.stringify(qs.parse("a=1&b=2&a=3")));
console.log(qs.stringify({ a: [1, 2], b: "x y" }));
console.log(qs.escape("a b&c"), qs.unescape("a%20b%26c"));
