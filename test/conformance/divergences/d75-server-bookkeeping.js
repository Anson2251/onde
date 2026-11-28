// Divergence D75: onde's server bookkeeping drains exactly once — every accepted socket leaves the
// tracked set when it closes — and the first-head sweep keeps running after `server.close()`, so a
// peer that was half-open at close is still reclaimed at its deadline. Node exposes no equivalent
// internals (it uses a per-socket timer), so this is recorded from onde rather than mirrored.
const http = require("http");
const net = require("net");

function halfOpen(port, count, out) {
    for (let i = 0; i < count; i += 1) {
        const socket = net.connect(port, "127.0.0.1", () => {
            socket.write("GET / HTTP/1.1\r\nHost: example\r\nX-Partial: ");
        });
        socket.on("error", () => {});
        out.push(socket);
    }
}

function drainingPhase(next) {
    const server = http.createServer({ headersTimeout: 5000 }, (req, res) => res.end("ok"));
    server.listen(0, "127.0.0.1", () => {
        const sockets = [];
        halfOpen(server.address().port, 20, sockets);
        setTimeout(() => {
            console.log("tracked", server._sockets.size > 0);
            for (const socket of sockets) socket.destroy();
            setTimeout(() => {
                console.log("drained", server._sockets.size === 0);
                server.close(() => {});
                next();
            }, 300);
        }, 200);
    });
}

function closePhase() {
    const server = http.createServer({ headersTimeout: 300 }, (req, res) => res.end("ok"));
    server.listen(0, "127.0.0.1", () => {
        const sockets = [];
        halfOpen(server.address().port, 1, sockets);
        const peer = sockets[0];
        setTimeout(() => {
            let closed = false;
            peer.on("close", () => {
                closed = true;
            });
            server.close();
            setTimeout(() => {
                console.log("close-reclaimed", closed);
                console.log("sockets-after-close", server._sockets.size);
                process.exit(0);
            }, 1500);
        }, 100);
    });
}

drainingPhase(closePhase);
