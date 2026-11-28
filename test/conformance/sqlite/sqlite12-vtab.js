// `node:sqlite`: JavaScript-backed virtual tables.

const { Database } = require("node:sqlite");

const db = new Database(":memory:");

db.createModule("counter", {
    columns: [{ name: "value", type: "INTEGER" }],
    *rows() {
        yield [1];
        yield [2n];
    },
});
console.log("counter:", JSON.stringify(db.prepare("SELECT * FROM counter").all()));
console.log(
    "storage classes:",
    JSON.stringify(db.prepare("SELECT typeof(value) AS t, value FROM counter").all()),
);

db.createModule("series", {
    columns: [
        { name: "value", type: "INTEGER" },
        { name: "start", type: "INTEGER", hidden: true },
        { name: "stop", type: "INTEGER", hidden: true },
    ],
    *rows(start, stop) {
        start ??= 1;
        stop ??= 3;
        for (let value = start; value <= stop; value += 1) yield [value];
    },
});
console.log(
    "table-valued function:",
    JSON.stringify(db.prepare("SELECT * FROM series(2, 4)").all()),
);
console.log("defaults:", JSON.stringify(db.prepare("SELECT * FROM series").all()));
console.log(
    "hidden column:",
    JSON.stringify(db.prepare("SELECT value, start FROM series(2, 4)").all()),
);

db.createModule("hidden_types", {
    columns: [
        { name: "kind", type: "TEXT" },
        { name: "argument", type: "INTEGER", hidden: true },
    ],
    useBigIntArguments: true,
    *rows(argument) {
        yield [typeof argument];
    },
});
console.log("bigint argument:", JSON.stringify(db.prepare("SELECT * FROM hidden_types(42)").all()));

db.createModule("from_array", {
    columns: [{ name: "x", type: "ANY" }],
    rows() {
        return [[1], [2], [3]];
    },
});
console.log("array rows:", JSON.stringify(db.prepare("SELECT * FROM from_array").all()));

try {
    db.createModule("empty", {
        columns: [],
        rows() {
            return [];
        },
    });
} catch (error) {
    console.log("empty columns:", error.name, error.code, "|", error.message);
}
try {
    db.createModule("bad_type", {
        columns: [{ name: "x", type: "WEIRD" }],
        rows() {
            return [];
        },
    });
} catch (error) {
    console.log("bad type:", error.name, error.code, "|", error.message);
}
try {
    db.createModule("not_iterable", {
        columns: [{ name: "x", type: "INTEGER" }],
        rows() {
            return 5;
        },
    });
    db.prepare("SELECT * FROM not_iterable").all();
} catch (error) {
    console.log("non iterable:", error.code, "|", error.message);
}
try {
    db.createModule("throws", {
        columns: [{ name: "x", type: "INTEGER" }],
        *rows() {
            throw new Error("row failed");
        },
    });
    db.prepare("SELECT * FROM throws").all();
} catch (error) {
    console.log("row throw:", error.name, "|", error.message);
}
