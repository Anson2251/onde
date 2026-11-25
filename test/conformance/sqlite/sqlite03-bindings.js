// `node:sqlite`: anonymous, numbered and named parameters, and the bare/unknown policy.

const { Database } = require("node:sqlite");

const db = new Database(":memory:");

const named = db.prepare("SELECT :a AS a, $b AS b, @c AS c");
console.log("prefixed:", JSON.stringify(named.get({ ":a": 1, "$b": 2, "@c": 3 })));
console.log("bare:", JSON.stringify(named.get({ a: 1, b: 2, c: 3 })));

try {
  named.get({ a: 1, z: 9 });
} catch (error) {
  console.log("unknown:", error.code, error.message);
}
named.setAllowUnknownNamedParameters(true);
console.log("unknown allowed:", JSON.stringify(named.get({ a: 1, z: 9 })));

named.setAllowBareNamedParameters(false);
try {
  named.get({ a: 1 });
} catch (error) {
  console.log("bare off:", error.code, error.message);
}
console.log("bare off with prefix:", JSON.stringify(named.get({ ":a": 1 })));
named.setAllowBareNamedParameters(true);

try {
  db.prepare("SELECT $k AS a, @k AS b").get({ k: 7 });
} catch (error) {
  console.log("ambiguous:", error.code, error.message);
}

const anonymous = db.prepare("SELECT ? AS a, ? AS b");
console.log("anonymous:", JSON.stringify(anonymous.get("x", 42)));
console.log("missing:", JSON.stringify(anonymous.get(1)));
try {
  anonymous.get(1, 2, 3);
} catch (error) {
  console.log("extra:", error.code, error.errcode, error.message);
}

const numbered = db.prepare("SELECT ?2 AS a, ?1 AS b");
console.log("numbered:", JSON.stringify(numbered.get("first", "second")));

try {
  db.prepare("SELECT :a AS a").get(7);
} catch (error) {
  console.log("named positional:", error.code, error.errcode, error.message);
}
console.log("mixed:", JSON.stringify(db.prepare("SELECT :a AS a, ? AS b").get(5)));
