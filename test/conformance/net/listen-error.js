"use strict";

// A listen failure is an `'error'` on the server, not a throw at the call site. Node does not
// emit `'close'` for a bind that never succeeded (m4-plan §4).

const net = require("net");

const first = net.createServer();
first.listen(0, "127.0.0.1", () => {
  const port = first.address().port;
  const second = net.createServer();
  let settled = false;
  function finish(label) {
    if (settled) return;
    settled = true;
    setTimeout(() => {
      console.log(label + ": closed");
      first.close();
    }, 20);
  }
  second.on("error", (error) => {
    console.log("error: " + error.code);
    console.log("syscall: " + error.syscall);
    finish("first");
  });
  second.on("close", () => console.log("close: emitted"));
  second.listen(port, "127.0.0.1", () => {
    console.log("second: listening");
    finish("first");
  });
});
