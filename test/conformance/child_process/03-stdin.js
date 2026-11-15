const path = require("path");
const { spawn } = require("child_process");
const child = spawn(process.execPath, [path.join(__dirname, "fixtures", "echo.js")]);
let out = "";
child.stdout.on("data", (chunk) => { out += chunk; });
child.on("close", (code) => {
  console.log("out:" + out);
  console.log("close:" + code);
});
child.stdin.write("alpha\n");
child.stdin.end();
