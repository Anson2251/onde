"use strict";
try {
    require("./fixtures/does-not-exist");
} catch (error) {
    console.log(error.code, error.message.split("\n")[0]);
}
try {
    require("missing-package-xyz");
} catch (error) {
    console.log(error.code);
}
try {
    require(42);
} catch (error) {
    console.log(error.code);
}
console.log(require.resolve("path"));
