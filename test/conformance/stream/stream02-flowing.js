"use strict";
// Flowing mode: data/end/close ordering and readableFlowing.
const { Readable } = require("stream");

const r = new Readable({ read() {} });
const events = [];
r.on("data", (chunk) => events.push("data:" + String(chunk)));
r.on("end", () => events.push("end"));
r.on("close", () => {
    events.push("close");
    console.log(events.join("|"));
});
r.push("a");
r.push("b");
r.push(null);
console.log("flowing", r.readableFlowing);
