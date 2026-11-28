// M5 acceptance: stdio and process-event ordering, run under node and onde.
"use strict";
const { spawn } = require("child_process");
const runtime = process.env.RUNTIME || process.execPath;
let failures = 0;
function check(label, actual, expected) {
    if (actual === expected) console.log(`ok ${label}`);
    else {
        failures += 1;
        console.log(`not ok ${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
    }
}

const child = spawn(runtime, [
    "-e",
    "process.stdout.write('one'); process.stderr.write('two'); process.exit(4)",
]);
const order = [];
child.stdout.on("data", () => order.push("stdout"));
child.stderr.on("data", () => order.push("stderr"));
child.on("exit", (code) => order.push(`exit:${code}`));
child.on("close", (code) => {
    order.push(`close:${code}`);
    // stdout/stderr order between two pipes is not guaranteed; the stream set and the process
    // events are. Node and onde both deliver exit before close and both pipes before both.
    check(
        "stream set",
        [...new Set(order.filter((item) => item === "stdout" || item === "stderr"))]
            .sort()
            .join(","),
        "stderr,stdout",
    );
    check("exit code", code, 4);
    check("close last", order[order.length - 1], "close:4");
    const exitIndex = order.findIndex((item) => item.startsWith("exit:"));
    const closeIndex = order.findIndex((item) => item.startsWith("close:"));
    check("exit before close", exitIndex >= 0 && exitIndex < closeIndex, true);
    console.log(failures === 0 ? "ordering: ok" : `ordering: ${failures} failed`);
    process.exitCode = failures === 0 ? 0 : 1;
});
