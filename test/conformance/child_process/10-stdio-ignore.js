const { spawn } = require("child_process");
const child = spawn(process.execPath, ["-e", "process.stdout.write('ignored'); process.exit(0)"], {
    stdio: "ignore",
});
console.log("stdout:" + child.stdout);
child.on("close", (code) => console.log("close:" + code));
