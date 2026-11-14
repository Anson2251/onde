"use strict";
const util = require("util");
console.log(util.format("%s=%d", "x", 2), util.format("%j", { a: 1 }), util.format("%%"));
console.log(util.inspect({ a: 1, b: [1, "two"] }));
console.log(util.inspect("hi"), util.inspect(1), util.inspect(null), util.inspect(undefined));
console.log(util.inspect([1, 2, 3]));
console.log(util.isDeepStrictEqual({ a: [1, 2] }, { a: [1, 2] }), util.isDeepStrictEqual({ a: 1 }, { a: 2 }));
console.log(util.types.isPromise(Promise.resolve()), util.types.isDate(new Date(0)));
function legacy(callback) {
  callback(null, 1, 2);
}
util.promisify(legacy)().then((value) => console.log(JSON.stringify(value)));
