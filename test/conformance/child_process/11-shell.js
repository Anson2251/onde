const { spawn } = require("child_process");
const child = spawn("printf 'shell:%s' ok", { shell: true });
let out = "";
child.stdout.on("data", (chunk) => {
    out += chunk;
});
child.on("close", (code) => {
    console.log("out:" + out);
    console.log("close:" + code);
});
