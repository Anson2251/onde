const { execFile } = require("child_process");
execFile(
    process.execPath,
    ["-e", "process.stdout.write('file'); process.exit(0)"],
    (error, stdout) => {
        console.log("stdout:" + stdout);
        console.log("error:" + (error === null));
    },
);
