#!/usr/bin/env node
"use strict";

// Thin launcher so `node bin/tuckbox.js` and `lite bin/tuckbox.js` both work, with a readable
// error when the TypeScript has not been compiled yet.

let run;
try {
  ({ run } = require("../dist/cli.js"));
} catch (error) {
  if (error && error.code === "MODULE_NOT_FOUND" && /dist[\\/]cli/.test(String(error.message))) {
    process.stderr.write("tuckbox: dist/ is missing - run `pnpm build` first\n");
    process.exit(1);
  }
  throw error;
}

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`tuckbox: ${error && error.message ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
