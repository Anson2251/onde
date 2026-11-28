process.on("exit", (c) => {
    console.log("exit", c);
    process.exitCode = 5;
});
process.exitCode = 3;
