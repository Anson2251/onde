"use strict";

// The `tls` module itself: `tls.createServer` + `tls.connect`, an ALPN protocol, and the
// `secureConnection` event. Printed in a fixed order (client, echo, server) so neither runtime's
// event ordering leaks into the output.

const tls = require("tls");
const fs = require("fs");
const path = require("path");

const fixtures = path.join(__dirname, "../../fixtures/tls");
const key = fs.readFileSync(path.join(fixtures, "server-key.pem"));
const cert = fs.readFileSync(path.join(fixtures, "server-cert.pem"));
const ca = fs.readFileSync(path.join(fixtures, "ca-cert.pem"));

let serverLine = "server:none";

const server = tls.createServer({ key, cert, ALPNProtocols: ["echo"] }, (socket) => {
    socket.on("error", () => {});
    socket.pipe(socket);
});
server.on("secureConnection", (socket) => {
    serverLine = `server:${socket.encrypted}:${socket.authorized}:${socket.alpnProtocol}:${socket
        .getProtocol()
        .startsWith("TLSv")}`;
});

server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    const socket = tls.connect(
        { host: "127.0.0.1", port, ca, ALPNProtocols: ["echo"], servername: "localhost" },
        () => {
            console.log(
                `client:${socket.encrypted}:${socket.authorized}:${socket.alpnProtocol}:${socket
                    .getProtocol()
                    .startsWith("TLSv")}:${socket.servername}`,
            );
            console.log(`sessionReused:${socket.isSessionReused()}`);
            socket.write("ping");
        },
    );
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
        console.log(`echo:${chunk}`);
        socket.end();
    });
    socket.on("error", (error) => {
        console.log(`error:${error.code}`);
        server.close();
    });
    socket.on("close", () => {
        setTimeout(() => {
            console.log(serverLine);
            server.close();
        }, 20);
    });
});
