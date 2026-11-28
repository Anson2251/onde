"use strict";

// Node-only differential test: runs the same stream scenarios against
// `js/lib/stream.js` and Node's `node:stream`, and compares the transcripts.
//
//   node test/js/lib/stream.oracle.js
//
// Timing-dependent scenarios use short `setTimeout` hops and a settling delay, so the two
// transcripts are deterministic. Deliberate divergences (docs/compat.md `stream` row and the
// module comment in js/lib/stream.js) are not exercised here: the 16 KiB default high-water
// mark, `pipe` error teardown, and `pipeline(..., { signal }, cb)`.

const nodeStream = require("node:stream");
const ourStream = require("../../../js/lib/stream.js");

let checks = 0;
const failures = [];

function format(value) {
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" || typeof value === "boolean" || value === undefined) {
        return String(value);
    }
    if (value === null) return "null";
    if (value instanceof Uint8Array) return `b:${Buffer.from(value).toString("utf8")}`;
    if (value && value.name !== undefined && value.code !== undefined) {
        return `err:${value.name}:${value.code}:${value.message}`;
    }
    if (value && typeof value.then === "function") return "promise";
    if (Array.isArray(value)) return `[${value.map(format).join(",")}]`;
    if (typeof value === "function") return `fn:${value.name}`;
    return String(value);
}

function makeContext(stream) {
    const lines = [];
    const ctx = {
        stream,
        log(...args) {
            lines.push(args.map(format).join(" "));
        },
        wait(ms) {
            return new Promise((resolve) => setTimeout(resolve, ms === undefined ? 5 : ms));
        },
        settleMs: 30,
    };
    ctx.lines = lines;
    return ctx;
}

const scenarios = [];
function scenario(name, fn) {
    scenarios.push({ name, fn });
}

// ---------------------------------------------------------------------------------------------
// Readable: push / read / flowing
// ---------------------------------------------------------------------------------------------

scenario("readable: push before and after data listener", async ({ stream, log, wait }) => {
    const { Readable } = stream;
    const a = new Readable({ read() {} });
    a.on("data", (chunk) => log("a data", chunk));
    a.push("one");
    log("a after push", a.readableLength);
    a.push("two");
    a.push(null);
    a.on("end", () => log("a end", a.readableEnded, a.destroyed));
    a.on("close", () => log("a close", a.closed));

    const b = new Readable({ read() {} });
    b.push("buffered");
    b.on("data", (chunk) => log("b data", chunk));
    b.on("end", () => log("b end"));
    b.push(null);
    log("b flowing", b.readableFlowing);
    await wait();
});

scenario("readable: pull mode and read(n)", async ({ stream, log }) => {
    const { Readable } = stream;
    const r = new Readable({ read() {} });
    log("empty", r.read(), r.read(0), r.readableLength);
    r.push(Buffer.from("hello"));
    log("len", r.readableLength);
    log("read(3)", r.read(3), "len", r.readableLength);
    log("read(100)", r.read(100));
    log("read()", r.read());
    r.push(null);
    log("after eof", r.read(), r.readableEnded);
});

scenario("readable: unshift", async ({ stream, log }) => {
    const { Readable } = stream;
    const r = new Readable({ read() {} });
    r.on("readable", () => {
        let chunk;
        while ((chunk = r.read()) !== null) log("chunk", chunk);
    });
    r.push("bb");
    r.unshift("aa");
    r.push(null);
    r.on("end", () => log("end"));
});

scenario("readable: readable event pull loop", async ({ stream, log, wait }) => {
    const { Readable } = stream;
    let calls = 0;
    const r = new Readable({
        read() {
            calls += 1;
            log("_read", calls);
            if (calls === 1) this.push("aaa");
            if (calls === 2) this.push(null);
        },
    });
    r.on("readable", () => {
        const chunk = r.read();
        log("readable", chunk === null ? null : chunk);
    });
    r.on("end", () => log("end"));
    await wait();
});

