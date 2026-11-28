"use strict";

// Differential self-check for `node:dns` (`lookup` only).
//
// Runs unchanged under node and onde: both resolve `require("dns")` to the module surface, so the
// assertions have to hold for Node and for onde. Nothing here prints a resolved address, a port or
// a timing: only types, the numeric family and the error code are asserted, so the output is
// deterministic on every machine.
//
//   node test/js/lib/dns.test.js
//   ./target/debug/onde test/js/lib/dns.test.js
//   ./test/js/run.sh

const dns = require("dns");

let passed = 0;
const failures = [];

function record(condition, message) {
    if (condition) {
        passed += 1;
    } else {
        failures.push(message);
    }
}

function finish() {
    if (failures.length === 0) {
        console.log(`ok: ${passed} assertions`);
        process.exit(0);
    }
    for (const failure of failures) console.log(`not ok: ${failure}`);
    process.exit(1);
}

function hasError(error) {
    return error !== null && error !== undefined;
}

// A name that cannot resolve must report a resolution failure. Which code surfaces depends on the
// resolver rather than on the runtime: ENOTFOUND when the name does not exist, EAI_AGAIN when the
// resolver itself is unreachable, which is the normal state of a GitHub Actions container.
const RESOLUTION_FAILURES = ["ENOTFOUND", "EAI_AGAIN"];

function isResolutionFailure(error) {
    return hasError(error) && RESOLUTION_FAILURES.includes(error.code);
}

// --- shape -----------------------------------------------------------------------------------

record(typeof dns.lookup === "function", "dns.lookup is a function");
record(dns.promises !== null && typeof dns.promises === "object", "dns.promises is an object");
record(typeof dns.promises.lookup === "function", "dns.promises.lookup is a function");

// Node's numeric hint flags and error-name constants.
// `getaddrinfo` flags, so the values are the platform's: glibc (Linux) uses 0x20/0x08/0x10 and the
// BSDs (macOS) and Windows use 0x400/0x800/0x100. Node reports the same numbers, which is what
// makes this a differential check rather than a hardcoded one.
const EXPECTED_HINTS =
    process.platform === "linux"
        ? { ADDRCONFIG: 32, V4MAPPED: 8, ALL: 16 }
        : { ADDRCONFIG: 1024, V4MAPPED: 2048, ALL: 256 };
record(
    dns.ADDRCONFIG === EXPECTED_HINTS.ADDRCONFIG,
    `ADDRCONFIG is ${EXPECTED_HINTS.ADDRCONFIG} on ${process.platform} (got ${dns.ADDRCONFIG})`,
);
record(
    dns.V4MAPPED === EXPECTED_HINTS.V4MAPPED,
    `V4MAPPED is ${EXPECTED_HINTS.V4MAPPED} on ${process.platform} (got ${dns.V4MAPPED})`,
);
record(
    dns.ALL === EXPECTED_HINTS.ALL,
    `ALL is ${EXPECTED_HINTS.ALL} on ${process.platform} (got ${dns.ALL})`,
);
record(dns.NODATA === "ENODATA", `NODATA is ENODATA (got ${dns.NODATA})`);
record(dns.NOTFOUND === "ENOTFOUND", `NOTFOUND is ENOTFOUND (got ${dns.NOTFOUND})`);
record(dns.CANCELLED === "ECANCELLED", `CANCELLED is ECANCELLED (got ${dns.CANCELLED})`);

// --- single-result lookup --------------------------------------------------------------------

dns.lookup("localhost", (error, address, family) => {
    record(!hasError(error), `localhost lookup failed: ${error && error.message}`);
    record(typeof address === "string", `address is a string (got ${typeof address})`);
    record(family === 4 || family === 6, `family is 4 or 6 (got ${family})`);

    // --- requested family ---------------------------------------------------------------------

    dns.lookup("localhost", { family: 4 }, (error4, address4, family4) => {
        record(!hasError(error4), `family:4 lookup failed: ${error4 && error4.message}`);
        record(typeof address4 === "string", `family:4 address is a string`);
        record(family4 === 4, `family:4 returns family 4 (got ${family4})`);

        // --- all: true --------------------------------------------------------------------------

        dns.lookup("localhost", { all: true }, (errorAll, addresses) => {
            record(!hasError(errorAll), `all lookup failed: ${errorAll && errorAll.message}`);
            record(Array.isArray(addresses), `all:true returns an array (got ${typeof addresses})`);
            const list = Array.isArray(addresses) ? addresses : [];
            record(list.length > 0, "all:true returns at least one address");
            record(
                list.every(
                    (entry) =>
                        entry !== null &&
                        typeof entry.address === "string" &&
                        (entry.family === 4 || entry.family === 6),
                ),
                "every all:true entry is { address: string, family: 4|6 }",
            );

            // --- ENOTFOUND ------------------------------------------------------------------------

            // `.invalid` is reserved (RFC 2606) and never resolves, so this is deterministic.
            dns.lookup("does-not-exist.invalid", (missingError, missingAddress) => {
                record(hasError(missingError), "an unresolvable host produces an error");
                record(
                    isResolutionFailure(missingError),
                    `the error code is a resolution failure, ENOTFOUND or EAI_AGAIN (got ${missingError && missingError.code})`,
                );
                record(missingAddress === undefined, "the address argument is undefined on error");

                // --- promises ---------------------------------------------------------------------

                dns.promises
                    .lookup("localhost")
                    .then((result) => {
                        record(
                            result !== null &&
                                typeof result === "object" &&
                                typeof result.address === "string" &&
                                (result.family === 4 || result.family === 6),
                            "dns.promises.lookup resolves { address, family }",
                        );
                        return dns.promises.lookup("does-not-exist.invalid").then(
                            () => record(false, "dns.promises.lookup should reject for .invalid"),
                            (promiseError) =>
                                record(
                                    isResolutionFailure(promiseError),
                                    `promise rejection code is a resolution failure (got ${promiseError && promiseError.code})`,
                                ),
                        );
                    })
                    .then(
                        () => finish(),
                        (unexpected) => {
                            record(
                                false,
                                `promise chain failed: ${unexpected && unexpected.message}`,
                            );
                            finish();
                        },
                    );
            });
        });
    });
});
