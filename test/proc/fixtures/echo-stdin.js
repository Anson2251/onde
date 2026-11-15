process.stdin.on("data", (chunk) => process.stdout.write(chunk));
process.stdin.on("end", () => process.stdout.write("[eof]"));