scenario("readable: _read error destroys", async ({ stream, log, wait }) => {
    const { Readable } = stream;
    const r = new Readable({
        read() {
            throw new Error("read boom");
        },
    });
    r.on("error", (err) => log("error", err.code, err.message));
    r.on("close", () => log("close", r.destroyed, r.closed));
    r.on("data", () => {});
    log("after resume", r.destroyed);
    await wait();
});

scenario("readable: push types and errors", async ({ stream, log }) => {
    const { Readable } = stream;
    const r = new Readable({ read() {} });
    log("push buffer", r.push(Buffer.from("x")), r.readableLength);
    log("push string", r.push("y"), r.readableLength);
    log("push uint8", r.push(new Uint8Array([0x7a])), r.readableLength);
    log("read", r.read());
    r.push(null);
    r.on("error", (err) => log("eof error", err.code, err.message));
    log("push after eof", r.push("ignored"), r.read(), r.destroyed);
    const obj = new Readable({ objectMode: true, read() {} });
    log("push object", obj.push({ a: 1 }), obj.readableLength);
    log("read object", format(obj.read()));
});

scenario("readable: highWaterMark backpressure", async ({ stream, log }) => {
    const { Readable } = stream;
    const r = new Readable({ highWaterMark: 4, read() {} });
    log("push 2", r.push("ab"), r.readableLength);
    log("push 2", r.push("cd"), r.readableLength);
    log("push 1", r.push("e"), r.readableLength);
    log("hwm", r.readableHighWaterMark);
});

scenario("readable: pause / resume / isPaused", async ({ stream, log, wait }) => {
    const { Readable } = stream;
    const r = new Readable({ read() {} });
    r.on("data", (chunk) => {
        log("data", chunk);
        if (chunk === "b") r.pause();
    });
    r.on("pause", () => log("pause event"));
    r.on("resume", () => log("resume event"));
    r.push("a");
    r.push("b");
    r.push("c");
    await wait(10);
    log("paused", r.isPaused(), r.readableFlowing);
    r.resume();
    await wait(10);
    log("after resume", r.readableFlowing);
});

scenario("readable: setEncoding splits a multi-byte character", async ({ stream, log, wait }) => {
    const { Readable } = stream;
    const r = new Readable({ read() {} });
    r.setEncoding("utf8");
    log("encoding", r.readableEncoding);
    r.on("data", (chunk) => log("data", typeof chunk, chunk));
    r.on("end", () => log("end"));
    const bytes = Buffer.from("héllo");
    r.push(bytes.subarray(0, 2));
    r.push(bytes.subarray(2));
    r.push(null);
    await wait();
});

scenario("readable: setEncoding decodes already buffered bytes", async ({ stream, log }) => {
    const { Readable } = stream;
    const r = new Readable({ read() {} });
    r.push(Buffer.from("hé"));
    r.setEncoding("utf8");
    log("len", r.readableLength);
    log("read", r.read());
});

scenario("readable: objectMode", async ({ stream, log, wait }) => {
    const { Readable } = stream;
    const r = new Readable({ objectMode: true, read() {} });
    r.push(0);
    r.push(false);
    r.push("");
    r.push(null);
    r.on("data", (chunk) => log("data", typeof chunk, chunk));
    r.on("end", () => log("end"));
    log("before", r.readableLength);
    await wait();
});

// ---------------------------------------------------------------------------------------------
// Writable
// ---------------------------------------------------------------------------------------------

scenario("writable: sync _write, callbacks and finish", async ({ stream, log, wait }) => {
    const { Writable } = stream;
    const w = new Writable({
        write(chunk, encoding, cb) {
            log("_write", chunk, encoding);
            cb();
        },
    });
    w.on("finish", () => log("finish", w.writableFinished, w.destroyed));
    w.on("close", () => log("close", w.closed));
    log(
        "write ret",
        w.write("a", () => log("cb a")),
    );
    log("after write", w.writableLength);
    w.end(() => log("end cb"));
    log("after end", w.writableEnded, w.writableFinished);
    await wait();
});

