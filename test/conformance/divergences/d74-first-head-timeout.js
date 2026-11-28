// Divergence D74: onde reclaims a connection whose first request head never completes, and a
// connection `server.timeout` covers, at the configured deadline. Node held both when measured
// (a 300 ms `headersTimeout` left a partial head open past 5 s, and `timeout` only emitted
// `'timeout'` without closing), so this is recorded rather than mirrored: an idle peer that costs
// a file descriptor forever is the case the slow-loris bound is about.
const http = require("http");
const net = require("net");

function probe(options, sendPartialHead, label, done) {
    const server = http.createServer(options, (req, res) => res.end("ok"));
    server.listen(0, "127.0.0.1", () => {
        const socket = net.connect(server.address().port, "127.0.0.1", () => {
            if (sendPartialHead) socket.write("GET / HTTP/1.1\r\nHost: example\r\nX-Partial: ");
        });
        let closed = false;
        socket.on("close", () => {
            closed = true;
        });
        socket.on("error", () => {});
        // Generous window: the deadline is 300 ms and what is being asserted is "it happens", not when.
        setTimeout(() => {
            console.log(`${label} "${closed}"`);
            socket.destroy();
            server.close(done);
        }, 1200);
    });
}

probe({ headersTimeout: 300 }, true, "headers-timeout-closed", () => {
    probe({ timeout: 300 }, false, "server-timeout-closed", () => {});
});
