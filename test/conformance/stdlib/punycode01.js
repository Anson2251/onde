"use strict";
const punycode = require("punycode");
console.log(punycode.toASCII("mañana.com"), punycode.toUnicode("xn--maana-pta.com"));
console.log(punycode.encode("mañana"), punycode.decode("maana-pta"));
console.log(punycode.ucs2.encode([109, 97]));
