"use strict";
// Readable.from over an async iterable and over byte-mode iterables, consumed with for await.
const { Readable } = require("stream");

(async () => {
    async function* generate() {
        yield "a";
        yield "b";
    }
    const asyncStream = Readable.from(generate());
    const asyncValues = [];
    for await (const value of asyncStream) asyncValues.push(value);
    console.log("async", asyncValues.join(","), asyncStream.destroyed);

    const bytes = Readable.from(["a", "b"], { objectMode: false });
    const byteValues = [];
    for await (const chunk of bytes) byteValues.push(String(chunk));
    console.log("bytes", byteValues.join(","));

    const objects = Readable.from([1, "two"]);
    console.log("objectMode", objects.readableObjectMode, objects.readableHighWaterMark);
})();
