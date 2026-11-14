"use strict";

// ECONNREFUSED: connecting to a port nobody listens on is an `error` event with Node's shape,
// followed by `close` (m4-plan §2.3).

const net = require("net");

const probe = net.createServer();
probe.listen(0, "127.0.0.1", () => {
  const port = probe.address().port;
  probe.close(() => {
    const client = net.connect(port, "127.0.0.1");
    let order = [];
    client.on("error", (error) => {
      order.push("error");
      console.log("code: " + error.code);
      console.log("syscall: " + error.syscall);
      console.log("negative errno: " + (error.errno < 0));
    });
    client.on("close", () => {
      order.push("close");
      console.log("order: " + order.join(","));
    });
  });
});
