const { exec } = require("child_process");
exec("printf abc; printf err >&2; exit 2", (error, stdout, stderr) => {
  console.log("stdout:" + stdout);
  console.log("stderr:" + stderr);
  console.log("code:" + (error && error.code));
});
