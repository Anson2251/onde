process.on("exit", (c) => console.log("exit", c));
process.exitCode = 3;
console.log("sync");
