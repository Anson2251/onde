// Prints the values a spawn test cares about, in a deterministic order.
process.stdout.write(`argv:${JSON.stringify(process.argv.slice(2))}\n`);
process.stdout.write(`cwd:${process.cwd()}\n`);
process.stdout.write(`env:${process.env.PROC_FIXTURE_ENV || ""}\n`);
