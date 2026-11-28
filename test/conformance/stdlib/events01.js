"use strict";
const { EventEmitter, once, errorMonitor } = require("events");
const emitter = new EventEmitter();
emitter.on("x", (value) => console.log("a", value));
emitter.once("x", (value) => console.log("once", value));
emitter.emit("x", 1);
emitter.emit("x", 2);
emitter.prependListener("y", () => console.log("pre"));
emitter.on("y", () => console.log("post"));
emitter.emit("y");
console.log(emitter.listenerCount("x"));
emitter.removeAllListeners("x");
console.log(emitter.listenerCount("x"));
try {
    emitter.emit("error", new Error("boom"));
} catch (error) {
    console.log("threw", error.message);
}
const monitored = new EventEmitter();
monitored.on(errorMonitor, () => console.log("monitor"));
monitored.on("error", (error) => console.log("handled", error.message));
monitored.emit("error", new Error("x"));
once(monitored, "ready").then((args) => console.log("once-resolved", args[0]));
monitored.emit("ready", 42);
