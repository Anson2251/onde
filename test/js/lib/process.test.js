"use strict";

// Regression for defect D5: `process.stdin` pipe chunks must be `Buffer`s, as in Node, so
// `chunk + ""` is the bytes as text ("hi\n") instead of a Uint8Array's "104,105,10".
//
// `test/js/run.sh` runs this file under node and under onde. The runner gives the test process no
// stdin to read, so the case spawns the runtime under test (`process.execPath`) and pipes bytes to
// it. Under node the assertions pin Node's behaviour; under onde they pin the fix.
//
//   ./target/debug/onde test/js/lib/process.test.js

const { spawn } = require("child_process");

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
    if (condition) {
        passed += 1;
        return;
    }
    failed += 1;
    console.log(`not ok - ${name}${detail === undefined ? "" : `: ${detail}`}`);
}

// `void 0;` keeps onde's `-e` from printing the script's completion value (D11); Node prints
// nothing either way.
const script = [
    "let text = '';",
    "let buffers = true;",
    "process.stdin.on('data', (chunk) => {",
    "  if (!Buffer.isBuffer(chunk)) buffers = false;",
    "  text += chunk;",
    "});",
    "process.stdin.on('end', () => {",
    "  console.log(JSON.stringify(text), buffers);",
    "});",
    "void 0;",
].join("\n");

const child = spawn(process.execPath, ["-e", script]);
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
    stdout += chunk;
});
child.stderr.on("data", (chunk) => {
    stderr += chunk;
});
child.on("close", (code) => {
    check(
        "piped stdin chunks are Buffers and concatenate as text",
        stdout === '"hi\\n" true\n',
        `stdout ${JSON.stringify(stdout)}`,
    );
    check("child exits cleanly", code === 0, `exit ${code}`);
    check("child writes no stderr", stderr === "", `stderr ${JSON.stringify(stderr)}`);
    console.log(`process.test.js: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
});
child.stdin.end("hi\n");
