// Divergence D67: `--max-old-space-size` maps to one engine-wide `JS_SetMemoryLimit`; QuickJS has no
// old/new generation split, so exceeding it is a fatal OOM rather than Node's catchable split.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const hog = path.join(os.tmpdir(), `ln-hog-${process.pid}.js`);
fs.writeFileSync(
  hog,
  "const held = [];\nfor (let i = 0; i < 64; i += 1) held.push(new Array(1024 * 1024).fill(i));\n",
);
const child = spawn(process.execPath, ["--max-old-space-size=16", hog], {
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
child.on("close", (code) => {
  fs.unlinkSync(hog);
  console.log("exit", code);
  console.log("oom", /out of memory/i.test(stderr));
});
