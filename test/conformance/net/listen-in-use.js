"use strict";

// EADDRINUSE on a second server must not disturb the first: the failure is an `error` event on
// the loser, and the winner still accepts connections afterwards.

const net = require("net");

const first = net.createServer((socket) => socket.end("first-alive"));
first.listen(0, "127.0.0.1", () => {
  const port = first.address().port;
  const second = net.createServer();
  second.on("error", (error) => {
    console.log(`second-error:${error.code}`);
    second.close(() => {
      const client = net.connect(port, "127.0.0.1", () => client.end());
      let data = "";
      client.setEncoding("utf8");
      client.on("data", (chunk) => {
        data += chunk;
      });
      client.on("close", () => {
        console.log(`first-reply:${data}`);
        first.close();
      });
    });
  });
  second.listen(port, "127.0.0.1");
});
