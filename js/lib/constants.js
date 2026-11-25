"use strict";

// `constants` — Node's deprecated flat grab bag of filesystem, OS and crypto constants.
//
// Node builds this object by flattening `fs.constants`, the object groups of `os.constants`
// (`dlopen`, `errno`, `priority`, `signals`) and `crypto.constants`, then freezing the result
// (DEP0008). It has no behaviour of its own, so this module is a forwarding surface rather than an
// implementation: start from onde's own `fs.constants`, flatten every group of `os.constants`, and
// merge `crypto.constants` when the crypto module grows one.
//
// Honesty about coverage: onde's `fs.constants` and `os.constants` are subsets of Node's (no
// `UV_FS_O_FILEMAP`, fewer `UV_*` values, and `crypto` has no `constants` yet). The flat shape and
// the composition are Node's; the key set is whatever onde implements. Nothing here is a second
// copy of a constant: every value is read from the module that owns it, so the flat object tracks
// those modules as they grow. `zlib.constants` is deliberately not included, matching Node
// (`constants.Z_NO_COMPRESSION` is `undefined`).

const fs = require("./fs.js");
const os = require("./os.js");

// `crypto` is optional (`node-crypto`): a size-trimmed build compiles the module out, and this
// deprecated grab bag must still load without it. The host answers `builtinUnavailable` with the
// same text the loader would throw, so the condition is asked rather than guessed with a catch
// (a real load failure in the module must not be swallowed). Under plain Node, where `__ln_host`
// does not exist, the require below loads the local file as usual.
const cryptoUnavailable =
  typeof __ln_host !== "undefined" &&
  typeof __ln_host.builtinUnavailable === "function" &&
  __ln_host.builtinUnavailable("crypto") !== null;
const crypto = cryptoUnavailable ? null : require("./crypto.js");

const constants = Object.assign({}, fs.constants);

// Node's flat module flattens only the object groups of `os.constants`; scalar members such as
// `UV_UDP_REUSEADDR` stay out. Selecting by value shape rather than by group name means a group
// added to `os.constants` later is picked up here without another edit.
for (const group of Object.keys(os.constants)) {
  const values = os.constants[group];
  if (values !== null && typeof values === "object") Object.assign(constants, values);
}

// onde's crypto has no `constants` today. Checking instead of assuming keeps this module working
// unchanged when one appears; a non-object export is ignored rather than spread into the flat
// object.
if (crypto !== null && crypto.constants !== null && typeof crypto.constants === "object") {
  Object.assign(constants, crypto.constants);
}

// Node freezes the flat module; so does this one, so callers cannot mutate a shared constant.
module.exports = Object.freeze(constants);
