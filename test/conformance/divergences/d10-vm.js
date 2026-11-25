// `vm` is a non-goal, so it is not a builtin here. Node loads it (and even bare `require("vm")`
// would succeed there; the `node:` form makes onde's error explicit).
try {
  require("node:vm");
} catch (error) {
  console.log(error.code);
}
