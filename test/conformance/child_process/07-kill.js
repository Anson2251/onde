const { spawn } = require("child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
child.on("spawn", () => console.log("kill:" + child.kill("SIGTERM")));
child.on("exit", (code, signal) => console.log("exit:" + code + ":" + signal));
