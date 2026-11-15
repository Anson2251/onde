"use strict";

// Argument errors are synchronous at the call site (m4-plan §4): an impossible port, family or
// listen target throws a Node-shaped code instead of surfacing later as an event.

const net = require("net");

const cases = [
  ["connect-missing", () => net.connect()],
  ["connect-port-range", () => net.connect({ port: 70000 })],
  ["connect-port-string", () => net.connect({ port: "http" })],
  ["connect-family", () => net.connect({ port: 80, family: 5 })],
  ["listen-empty", () => net.createServer().listen({})],
];

for (const [label, fn] of cases) {
  try {
    fn();
    console.log(`${label}:no-throw`);
  } catch (error) {
    console.log(`${label}:${error.code}`);
  }
}

// A second listen on a server that is already bound is an error at the call site too, but it
// needs a real server, so it is reported from the listening callback.
const server = net.createServer();
server.listen(0, "127.0.0.1", () => {
  try {
    server.listen(0, "127.0.0.1");
    console.log("listen-twice:no-throw");
  } catch (error) {
    console.log(`listen-twice:${error.code}`);
  }
  server.close();
});
