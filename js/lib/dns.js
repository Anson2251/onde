"use strict";

// node:dns — `lookup` only.
//
// `dns.lookup` is an op, not a handle (`docs/m4-plan.md` §2.6): the OS resolver runs on the
// blocking pool in Rust (`host.dnsAsync`), and this file is the Node-shaped surface over it —
// argument normalization, the callback/promise split and the constants. `dns.resolve*` needs a
// DNS client rather than `getaddrinfo` and stays out of M4; `lookupService` is not implemented.
//
// Gaps recorded for M4: `hints` is accepted and ignored (ADDRCONFIG/V4MAPPED semantics need
// platform-specific address selection), `options.verbatim` is not consulted (the resolver's order
// is preserved as-is), and `options.order` does not exist yet.

const { coded: codedError, invalidArgType, invalidArgValue } = require("./internal/errors.js");

// --- argument helpers ------------------------------------------------------------------------

function invalidFamily(family) {
    return codedError(
        TypeError,
        "ERR_INVALID_ARG_VALUE",
        `The property 'options.family' must be one of: 0, 4, 6. Received ${family}`,
    );
}

// `0` (either), `4`, `6`; the string aliases Node accepts are normalized here. The Rust side only
// sees the numeric form.
function normalizeFamily(family) {
    if (family === undefined || family === null || family === 0) return 0;
    if (family === 4 || family === "4" || family === "IPv4") return 4;
    if (family === 6 || family === "6" || family === "IPv6") return 6;
    throw invalidFamily(typeof family === "string" ? `'${family}'` : family);
}

// Node treats a number for `options` as `{ family }`, and rejects any other non-object.
function normalizeOptions(options) {
    if (options === undefined || options === null) return { family: 0, all: false };
    if (typeof options === "number") return { family: normalizeFamily(options), all: false };
    if (typeof options !== "object") {
        throw codedError(
            TypeError,
            "ERR_INVALID_ARG_TYPE",
            `The "options" argument must be of type object or integer. Received type ${typeof options}`,
        );
    }
    return { family: normalizeFamily(options.family), all: options.all === true };
}

function validateHostname(hostname) {
    if (typeof hostname !== "string") {
        throw invalidArgType("hostname", "string", hostname);
    }
    if (hostname.length === 0) {
        throw invalidArgValue("hostname", hostname, "must be a non-empty string");
    }
}

function submitLookup(hostname, family, all, callback) {
    const bridge = globalThis.__ln_dns_op;
    if (typeof bridge !== "function") {
        throw codedError(
            Error,
            "ERR_IO_BRIDGE",
            "onde: the async op bridge (__ln_dns_op) is not installed",
        );
    }
    bridge(hostname, family, all, { callback });
}

// --- lookup ----------------------------------------------------------------------------------

// `dns.lookup(hostname[, options], callback)`.
//
// The callback receives `(err, address, family)` for the single-result form and `(err, addresses)`
// for `{ all: true }`, exactly like Node. `family` is Node's numeric `4`/`6`, not the string
// `socket.address()` uses.
function lookup(hostname, options, callback) {
    let opts = options;
    let cb = callback;
    if (typeof opts === "function") {
        cb = opts;
        opts = undefined;
    }
    if (typeof cb !== "function") throw invalidArgType("callback", "function", cb);
    validateHostname(hostname);
    const settings = normalizeOptions(opts);

    submitLookup(hostname, settings.family, settings.all, (error, addresses) => {
        if (error !== null && error !== undefined) {
            cb(error);
            return;
        }
        if (settings.all) {
            cb(null, addresses);
            return;
        }
        const first = addresses[0];
        cb(null, first.address, first.family);
    });
}

// `dns.promises.lookup(hostname[, options])`: `{ address, family }` single, or an array with
// `{ all: true }`.
function lookupAsync(hostname, options) {
    return new Promise((resolve, reject) => {
        lookup(hostname, options, (error, addresses, family) => {
            if (error !== null && error !== undefined) {
                reject(error);
                return;
            }
            if (Array.isArray(addresses)) {
                resolve(addresses);
                return;
            }
            resolve({ address: addresses, family });
        });
    });
}

// --- constants -------------------------------------------------------------------------------

// Node's values: the hint flags are bit flags, the error-name constants are the strings
// `dns.resolve*` would use (kept for shape compatibility even though only `lookup` exists).
const constants = {
    NODATA: "ENODATA",
    FORMERR: "EFORMERR",
    SERVFAIL: "ESERVFAIL",
    NOTFOUND: "ENOTFOUND",
    NOTIMP: "ENOTIMP",
    REFUSED: "EREFUSED",
    BADQUERY: "EBADQUERY",
    BADNAME: "EBADNAME",
    BADFAMILY: "EBADFAMILY",
    BADRESP: "EBADRESP",
    CONNREFUSED: "ECONNREFUSED",
    TIMEOUT: "ETIMEOUT",
    EOF: "EOF",
    FILE: "EFILE",
    NOMEM: "ENOMEM",
    DESTRUCTION: "EDESTRUCTION",
    BADSTR: "EBADSTR",
    BADFLAGS: "EBADFLAGS",
    NONAME: "ENONAME",
    BADHINTS: "EBADHINTS",
    NOTINITIALIZED: "ENOTINITIALIZED",
    LOADIPHLPAPI: "ELOADIPHLPAPI",
    ADDRGETNETWORKPARAMS: "EADDRGETNETWORKPARAMS",
    CANCELLED: "ECANCELLED",
};

// Lookup hints. Accepted by `lookup` and currently ignored by the resolver, but the values are the
// platform's own `getaddrinfo` flags, which is what Node reports: glibc uses 0x20/0x08/0x10 and the
// BSDs 0x400/0x800/0x100. The host publishes them from libc; the fallback is the BSD set, for the
// differential harness where the host is absent.
const hints = (() => {
    const host = globalThis.__ln_host;
    const published = host === undefined || host === null ? undefined : host.dnsHints;
    if (published !== undefined && published !== null) {
        return {
            ADDRCONFIG: published.addrconfig,
            V4MAPPED: published.v4mapped,
            ALL: published.all,
        };
    }
    return { ADDRCONFIG: 1024, V4MAPPED: 2048, ALL: 256 };
})();

module.exports = {
    lookup,
    promises: { lookup: lookupAsync },
    ...hints,
    ...constants,
};