scenario("writable: backpressure and drain", async ({ stream, log, wait }) => {
    const { Writable } = stream;
    const w = new Writable({
        highWaterMark: 4,
        write(chunk, encoding, cb) {
            log("_write", chunk);
            setTimeout(cb, 2);
        },
    });
    w.on("drain", () => log("drain", w.writableNeedDrain, w.writableLength));
    w.on("finish", () => log("finish"));
    log("w1", w.write("aa"), w.writableNeedDrain);
    log("w2", w.write("bb"), w.writableNeedDrain);
    log("w3", w.write("cc"), w.writableNeedDrain, w.writableLength);
    // Wait for the event instead of a wall-clock guess: under load a fixed delay can end the
    // stream before the last queued write callback runs, which changes the transcript.
    await new Promise((resolve) => w.once("drain", resolve));
    w.end("dd");
    log("after end", w.writableEnded);
    await wait();
});

scenario("writable: write after end", async ({ stream, log, wait }) => {
    const { Writable } = stream;
    const w = new Writable({
        write(chunk, encoding, cb) {
            cb();
        },
    });
    w.on("error", (err) => log("error", err.code, err.message));
    w.end();
    log("ended", w.writableEnded, w.writableFinished);
    log(
        "write ret",
        w.write("x", (err) => log("cb", err && err.code)),
    );
    await wait();
});

scenario("writable: write after destroy", async ({ stream, log, wait }) => {
    const { Writable } = stream;
    const w = new Writable({
        write(chunk, encoding, cb) {
            cb();
        },
    });
    w.on("error", (err) => log("error", err.code));
    w.destroy();
    log("destroyed", w.destroyed, w.closed);
    log(
        "write ret",
        w.write("x", (err) => log("cb", err && err.code, err && err.message)),
    );
    await wait();
});

scenario("writable: destroy with error, idempotent close", async ({ stream, log, wait }) => {
    const { Writable } = stream;
    const w = new Writable({
        write(chunk, encoding, cb) {
            cb();
        },
    });
    w.on("error", (err) => log("error", err.message));
    w.on("close", () => log("close", w.destroyed, w.closed));
    w.destroy(new Error("boom"));
    log("after destroy", w.destroyed, w.closed);
    w.destroy();
    w.on("close", () => log("close2"));
    w.end();
    log("end after destroy", w.writableEnded);
    await wait();
});

scenario("writable: cork / uncork / writev", async ({ stream, log, wait }) => {
    const { Writable } = stream;
    const w = new Writable({
        write(chunk, encoding, cb) {
            log("write", chunk);
            cb();
        },
        writev(chunks, cb) {
            log(
                "writev",
                chunks.map((entry) => `${entry.chunk}:${entry.encoding}`),
            );
            cb();
        },
    });
    w.cork();
    log("w1", w.write("a"));
    log("w2", w.write("b"));
    log("corked", w.writableCorked);
    w.uncork();
    w.write("c");
    w.end();
    await wait();
});

scenario("writable: _writev fallback without writev", async ({ stream, log, wait }) => {
    const { Writable } = stream;
    const w = new Writable({
        write(chunk, encoding, cb) {
            log("write", chunk);
            cb();
        },
    });
    w.cork();
    w.write("a");
    w.write("b");
    w.uncork();
    w.end();
    await wait();
});

scenario("writable: _write callback error", async ({ stream, log, wait }) => {
    const { Writable } = stream;
    const w = new Writable({
        write(chunk, encoding, cb) {
            cb(new Error("write boom"));
        },
    });
    w.on("error", (err) => log("error", err.code, err.message));
    w.on("close", () => log("close"));
    w.on("finish", () => log("finish"));
    w.write("a", (err) => log("cb", err && err.message));
    await wait();
});

scenario("writable: objectMode and null chunk", async ({ stream, log, wait }) => {
    const { Writable } = stream;
    const w = new Writable({
        objectMode: true,
        write(chunk, encoding, cb) {
            log("write", typeof chunk, format(chunk));
            cb();
        },
    });
    log("w1", w.write({ a: 1 }));
    log("w2", w.write("str"));
    w.end();
    await wait();
    const plain = new Writable({
        write(chunk, encoding, cb) {
            cb();
        },
    });
    try {
        plain.write(null);
    } catch (err) {
        log("null chunk", err.code);
    }
});

