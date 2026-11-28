const path = require("path");
const { spawn } = require("child_process");
const child = spawn(process.execPath, [path.join(__dirname, "fixtures", "identity.js"), "a", "b"], {
    cwd: "/tmp",
    env: { ...process.env, CONFORMANCE_ENV: "yes" },
});
let out = "";
child.stdout.on("data", (chunk) => {
    out += chunk;
});
child.on("close", () => process.stdout.write(out));
