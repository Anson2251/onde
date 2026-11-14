"use strict";
console.log(this === module.exports);
this.dynamic = 5;
console.log(module.exports.dynamic);
