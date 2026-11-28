"use strict";
// Writable callbacks, finish/close ordering and a drain after backpressure.
const { Writable } = require("stream");

const events = [];
const w = new Writable({
    write(chunk, encoding, callback) {
        events.push("write:" + String(chunk) + ":" + encoding);
        callback();
    },
});
w.on("finish", () => events.push("finish"));
w.on("close", () => events.push("close"));
w.write("a", () => events.push("cb"));
w.end("b", () => events.push("endcb"));
w.on("close", () => console.log(events.join("|")));

const slow = new Writable({
    highWaterMark: 4,
    write(chunk, encoding, callback) {
        setTimeout(callback, 2);
    },
});
console.log("slow", slow.write("aa"), slow.write("bb"), slow.writableNeedDrain);
slow.on("drain", () => {
    console.log("drain", slow.writableNeedDrain, slow.writableLength);
    slow.end("cc");
});
slow.on("finish", () => console.log("slow finish", slow.writableFinished));
