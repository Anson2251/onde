"use strict";
const url = require("url");
const parsed = url.parse("https://u:p@example.com:8080/p?q=1#h", true);
console.log(
    parsed.protocol,
    parsed.host,
    parsed.port,
    parsed.pathname,
    parsed.query.q,
    parsed.hash,
);
console.log(
    url.format({ protocol: "https:", host: "example.com", pathname: "/p", query: { a: "1" } }),
);
console.log(url.resolve("https://a.com/b/c", "../d"));
console.log(url.fileURLToPath("file:///tmp/a%20b.txt"));
console.log(url.pathToFileURL("/tmp/a b.txt").href);
console.log(JSON.stringify(url.urlToHttpOptions(new URL("http://u:p@h:81/p?q=1#f"))));
