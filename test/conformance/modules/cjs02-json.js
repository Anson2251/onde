"use strict";
const data = require("./fixtures/data.json");
console.log(data.greeting, data.numbers.join("-"), data.nested.ok);
console.log(require.resolve("./fixtures/data.json").endsWith("/fixtures/data.json"));
