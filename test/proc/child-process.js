// M5 acceptance: child_process against the runtime named by RUNTIME (node or onde).
"use strict";
const path = require("path");
const { spawn, exec, execFile, fork } = require("child_process");

const runtime = process.env.RUNTIME || process.execPath;
const fixture = path.join(__dirname, "fixtures", "identity.js");
const echo = path.join(__dirname, "fixtures", "echo-stdin.js");
const forkChild = path.join(__dirname, "fixtures", "fork-child.js");
let failures = 0;
function check(label, actual, expected) {
    if (actual === expected) {
        console.log(`ok ${label}`);
    } else {
        failures += 1;
        console.log(`not ok ${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
    }
}

const usage = process.cpuUsage();
check(
    "cpuUsage shape",
    typeof usage.user === "number" &&
        usage.user >= 0 &&
        typeof usage.system === "number" &&
        usage.system >= 0,
    true,
);
const delta = process.cpuUsage(usage);
check("cpuUsage delta", delta.user >= 0 && delta.system >= 0, true);

function runSpawn(label, args, options, onClose) {
    const child = spawn(runtime, args, options);
    let stdout = "";
    let stderr = "";
    if (child.stdout)
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
        });
    if (child.stderr)
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
    child.on("close", (code, signal) => onClose({ stdout, stderr, code, signal }));
    return child;
}

const queue = [];
function step(fn) {
    queue.push(fn);
}
function next() {
    const fn = queue.shift();
    if (fn === undefined) {
        console.log(failures === 0 ? "child-process: ok" : `child-process: ${failures} failed`);
        process.exitCode = failures === 0 ? 0 : 1;
        return;
    }
    fn(next);
}

step((done) => {
    runSpawn(
        "identity",
        [fixture, "a", "b"],
        { env: { ...process.env, PROC_FIXTURE_ENV: "yes" } },
        ({ stdout, code }) => {
            const lines = stdout.trim().split("\n");
            check("argv", lines[0], 'argv:["a","b"]');
            check("cwd", lines[1], `cwd:${process.cwd()}`);
            check("env", lines[2], "env:yes");
            check("exit", code, 0);
            done();
        },
    );
});

step((done) => {
    const child = spawn(runtime, ["-e", "process.exit(7)"]);
    const events = [];
    child.on("exit", (code) => events.push(`exit:${code}`));
    child.on("close", (code) => {
        events.push(`close:${code}`);
        check("exit before close", events.join(","), "exit:7,close:7");
        done();
    });
});

step((done) => {
    // The fixture echoes stdin and prints `[eof]` when the pipe closes, so the write order and the
    // EOF are both asserted.
    const child = spawn(runtime, [echo]);
    let stdout = "";
    child.stdout.on("data", (chunk) => {
        stdout += chunk;
    });
    child.on("close", (code) => {
        check("stdin echo", stdout, "hello\n[eof]");
        check("stdin exit", code, 0);
        done();
    });
    child.stdin.write("hello\n");
    child.stdin.end();
});

step((done) => {
    exec("printf abc; printf err >&2; exit 2", (error, stdout, stderr) => {
        check("exec stdout", stdout, "abc");
        check("exec stderr", stderr, "err");
        check("exec code", error && error.code, 2);
        done();
    });
});

step((done) => {
    execFile(runtime, ["-e", "process.stdout.write('file'); process.exit(0)"], (error, stdout) => {
        check("execFile stdout", stdout, "file");
        check("execFile error", error, null);
        done();
    });
});

step((done) => {
    const child = spawn(runtime, ["-e", "setInterval(() => {}, 1000)"]);
    child.on("spawn", () => {
        child.kill("SIGTERM");
    });
    child.on("exit", (code, signal) => {
        check("kill signal", signal, "SIGTERM");
        done();
    });
});

step((done) => {
    const child = spawn("definitely-not-a-program-onde", []);
    const events = [];
    child.on("error", (error) => events.push(`error:${error.code}`));
    child.on("close", (code) => {
        events.push(`close:${code}`);
        check("spawn error", events.join(","), "error:ENOENT,close:-2");
        done();
    });
});

step((done) => {
    const child = fork(forkChild, [], { silent: true });
    const messages = [];
    child.on("message", (message) => {
        messages.push(JSON.stringify(message));
        if (message && message.ready) child.send("hi");
        else if (message && message.echo === "hi") child.send("bye");
    });
    child.on("disconnect", () => {});
    child.on("exit", (code) => {
        check("fork messages", messages.join(","), '{"ready":true},{"echo":"hi"},{"echo":"bye"}');
        check("fork exit", code, 0);
        done();
    });
});

next();
