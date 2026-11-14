"use strict";
const lib = require("./fixtures/basic-lib");
console.log(lib.name, lib.add(2, 3), lib.version, lib.sameThis);
console.log(require.resolve("./fixtures/basic-lib").endsWith("/fixtures/basic-lib.js"));
console.log(__filename.endsWith("/cjs01-basic.js"), __dirname.endsWith("/modules"));
console.log(typeof module, module.id === __filename, require.main === module);
