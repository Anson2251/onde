"use strict";
// fs/promises: file operations, async-iterable data and the recursive mkdir return value.
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

(async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "conf-fs-prom-"));
    const file = path.join(dir, "a.txt");
    const copy = path.join(dir, "b.txt");

    await fsp.writeFile(file, "hello");
    console.log("read", await fsp.readFile(file, "utf8"));
    await fsp.appendFile(file, "!");
    console.log("append", await fsp.readFile(file, "utf8"));

    async function* chunks() {
        yield "async-";
        yield Buffer.from("iterable");
    }
    await fsp.writeFile(file, chunks());
    console.log("iterable", await fsp.readFile(file, "utf8"));

    const made = await fsp.mkdir(path.join(dir, "x/y/z"), { recursive: true });
    console.log("mkdir", made === path.join(dir, "x"));
    console.log(
        "mkdir-existing",
        (await fsp.mkdir(path.join(dir, "x/y/z"), { recursive: true })) === undefined,
    );

    const dirents = await fsp.readdir(dir, { withFileTypes: true });
    console.log(
        "readdir",
        dirents
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(
                (entry) =>
                    `${entry.name}:${entry.isFile() ? "f" : entry.isDirectory() ? "d" : "?"}`,
            )
            .join(","),
    );

    console.log("stat", (await fsp.stat(file)).isFile(), typeof (await fsp.stat(file)).atime);
    await fsp.copyFile(file, copy);
    console.log("copy", await fsp.readFile(copy, "utf8"));
    await fsp.rename(copy, path.join(dir, "renamed.txt"));
    console.log("rename", fs.existsSync(path.join(dir, "renamed.txt")));
    await fsp.truncate(file, 2);
    console.log("truncate", (await fsp.stat(file)).size);
    await fsp.chmod(file, 0o600);
    console.log("chmod", ((await fsp.stat(file)).mode & 0o777).toString(8));
    const link = path.join(dir, "link");
    await fsp.symlink(file, link);
    console.log("readlink", (await fsp.readlink(link)) === file);
    console.log("realpath", path.isAbsolute(await fsp.realpath(link)));
    await fsp.unlink(link);
    console.log("rm", await fsp.rm(dir, { recursive: true, force: true }));
})();
