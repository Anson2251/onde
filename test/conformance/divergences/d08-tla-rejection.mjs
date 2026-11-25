// A rejected top-level await reaches `unhandledRejection` in onde and `uncaughtException` in
// Node. Both exit 1 when nothing listens.
process.on("unhandledRejection", () => console.log("unhandledRejection"));
process.on("uncaughtException", () => console.log("uncaughtException"));
await Promise.reject(new Error("tla"));
