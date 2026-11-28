// `node:sqlite`: SQLite failures carry errcode/errstr; argument failures carry Node codes.
// Messages for argument validation are deliberately not printed (Node's exact wording is not the
// compatibility promise); SQLite's own messages are, because they come from SQLite.

const { Database } = require("node:sqlite");

const db = new Database(":memory:");

try {
    db.prepare("SELECT FROM");
} catch (error) {
    console.log("syntax:", error.name, error.code, error.errcode, error.errstr, "|", error.message);
}

try {
    db.prepare("");
} catch (error) {
    console.log("empty sql:", error.name, error.code);
}

try {
    new Database(42);
} catch (error) {
    console.log("bad path:", error.name, error.code);
}

try {
    new Database(":memory:", { readOnly: "yes" });
} catch (error) {
    console.log("bad option:", error.name, error.code);
}

try {
    db.prepare("SELECT ? AS v").get(2n ** 64n);
} catch (error) {
    console.log("bigint range:", error.name, error.code);
}

try {
    db.prepare('SELECT "abc"');
} catch (error) {
    console.log("dqs:", error.code, error.errcode, "|", error.message);
}

try {
    db.prepare("SELECT 1").stat("autoIndex");
} catch (error) {
    console.log("stat name:", error.name, error.code);
}

// SQL below the first error of `exec` stays applied.
db.exec("CREATE TABLE kept(a)");
try {
    db.exec("INSERT INTO kept VALUES (1); BOGUS");
} catch (error) {
    console.log(
        "exec stops:",
        error.code,
        JSON.stringify(db.prepare("SELECT COUNT(*) AS n FROM kept").get()),
    );
}
