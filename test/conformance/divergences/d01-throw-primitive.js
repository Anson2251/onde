// Divergence: M1 wraps non-Error thrown values in an Error object.
process.on("uncaughtException", (e) => console.log("uncaught", e.name, e.message));
throw "primitive";
