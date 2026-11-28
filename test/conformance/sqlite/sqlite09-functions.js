// `node:sqlite`: user-defined scalar functions, aggregates and window functions.

const { Database } = require("node:sqlite");

const db = new Database(":memory:");

db.function("twice", (value) => value * 2);
console.log("scalar:", JSON.stringify(db.prepare("SELECT twice(21) AS v").get()));

db.function("identity", (value) => value);
for (const value of [1, 1.5, "text", null, 2n ** 40n]) {
    const row = db.prepare("SELECT identity(?) AS v, typeof(identity(?)) AS t").get(value, value);
    console.log("typed:", JSON.stringify(row));
}
db.function("big", () => 2n ** 40n);
console.log(
    "bigint return:",
    JSON.stringify(db.prepare("SELECT big() AS v, typeof(big()) AS t").get()),
);

db.function("bad", () => true);
try {
    db.prepare("SELECT bad()").get();
} catch (error) {
    console.log("boolean return:", error.code, "|", error.message);
}

db.function("boom", () => {
    throw new TypeError("function failed");
});
try {
    db.prepare("SELECT boom()").get();
} catch (error) {
    console.log("throw:", error.name, "|", error.message);
}

db.function("type_of_arg", { useBigIntArguments: true }, (value) => typeof value);
console.log("bigint argument:", db.prepare("SELECT type_of_arg(42) AS v").get().v);

db.function("arg_count", { varargs: true }, (...args) => args.length);
console.log(
    "varargs:",
    JSON.stringify(
        db.prepare("SELECT arg_count() AS a, arg_count(1) AS b, arg_count(1, 2) AS c").get(),
    ),
);

db.aggregate("my_sum", { start: 0, step: (state, value) => state + value });
console.log(
    "aggregate:",
    JSON.stringify(
        db
            .prepare(
                "SELECT my_sum(x) AS total FROM (SELECT 1 AS x UNION ALL SELECT 2 UNION ALL SELECT 3)",
            )
            .get(),
    ),
);
db.aggregate("from_function", {
    start: () => [0],
    step: (state, value) => {
        state[0] += value;
        return state;
    },
    result: (state) => state[0],
});
console.log(
    "start function:",
    JSON.stringify(
        db
            .prepare("SELECT from_function(x) AS total FROM (SELECT 1 AS x UNION ALL SELECT 2)")
            .get(),
    ),
);
db.aggregate("empty_sum", { start: 5, step: (state, value) => state + value });
console.log(
    "empty aggregate:",
    JSON.stringify(db.prepare("SELECT empty_sum(x) AS total FROM (SELECT 1 AS x WHERE 0)").get()),
);

db.aggregate("window_sum", {
    start: 0,
    step: (state, value) => state + value,
    result: (state) => state,
    inverse: (state, value) => state - value,
});
console.log(
    "window:",
    JSON.stringify(
        db
            .prepare(
                "SELECT window_sum(x) OVER (ORDER BY x ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS total FROM (SELECT 1 AS x UNION ALL SELECT 2 UNION ALL SELECT 3)",
            )
            .all(),
    ),
);
