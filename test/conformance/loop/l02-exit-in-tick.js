process.on("exit", (c) => console.log("exit", c));
process.nextTick(() => {
    console.log("tick");
    process.exit(5);
});
process.nextTick(() => console.log("nope"));
