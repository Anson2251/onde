"use strict";

// The symlink race (ADR-0011 §4.7, §7). `safe` is inside the granted directory and the reader has
// `fs.read` on it; the swapper alternates it between a regular file and a symlink to `secret`,
// which lives outside the grant. An async read must either get "SAFE", be denied (the resolved
// path left the grant) or fail with ELOOP (O_NOFOLLOW caught a swap after the check). It must
// never return the secret.
//
// argv[2] and argv[3] are the paths; the harness passes them because `env.read` may be denied.

const fs = require("fs");
const safe = process.argv[2];
const secret = process.argv[3];
if (!safe || !secret) {
    console.error("race: expected SAFE and SECRET paths");
    process.exit(2);
}

const MAX_READS = 400;
let reads = 0;
let leaks = 0;
let odd = 0;
let asLink = false;

const timer = setInterval(() => {
    try {
        fs.unlinkSync(safe);
    } catch (_) {}
    if (asLink) {
        try {
            fs.symlinkSync(secret, safe);
        } catch (_) {}
    } else {
        try {
            fs.writeFileSync(safe, "SAFE");
        } catch (_) {}
    }
    asLink = !asLink;
}, 0);

function finish() {
    clearInterval(timer);
    console.log(`race: ${reads} reads, ${leaks} leaks, ${odd} unexpected errors`);
    process.exit(leaks === 0 && odd === 0 ? 0 : 1);
}

function next() {
    if (reads >= MAX_READS) {
        finish();
        return;
    }
    reads += 1;
    fs.readFile(safe, "utf8", (error, data) => {
        if (error) {
            if (!["ERR_ACCESS_DENIED", "ELOOP", "ENOENT", "EACCES"].includes(error.code)) odd += 1;
        } else if (data.includes("SECRET")) {
            leaks += 1;
        }
        next();
    });
}

next();
