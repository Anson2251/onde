"use strict";
// finished: success, stream error and premature close, awaited in order.
const { Readable, finished } = require("stream");

function wait(stream) {
    return new Promise((resolve) => finished(stream, (err) => resolve(err)));
}

(async () => {
    const clean = new Readable({ read() {} });
    const cleanPending = wait(clean);
    clean.resume();
    clean.push(null);
    const cleanError = await cleanPending;
    console.log("clean", cleanError === undefined);

    const failing = new Readable({ read() {} });
    failing.on("error", () => {});
    const failingPending = wait(failing);
    failing.destroy(new Error("x"));
    const failingError = await failingPending;
    console.log("error", failingError && failingError.message);

    const premature = new Readable({ read() {} });
    const prematurePending = wait(premature);
    premature.destroy();
    const prematureError = await prematurePending;
    console.log("premature", prematureError && prematureError.code);
})();
