"use strict";

// The client surface: three `http.get` calls over the global Agent. The next request is issued
// on a later tick, which is when Node's Agent has moved the completed socket to its free pool;
// one server-side connection for all three proves the reuse. `req.reusedSocket` is printed too.

const http = require("http");

const connections = new Set();

const server = http.createServer((req, res) => {
    connections.add(req.socket.remotePort);
    res.setHeader("Content-Type", "text/plain");
    res.end(`reply:${req.url}`);
});

server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    let count = 0;

    function go() {
        const path = count === 0 ? "/first" : count === 1 ? "/second" : "/third";
        const req = http.get({ host: "127.0.0.1", port, path }, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
                body += chunk;
            });
            res.on("end", () => {
                console.log(`status:${res.statusCode}`);
                console.log(`content-type:${res.headers["content-type"]}`);
                console.log(`complete:${res.complete}`);
                console.log(`body:${body}`);
                console.log(`reused:${req.reusedSocket === true}`);
                count += 1;
                if (count < 3) {
                    setTimeout(go, 10);
                } else {
                    console.log(`connections:${connections.size}`);
                    http.globalAgent.destroy();
                    server.close();
                }
            });
        });
        req.on("error", (error) => {
            console.log(`error:${error.code}`);
            http.globalAgent.destroy();
            server.close();
        });
    }

    go();
});
