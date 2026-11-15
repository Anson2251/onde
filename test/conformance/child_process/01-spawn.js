const { spawn } = require("child_process");
const child = spawn(process.execPath, ["-e", "process.stdout.write('hello'); process.exit(0)"]);
child.stdout.on("data", (chunk) => console.log("data:" + chunk));
child.on("close", (code, signal) => console.log("close:" + code + ":" + signal));
