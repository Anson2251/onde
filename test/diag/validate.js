"use strict";

// Validator for test/diag/run.sh: the trace file has to be a Chrome trace with the vocabulary
// m7-plan §3.4 promises, not merely "some JSON".
//
//   node test/diag/validate.js <trace.json>
//
// Checks: it parses; `process_name` is first; every event has name/cat/ph/ts/pid/tid; phases are
// complete events with a non-negative duration; the last event is the exit turn; and the required
// names for test/diag/workload.js are present (timer, completion, wait, exit, at least one op).
// The gc event is required because the workload is shaped to make it observable; *when* it lands
// is the engine's decision, which is D69.

const fs = require("fs");

const path = process.argv[2];
if (!path) {
    console.error("usage: validate.js <trace.json>");
    process.exit(2);
}

let document;
try {
    document = JSON.parse(fs.readFileSync(path, "utf8"));
} catch (error) {
    console.error(`validate: not JSON: ${error.message}`);
    process.exit(1);
}

const events = document.traceEvents;
if (!Array.isArray(events) || events.length === 0) {
    console.error("validate: no traceEvents array");
    process.exit(1);
}

const failures = [];
const fail = (message) => failures.push(message);

if (events[0].name !== "process_name" || events[0].cat !== "__metadata") {
    fail(`first event is ${events[0].name}/${events[0].cat}, want process_name/__metadata`);
}

for (const [index, event] of events.entries()) {
    if (typeof event.name !== "string" || typeof event.cat !== "string") {
        fail(`event ${index} has no name/cat`);
        continue;
    }
    if (event.ph !== "X" && event.ph !== "i")
        fail(`event ${index} (${event.name}) has ph ${event.ph}`);
    if (typeof event.ts !== "number" || event.ts < 0)
        fail(`event ${index} (${event.name}) has ts ${event.ts}`);
    if (typeof event.pid !== "number" || typeof event.tid !== "number") {
        fail(`event ${index} (${event.name}) has no pid/tid lane`);
    }
    if (event.ph === "X" && (typeof event.dur !== "number" || event.dur < 0)) {
        fail(`event ${index} (${event.name}) has dur ${event.dur}`);
    }
}

const names = events.map((event) => event.name);
for (const required of ["timer", "completion", "wait", "exit"]) {
    if (!names.includes(required)) fail(`no ${required} event`);
}
if (!events.some((event) => event.cat === "op")) fail("no op event");
if (names[names.length - 1] !== "exit") fail(`last event is ${names[names.length - 1]}, want exit`);

const gc = events.filter((event) => event.name === "gc").length;
// The workload holds an allocation across turns specifically so this is observable; a gc event is
// required when --trace-gc was passed (the harness always passes it).
if (gc === 0) fail("no gc event");
const ops = [...new Set(events.filter((event) => event.cat === "op").map((event) => event.name))];

if (failures.length > 0) {
    for (const failure of failures) console.error(`validate: ${failure}`);
    process.exit(1);
}
console.log(
    `RESULT events=${events.length} ops=${ops.join(",")} gc_events=${gc} lanes=${new Set(events.map((e) => e.tid)).size}`,
);
