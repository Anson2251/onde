process.stdout.write(`argv:${JSON.stringify(process.argv.slice(2))}\n`);
process.stdout.write(`base:${require("path").basename(process.cwd())}\n`);
process.stdout.write(`env:${process.env.CONFORMANCE_ENV || ""}\n`);
