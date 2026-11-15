const path = require("path");
const { fork } = require("child_process");
const child = fork(path.join(__dirname, "fixtures", "fork-child.js"), [], { silent: true });
child.on("message", (message) => {
  console.log("message:" + JSON.stringify(message));
  if (message && message.ready) child.send("hi");
  else if (message && message.echo === "hi") child.send("bye");
});
child.on("disconnect", () => console.log("disconnect"));
child.on("exit", (code, signal) => console.log("exit:" + code + ":" + signal));
