const { spawn } = require("child_process");
const child = spawn("onde-definitely-not-a-program", []);
child.on("error", (error) => console.log("error:" + error.code));
child.on("close", (code, signal) => console.log("close:" + code + ":" + signal));
