process.on("beforeExit", (c) => console.log("beforeExit", c));
process.on("exit", (c) => console.log("exit", c));
console.log("sync");
