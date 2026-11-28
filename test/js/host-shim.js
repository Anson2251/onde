"use strict";

// A `globalThis.__ln_host` implementation backed by Node's own APIs.
//
// Stdlib modules are plain CommonJS, so they can be tested under `node` with:
//
//   globalThis.__ln_host = require("../../test/js/host-shim.js")();
//   const path = require("../../js/lib/path.js");
//
// This is a test seam only. The real host lives in `crates/ln-runtime`; if a member is added
// there, add it here too or the shim will drift.

const fs = require("node:fs");
const os = require("node:os");

function createHost(overrides = {}) {
    const base = {
        // Raw: the real host writes exactly the bytes it is given. console/process streams add
        // their own newline (see js/README.md).
        write(text, isErr) {
            (isErr ? process.stderr : process.stdout).write(String(text));
        },
        exit(code) {
            process.exit(code);
        },
        setExitCode(code) {
            process.exitCode = code;
        },

        argv: process.argv.slice(),
        platform: process.platform,
        pid: process.pid,
        ppid: process.ppid,
        version: "v" + process.versions.node,

        env() {
            return { ...process.env };
        },
        cwd() {
            return process.cwd();
        },
        chdir(target) {
            process.chdir(target);
        },
        hrtimeNs() {
            return process.hrtime.bigint();
        },
        memoryUsage() {
            const usage = process.memoryUsage();
            return {
                rss: usage.rss,
                heapTotal: usage.heapTotal,
                heapUsed: usage.heapUsed,
                external: usage.external,
                arrayBuffers: usage.arrayBuffers,
            };
        },
        osInfo() {
            const info = os.userInfo();
            return {
                platform: process.platform,
                arch: process.arch,
                type: os.type(),
                release: os.release(),
                endianness: os.endianness(),
                homedir: os.homedir(),
                tmpdir: os.tmpdir(),
                hostname: os.hostname(),
                shell: process.env.SHELL || null,
                username: info.username,
                uid: typeof info.uid === "number" ? info.uid : -1,
                gid: typeof info.gid === "number" ? info.gid : -1,
                cpus: os.cpus().length,
                totalmem: os.totalmem(),
                freemem: os.freemem(),
                uptime: os.uptime(),
            };
        },
        isTTY(fd) {
            const stream = fd === 0 ? process.stdin : fd === 1 ? process.stdout : process.stderr;
            return Boolean(stream && stream.isTTY);
        },
        columns(fd) {
            const stream = fd === 0 ? process.stdin : fd === 1 ? process.stdout : process.stderr;
            return stream && stream.columns ? stream.columns : 0;
        },

        readFile(target) {
            return fs.readFileSync(target, "utf8");
        },
        realpath(target) {
            return fs.realpathSync(target);
        },
        statKind(target) {
            try {
                const stat = fs.statSync(target);
                return stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "other";
            } catch (_) {
                return null;
            }
        },
        builtinSource() {
            return null;
        },
        builtinNames() {
            return [];
        },

        // Module loading is runtime work; the shim only needs the read side, and Node's own
        // require is a fine stand-in for tests that need to load a fixture.
        cjsNamespace(target) {
            return require(target);
        },
        builtinExports(name) {
            return require(name);
        },

        // The loader primitives are installed by ln-runtime. Tests that reach them are integration
        // tests and must not run under the shim.
        resolve() {
            throw new Error("host.resolve is provided by onde");
        },
        evalCjs() {
            throw new Error("host.evalCjs is provided by onde");
        },
    };

    return Object.assign(base, overrides);
}

module.exports = createHost;