scenario("writable: end with a chunk and finish order", async ({ stream, log, wait }) => {
    const { Writable } = stream;
    const w = new Writable({
        write(chunk, encoding, cb) {
            log("write", chunk);
            setTimeout(cb, 1);
        },
    });
    w.on("drain", () => log("drain"));
    w.on("finish", () => log("finish"));
    w.on("close", () => log("close"));
    w.end("last", () => log("end cb"));
    await wait();
});

// ---------------------------------------------------------------------------------------------
// Duplex / Transform / PassThrough
// ---------------------------------------------------------------------------------------------

scenario(
    "duplex: allowHalfOpen true keeps the readable side open",
    async ({ stream, log, wait }) => {
        const { Duplex } = stream;
        const d = new Duplex({
            read() {},
            write(chunk, encoding, cb) {
                cb();
            },
        });
        log("allowHalfOpen", d.allowHalfOpen);
        d.on("finish", () => log("finish"));
        d.on("end", () => log("end"));
        d.on("close", () => log("close"));
        d.end();
        log("after end", d.readableEnded, d.writableFinished);
        await wait(10);
        d.push("tail");
        d.push(null);
        d.resume();
        await wait();
    },
);

scenario("duplex: allowHalfOpen false ends the readable side", async ({ stream, log, wait }) => {
    const { Duplex } = stream;
    const d = new Duplex({
        allowHalfOpen: false,
        read() {},
        write(chunk, encoding, cb) {
            cb();
        },
    });
    d.on("finish", () => log("finish"));
    d.on("end", () => log("end"));
    d.on("close", () => log("close"));
    d.resume();
    d.end();
    await wait();
});

scenario("transform: push from the callback", async ({ stream, log, wait }) => {
    const { Transform } = stream;
    const t = new Transform({
        transform(chunk, encoding, cb) {
            cb(null, String(chunk).toUpperCase());
        },
    });
    const out = [];
    t.on("data", (chunk) => {
        out.push(String(chunk));
        log("data", chunk);
    });
    t.on("end", () => log("end", out.join("")));
    t.on("finish", () => log("finish"));
    t.write("a");
    t.write("b");
    t.end();
    await wait();
});

scenario("transform: _flush", async ({ stream, log, wait }) => {
    const { Transform } = stream;
    const t = new Transform({
        transform(chunk, encoding, cb) {
            cb(null, String(chunk));
        },
        flush(cb) {
            log("flush");
            cb(null, "!");
        },
    });
    t.on("data", (chunk) => log("data", chunk));
    t.on("end", () => log("end"));
    t.on("finish", () => log("finish"));
    t.end("ab");
    await wait();
});

scenario("transform: error from transform destroys", async ({ stream, log, wait }) => {
    const { Transform } = stream;
    const t = new Transform({
        transform(chunk, encoding, cb) {
            cb(new Error("transform boom"));
        },
    });
    t.on("error", (err) => log("error", err.message));
    t.on("close", () => log("close"));
    t.write("a");
    await wait();
});

scenario("passthrough: passes chunks through", async ({ stream, log, wait }) => {
    const { PassThrough } = stream;
    const pt = new PassThrough();
    pt.on("data", (chunk) => log("data", chunk));
    pt.on("end", () => log("end"));
    pt.on("finish", () => log("finish"));
    pt.write("a");
    pt.end("b");
    await wait();
});

scenario("transform: backpressure with a slow reader", async ({ stream, log, wait }) => {
    const { Transform } = stream;
    const t = new Transform({
        highWaterMark: 2,
        transform(chunk, encoding, cb) {
            cb(null, chunk);
        },
    });
    const seen = [];
    t.on("readable", () => {
        const chunk = t.read();
        if (chunk !== null) {
            seen.push(String(chunk));
            log("read", chunk);
        }
    });
    t.on("end", () => log("end", seen.join("")));
    for (const part of ["a", "b", "c"]) t.write(part);
    t.end();
    await wait(40);
});

// ---------------------------------------------------------------------------------------------
// pipe
// ---------------------------------------------------------------------------------------------

