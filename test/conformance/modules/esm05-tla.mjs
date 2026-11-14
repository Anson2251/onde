console.log("start");
const value = await Promise.resolve(42);
console.log("awaited", value);
