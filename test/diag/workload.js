// Workload for test/diag/run.sh: one of each thing the trace is supposed to show.
//
// A timer turn, an async `fs` op (completion phase and an `op` event), an HTTP request (handle
// events delivered in the completion phase), and enough allocation churn that a sampled collection
// is likely — the gc event is the one assertion the harness treats as advisory, because it depends
// on the engine's own collection schedule (D69).
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const file = path.join(os.tmpdir(), `ln-diag-${process.pid}.txt`);
fs.writeFileSync(file, "x".repeat(4096));

const server = http.createServer((req, res) => res.end("ok"));
server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    fs.readFile(file, () => {
        http.get({ host: "127.0.0.1", port, path: "/" }, (response) => {
            response.resume();
            response.on("end", () => {
                // Held in a global across a turn boundary on purpose: QuickJS refcounts, so freeing inside
                // one turn leaves no sample that could observe the drop (the gc event is sampled at turn
                // boundaries, D69). This shape is what makes the assertion deterministic.
                globalThis.__diagHeld = [];
                setTimeout(() => {
                    for (let i = 0; i < 4 * 1024; i += 1) {
                        globalThis.__diagHeld.push(new Array(1024).fill(i));
                    }
                    setTimeout(() => {
                        globalThis.__diagHeld = null;
                        setTimeout(() => {
                            server.close();
                            fs.unlinkSync(file);
                            console.log("done");
                        }, 1);
                    }, 1);
                }, 1);
            });
        });
    });
});