scenario("pipe: data flow and events", async ({ stream, log, wait }) => {
    const { Readable, Writable } = stream;
    const r = new Readable({ read() {} });
    const seen = [];
    const w = new Writable({
        write(chunk, encoding, cb) {
            seen.push(String(chunk));
            cb();
        },
    });
    w.on("pipe", (source) => log("pipe", source === r));
    w.on("unpipe", (source) => log("unpipe", source === r));
    w.on("finish", () => log("finish", seen.join(",")));
    log("ret is dest", r.pipe(w) === w);
    log("flowing", r.readableFlowing);
    r.push("a");
    r.push("b");
    r.push(null);
    r.on("end", () => log("end"));
    await wait();
});

scenario("pipe: end false leaves the destination open", async ({ stream, log, wait }) => {
    const { Readable, Writable } = stream;
    const r = new Readable({ read() {} });
    const w = new Writable({
        write(chunk, encoding, cb) {
            cb();
        },
    });
    w.on("finish", () => log("finish"));
    r.pipe(w, { end: false });
    r.push("a");
    r.push(null);
    r.on("end", () => {
        log("end");
        w.end();
    });
    await wait();
});

scenario("pipe: backpressure pauses and resumes", async ({ stream, log, wait }) => {
    const { Readable, Writable } = stream;
    const r = new Readable({
        highWaterMark: 2,
        read() {
            log("_read");
        },
    });
    let written = 0;
    let bothWritten;
    const both = new Promise((resolve) => {
        bothWritten = resolve;
    });
    let drains = 0;
    const drainWaiters = [];
    const w = new Writable({
        highWaterMark: 2,
        write(chunk, encoding, cb) {
            log("write", chunk);
            written += 1;
            if (written === 2) bothWritten();
            setTimeout(cb, 3);
        },
    });
    // Synchronise on the stream's own events instead of wall-clock delays: under load a fixed
    // delay can land before or after a queued write callback and change the transcript.
    w.on("drain", () => {
        drains += 1;
        while (drainWaiters.length > 0 && drainWaiters[0].count <= drains) {
            drainWaiters.shift().resolve();
        }
    });
    function afterDrain(count) {
        return new Promise((resolve) => {
            if (drains >= count) resolve();
            else drainWaiters.push({ count, resolve });
        });
    }
    r.pipe(w);
    r.push("a");
    r.push("b");
    await both;
    log("flowing", r.readableFlowing);
    r.push("c");
    r.push("d");
    await afterDrain(1);
    await afterDrain(2);
    r.push(null);
    r.on("end", () => log("end"));
    w.on("finish", () => log("finish"));
    await wait();
});

// ---------------------------------------------------------------------------------------------
// pipeline
// ---------------------------------------------------------------------------------------------

scenario("pipeline: success returns the destination", async ({ stream, log, wait }) => {
    const { Readable, PassThrough, Writable, pipeline } = stream;
    const source = Readable.from(["x", "y"]);
    const middle = new PassThrough();
    const dest = new Writable({
        write(chunk, encoding, cb) {
            log("dest", chunk);
            cb();
        },
    });
    const ret = pipeline(source, middle, dest, (err) => log("callback", err));
    log("ret is dest", ret === dest);
    await wait();
});

scenario("pipeline: forwards an error and destroys the chain", async ({ stream, log, wait }) => {
    const { Readable, Writable, pipeline } = stream;
    const source = new Readable({ read() {} });
    const dest = new Writable({
        write(chunk, encoding, cb) {
            cb(new Error("dest boom"));
        },
    });
    source.on("error", () => {});
    dest.on("error", () => {});
    pipeline(source, dest, (err) => log("callback", err && err.message));
    source.push("a");
    log("after push", source.destroyed, dest.destroyed);
    await wait();
    log("destroyed", source.destroyed, dest.destroyed);
});

scenario("pipeline: array form and argument validation", async ({ stream, log, wait }) => {
    const { Readable, pipeline } = stream;
    try {
        pipeline(Readable.from(["solo"]), () => {});
    } catch (err) {
        log("single", err.code, err.message);
    }
    const a = Readable.from(["a"]);
    const dest = new stream.Writable({
        write(chunk, encoding, cb) {
            log("array dest", chunk);
            cb();
        },
    });
    pipeline([a, dest], (err) => log("array", err));
    await wait();
});

