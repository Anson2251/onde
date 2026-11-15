const { spawn } = require("child_process");
const child = spawn(process.execPath, ["-e", "process.exit(3)"]);
child.on("exit", (code, signal) => console.log("exit:" + code + ":" + signal));
child.on("close", (code, signal) => console.log("close:" + code + ":" + signal));
