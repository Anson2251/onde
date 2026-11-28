// `node:zlib`: deterministic output only. Compressed bytes differ between zlib builds, so the
// case asserts round trips, known checksums, and error codes, never encoded lengths or payloads.
// A string input is excluded because onde rejects it while Node encodes it; that deliberate
// divergence is asserted in test/js/lib/zlib.test.js instead.

const zlib = require("node:zlib");

const payload = Buffer.from("onde zlib conformance payload");

const formats = [
    ["gzipSync", "gunzipSync", "gzip"],
    ["deflateSync", "inflateSync", "deflate"],
    ["deflateRawSync", "inflateRawSync", "deflateRaw"],
];

for (const level of [-1, 0, 1, 9]) {
    for (const [compress, decompress, name] of formats) {
        const packed = zlib[compress](payload, { level });
        const packedIsBuffer = Buffer.isBuffer(packed);
        const back = zlib[decompress](packed);
        console.log(`${name} ${level}: buffer=${packedIsBuffer} roundtrip=${back.equals(payload)}`);
    }
}

const both = Buffer.concat([
    zlib.gzipSync(Buffer.from("hello ")),
    zlib.gzipSync(Buffer.from("world")),
]);
console.log(`concat: ${zlib.gunzipSync(both).toString()}`);

console.log(`crc32: ${zlib.crc32("123456789")} ${zlib.crc32("")}`);

try {
    zlib.gunzipSync(Buffer.from("not gzip at all"));
} catch (error) {
    console.log(`corrupt: ${error.name} ${error.code}`);
}

try {
    zlib.gunzipSync(zlib.gzipSync(payload), { maxOutputLength: 4 });
} catch (error) {
    console.log(`too large: ${error.code}`);
}

try {
    zlib.gzipSync(payload, { level: 42 });
} catch (error) {
    console.log(`level: ${error.code}`);
}

zlib.gzip(payload, (error, result) => {
    console.log(
        `callback: err=${error} buffer=${Buffer.isBuffer(result)} ` +
            `same=${result.equals(zlib.gzipSync(payload))}`,
    );
});