// ---------------------------------------------------------------------------------------------
// finished / addAbortSignal
// ---------------------------------------------------------------------------------------------

scenario("finished: success, error and premature close", async ({ stream, log, wait }) => {
    const { Readable, Writable, finished } = stream;

    const r1 = new Readable({ read() {} });
    log("cleanup type", typeof finished(r1, (err) => log("readable done", err)));
    r1.resume();
    r1.push(null);

    const r2 = new Readable({ read() {} });
    r2.on("error", () => {});
    finished(r2, (err) => log("error done", err && err.code, err && err.message));
    r2.destroy(new Error("x"));

    const r3 = new Readable({ read() {} });
    finished(r3, (err) => log("premature", err && err.code));
    r3.destroy();

    const w = new Writable({
        write(chunk, encoding, cb) {
            cb();
        },
    });
    finished(w, (err) => log("writable done", err));
    w.end();

    await wait();
});

scenario("finished: error false suppresses the error value", async ({ stream, log, wait }) => {
    const { Readable, finished } = stream;
    const r = new Readable({ read() {} });
    r.on("error", () => {});
    finished(r, { error: false }, (err) => log("done", err, err === undefined));
    r.destroy(new Error("nope"));
    await wait();
});

scenario("finished: cleanup prevents the callback", async ({ stream, log, wait }) => {
    const { Readable, finished } = stream;
    const r = new Readable({ read() {} });
    let calls = 0;
    const cleanup = finished(r, () => {
        calls += 1;
        log("callback");
    });
    cleanup();
    r.push(null);
    r.resume();
    await wait();
    log("calls", calls);
});

scenario("addAbortSignal: destroys with ABORT_ERR", async ({ stream, log, wait }) => {
    const { Readable, addAbortSignal } = stream;
    const controller = new AbortController();
    const r = new Readable({ read() {} });
    addAbortSignal(controller.signal, r);
    r.on("error", (err) => log("error", err.name, err.code));
    r.on("close", () => log("close", r.destroyed, r.closed));
    controller.abort();
    log("after abort", r.destroyed);

    const pre = new Readable({ read() {} });
    const controller2 = new AbortController();
    controller2.abort();
    addAbortSignal(controller2.signal, pre);
    pre.on("error", (err) => log("pre error", err.name, err.code));
    pre.on("close", () => log("pre close"));
    log("pre destroyed", pre.destroyed);
    await wait();
});

// ---------------------------------------------------------------------------------------------
// Readable.from / async iteration
// ---------------------------------------------------------------------------------------------

scenario("Readable.from: arrays, strings and options", async ({ stream, log, wait }) => {
    const { Readable } = stream;
    const objects = Readable.from([1, "two", { three: 3 }]);
    log("object mode", objects.readableObjectMode);
    objects.on("data", (chunk) => log("objects", typeof chunk, format(chunk)));
    objects.on("end", () => log("objects end"));

    const bytes = Readable.from(["a", "b"], { objectMode: false });
    bytes.on("data", (chunk) => log("bytes", Buffer.isBuffer(chunk), chunk));
    bytes.on("end", () => log("bytes end"));

    const string = Readable.from("abc");
    string.on("data", (chunk) => log("string", format(chunk)));
    string.on("end", () => log("string end"));

    const empty = Readable.from([]);
    empty.on("data", () => log("empty data"));
    empty.on("end", () => log("empty end"));
    await wait();
});

scenario("Readable.from: async iterable", async ({ stream, log, wait }) => {
    const { Readable } = stream;
    async function* generate() {
        yield "a";
        yield "b";
    }
    const r = Readable.from(generate());
    r.on("data", (chunk) => log("data", chunk));
    r.on("end", () => log("end"));
    await wait();
});

scenario("async iteration: for await over a readable", async ({ stream, log, wait }) => {
    const { Readable } = stream;
    const r = Readable.from([1, 2, 3]);
    for await (const value of r) log("value", value);
    log("after loop", r.destroyed);

    const t = new stream.Transform({
        objectMode: true,
        transform(chunk, encoding, cb) {
            cb(null, Number(chunk) * 2);
        },
    });
    t.write(1);
    t.write(2);
    t.end();
    for await (const value of t) log("transform value", value);
    await wait();
});

scenario("async iteration: early break destroys the stream", async ({ stream, log, wait }) => {
    const { Readable } = stream;
    const r = Readable.from([1, 2, 3, 4]);
    for await (const value of r) {
        log("value", value);
        if (value === 2) break;
    }
    log("destroyed", r.destroyed);
    await wait();
});

scenario("async iteration: error rejects", async ({ stream, log, wait }) => {
    const { Readable } = stream;
    const r = new Readable({ read() {} });
    setTimeout(() => r.destroy(new Error("iter boom")), 1);
    try {
        for await (const value of r) log("value", value);
    } catch (err) {
        log("threw", err.message, r.destroyed);
    }
    await wait();
});

// ---------------------------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------------------------

scenario("predicates and getters", async ({ stream, log, wait }) => {
    const { Readable, Writable, isReadable, isWritable, isDestroyed } = stream;
    const r = new Readable({ read() {} });
    const w = new Writable({
        write(chunk, encoding, cb) {
            cb();
        },
    });
    log(
        "fresh",
        isReadable(r),
        isWritable(r),
        isDestroyed(r),
        isReadable(w),
        isWritable(w),
        isDestroyed(w),
    );
    log("flowing", r.readableFlowing, r.isPaused(), r.readable, r.readableEnded);
    r.resume();
    log("resumed", r.readableFlowing, r.isPaused());
    r.pause();
    log("paused", r.readableFlowing, r.isPaused());
    r.destroy();
    w.destroy();
    log("destroyed", isReadable(r), isWritable(w), isDestroyed(r), isDestroyed(w), r.readable);
    await wait();
});

// ---------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------

async function run() {
    for (let i = 0; i < scenarios.length; i += 1) {
        const current = scenarios[i];
        checks += 1;
        const expected = makeContext(nodeStream);
        const actual = makeContext(ourStream);
        let expectedError = null;
        let actualError = null;
        try {
            await current.fn(expected);
            await new Promise((resolve) => setTimeout(resolve, expected.settleMs));
        } catch (err) {
            expectedError = err;
        }
        try {
            await current.fn(actual);
            await new Promise((resolve) => setTimeout(resolve, actual.settleMs));
        } catch (err) {
            actualError = err;
        }

        if (expectedError || actualError) {
            if (
                String(expectedError && expectedError.stack) !==
                String(actualError && actualError.stack)
            ) {
                failures.push({
                    name: current.name,
                    expected: [
                        ...expected.lines,
                        `threw: ${expectedError && (expectedError.stack || expectedError)}`,
                    ],
                    actual: [
                        ...actual.lines,
                        `threw: ${actualError && (actualError.stack || actualError)}`,
                    ],
                });
            }
            continue;
        }

        const same =
            expected.lines.length === actual.lines.length &&
            expected.lines.every((line, index) => line === actual.lines[index]);
        if (!same)
            failures.push({ name: current.name, expected: expected.lines, actual: actual.lines });
    }

    for (const failure of failures) {
        console.error(`MISMATCH ${failure.name}`);
        const length = Math.max(failure.expected.length, failure.actual.length);
        for (let i = 0; i < length; i += 1) {
            const want = failure.expected[i];
            const got = failure.actual[i];
            if (want === got) {
                console.error(`  ok    ${want}`);
            } else {
                console.error(`  node  ${want}`);
                console.error(`  ours  ${got}`);
            }
        }
    }

    const total = checks + 1;
    if (failures.length === 0) {
        console.log(`stream.oracle.js: ${total} scenarios match node`);
        return;
    }
    console.error(`stream.oracle.js: ${failures.length} of ${total} scenarios differ`);
    const proc = globalThis.process;
    if (proc) proc.exitCode = 1;
}

run().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    globalThis.process.exitCode = 1;
});
