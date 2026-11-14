"use strict";

// Node-only differential test: js/lib/crypto.js against `node:crypto`.
//
// The lite surface talks to `__ln_host.crypto`, so this file installs a host
// shim backed by `node:crypto` before requiring the module under test. That
// exercises the JavaScript layer (argument parsing, error shapes, digest
// encoding, copy() semantics, callback delivery) against the Node oracle; the
// Rust crate has its own vector tests.
//
// Run with: node test/js/lib/crypto.oracle.js
//
// Known, documented differences (not compared below):
//   - `hkdf(...)` without a callback is a lite extension (Node's sync form is
//     `hkdfSync`), so the sync form is compared against `node:crypto.hkdfSync`.
//   - `getHashes()` is lite's five digests, not Node's OpenSSL catalog.
//   - A repeated `Hmac.digest()` throws in lite; Node v26 returns an empty
//     buffer (its own reuse quirk, DEP0206).
//   - The callback forms run on `queueMicrotask` in lite rather than a libuv
//     thread-pool request, so only their asynchronous delivery is checked.
//   - `hkdf(..., 0)` returns an empty buffer in lite; Node's OpenSSL-backed
//     `hkdfSync(..., 0)` fails with "HKDF derivation failed" (no code). RFC 5869
//     does not forbid L = 0, so the lite sync extension keeps the identity.

const assert = require("node:assert");
const nodeCrypto = require("node:crypto");

// --- host shim --------------------------------------------------------------------------------

const handles = new Map();
let nextHandle = 1;

function insert(state) {
  const id = nextHandle;
  nextHandle += 1;
  handles.set(id, state);
  return id;
}

function lookup(id) {
  const state = handles.get(id);
  if (state === undefined) throw new Error(`oracle: unknown crypto handle ${id}`);
  return state;
}

function consume(id) {
  const state = lookup(id);
  handles.delete(id);
  return state;
}

globalThis.__ln_host = {
  crypto: {
    randomBytes(size) {
      return new Uint8Array(nodeCrypto.randomBytes(size));
    },
    randomInt(min, max) {
      return nodeCrypto.randomInt(min, max);
    },
    randomUUID() {
      return nodeCrypto.randomUUID();
    },
    hashNew(algorithm) {
      return insert(nodeCrypto.createHash(algorithm));
    },
    hashUpdate(id, data) {
      lookup(id).update(Buffer.from(data));
    },
    hashDigest(id) {
      return new Uint8Array(consume(id).digest());
    },
    hashCopy(id) {
      return insert(lookup(id).copy());
    },
    hmacNew(algorithm, key) {
      return insert(nodeCrypto.createHmac(algorithm, Buffer.from(key)));
    },
    hmacUpdate(id, data) {
      lookup(id).update(Buffer.from(data));
    },
    hmacDigest(id) {
      return new Uint8Array(consume(id).digest());
    },
    timingSafeEqual(a, b) {
      return nodeCrypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    },
    hkdf(algorithm, ikm, salt, info, length) {
      const bits = nodeCrypto.hkdfSync(
        algorithm,
        Buffer.from(ikm),
        Buffer.from(salt),
        Buffer.from(info),
        length,
      );
      return new Uint8Array(bits);
    },
  },
};

const liteCrypto = require("../../../js/lib/crypto.js");

function valueOf(api, digest) {
  return Buffer.isBuffer(digest) ? `buf:${digest.toString("hex")}` : `str:${digest}`;
}

function capture(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return {
      name: error && error.constructor ? error.constructor.name : typeof error,
      code: error && error.code,
      message: error && error.message,
    };
  }
}

// --- digests ----------------------------------------------------------------------------------

const ALGORITHMS = ["md5", "sha1", "sha224", "sha256", "sha384", "sha512", "sha512-224", "sha512-256"];
const ENCODINGS = [undefined, "hex", "base64", "base64url", "latin1", "utf8", "nope", 5, "buffer"];

function checkHashes() {
  for (const algorithm of ALGORITHMS) {
    for (const encoding of ENCODINGS) {
      const lite = valueOf(
        liteCrypto,
        encoding === undefined
          ? liteCrypto.createHash(algorithm).update("abc").digest()
          : liteCrypto.createHash(algorithm).update("abc").digest(encoding),
      );
      const node = valueOf(
        nodeCrypto,
        encoding === undefined
          ? nodeCrypto.createHash(algorithm).update("abc").digest()
          : nodeCrypto.createHash(algorithm).update("abc").digest(encoding),
      );
      assert.deepStrictEqual(lite, node, `${algorithm} digest(${String(encoding)})`);
    }
  }

  // Case-insensitive and OpenSSL-style spellings.
  for (const algorithm of ["SHA256", "Sha512", "sha-256", "sha-1", "sha2-384", "sha2-224", "sha-512/224", "sha2-512/256"]) {
    assert.deepStrictEqual(
      liteCrypto.createHash(algorithm).update("abc").digest("hex"),
      nodeCrypto.createHash(algorithm).update("abc").digest("hex"),
      `algorithm alias ${algorithm}`,
    );
  }

  // Multiple updates, string encodings, views and odd view offsets.
  const lite = liteCrypto.createHash("sha256");
  const node = nodeCrypto.createHash("sha256");
  for (const chunk of [
    "616263",
    Buffer.from("def"),
    new Uint8Array([0x67, 0x68, 0x69]),
    new Uint8Array([0, 0x6a, 0x6b, 0x6c, 0]).subarray(1, 4),
    new DataView(new Uint8Array([0x6d, 0x6e, 0x6f]).buffer),
  ]) {
    lite.update(chunk, typeof chunk === "string" ? "hex" : undefined);
    node.update(chunk, typeof chunk === "string" ? "hex" : undefined);
  }
  assert.deepStrictEqual(lite.digest("hex"), node.digest("hex"), "chunked updates with views");

  // copy() snapshots, and the original continues independently.
  const liteTail = liteCrypto.createHash("sha256").update("abc");
  const liteSnapshot = liteTail.copy();
  liteTail.update("def");
  const nodeTail = nodeCrypto.createHash("sha256").update("abc");
  const nodeSnapshot = nodeTail.copy();
  nodeTail.update("def");
  assert.deepStrictEqual(
    [liteSnapshot.digest("hex"), liteTail.digest("hex")],
    [nodeSnapshot.digest("hex"), nodeTail.digest("hex")],
    "copy() independence",
  );

  // A string digest encoding is honoured case-insensitively.
  assert.deepStrictEqual(
    liteCrypto.createHash("sha256").update("abc").digest("HEX"),
    nodeCrypto.createHash("sha256").update("abc").digest("HEX"),
    "uppercase digest encoding",
  );
}

// --- HMAC -------------------------------------------------------------------------------------

function checkHmac() {
  const keys = [
    "Jefe",
    Buffer.from("Jefe"),
    new Uint8Array([0x4a, 0x65, 0x66, 0x65]),
    new Uint8Array([0, 0x4a, 0x65, 0x66, 0x65, 0]).subarray(1, 5),
    Buffer.from([0x0b, 0x0b, 0x0b, 0x0b]),
  ];
  const data = ["what do ya want for nothing?", Buffer.from("Hi There")];

  for (const algorithm of ALGORITHMS) {
    for (const key of keys) {
      for (const chunk of data) {
        assert.deepStrictEqual(
          liteCrypto.createHmac(algorithm, key).update(chunk).digest("hex"),
          nodeCrypto.createHmac(algorithm, key).update(chunk).digest("hex"),
          `hmac ${algorithm}`,
        );
      }
    }
  }

  // An ArrayBuffer key and a zero-length key. The ArrayBuffer must be exactly sized: a pooled
  // Buffer's `.buffer` is the whole 8 KiB pool, whose other bytes are allocation-order dependent.
  const exactArrayBuffer = new Uint8Array([0x4a, 0x65, 0x66, 0x65]).buffer;
  assert.deepStrictEqual(
    liteCrypto.createHmac("sha256", exactArrayBuffer).update("x").digest("hex"),
    nodeCrypto.createHmac("sha256", exactArrayBuffer).update("x").digest("hex"),
    "hmac ArrayBuffer key",
  );
  assert.deepStrictEqual(
    liteCrypto.createHmac("sha256", "").update("x").digest("hex"),
    nodeCrypto.createHmac("sha256", "").update("x").digest("hex"),
    "hmac empty key",
  );
}

// --- HKDF -------------------------------------------------------------------------------------

function checkHkdf() {
  const ikm = Buffer.from("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b", "hex");
  const salt = Buffer.from("000102030405060708090a0b0c", "hex");
  const info = Buffer.from("f0f1f2f3f4f5f6f7f8f9", "hex");
  const sizes = { md5: 16, sha1: 20, sha224: 28, sha256: 32, sha384: 48, sha512: 64, "sha512-224": 28, "sha512-256": 32 };

  for (const algorithm of ALGORITHMS) {
    for (const length of [1, 16, 42, 255 * sizes[algorithm]]) {
      assert.deepStrictEqual(
        liteCrypto.hkdf(algorithm, ikm, salt, info, length).toString("hex"),
        Buffer.from(nodeCrypto.hkdfSync(algorithm, ikm, salt, info, length)).toString("hex"),
        `hkdf ${algorithm} length ${length}`,
      );
    }
  }

  // Node accepts strings for ikm/salt/info as utf8.
  assert.deepStrictEqual(
    liteCrypto.hkdf("sha256", "ikm", "salt", "info", 32).toString("hex"),
    Buffer.from(nodeCrypto.hkdfSync("sha256", "ikm", "salt", "info", 32)).toString("hex"),
    "hkdf string byte sources",
  );

  // Empty salt and info behave like RFC 5869's zero-filled defaults.
  assert.deepStrictEqual(
    liteCrypto.hkdf("sha256", ikm, Buffer.alloc(0), Buffer.alloc(0), 42).toString("hex"),
    Buffer.from(nodeCrypto.hkdfSync("sha256", ikm, Buffer.alloc(0), Buffer.alloc(0), 42)).toString("hex"),
    "hkdf empty salt and info",
  );
}

// --- hkdfSync ---------------------------------------------------------------------------------

function checkHkdfSync() {
  const ikm = Buffer.from("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b", "hex");
  const salt = Buffer.from("000102030405060708090a0b0c", "hex");
  const info = Buffer.from("f0f1f2f3f4f5f6f7f8f9", "hex");
  const sizes = { md5: 16, sha1: 20, sha224: 28, sha256: 32, sha384: 48, sha512: 64, "sha512-224": 28, "sha512-256": 32 };

  for (const algorithm of ALGORITHMS) {
    for (const length of [1, 16, 42, 255 * sizes[algorithm]]) {
      compare(
        `hkdfSync ${algorithm} length ${length}`,
        () => liteCrypto.hkdfSync(algorithm, ikm, salt, info, length),
        () => nodeCrypto.hkdfSync(algorithm, ikm, salt, info, length),
      );
    }
  }

  const cases = [
    ["hkdfSync digest type", (c) => c(5, Buffer.alloc(4), Buffer.alloc(0), Buffer.alloc(0), 16)],
    ["hkdfSync ikm number", (c) => c("sha256", 5, Buffer.alloc(0), Buffer.alloc(0), 16)],
    ["hkdfSync salt null", (c) => c("sha256", Buffer.alloc(4), null, Buffer.alloc(0), 16)],
    ["hkdfSync length negative", (c) => c("sha256", Buffer.alloc(4), Buffer.alloc(0), Buffer.alloc(0), -1)],
    ["hkdfSync length fractional", (c) => c("sha256", Buffer.alloc(4), Buffer.alloc(0), Buffer.alloc(0), 1.5)],
    ["hkdfSync info too long", (c) => c("sha256", Buffer.alloc(4), Buffer.alloc(0), Buffer.alloc(1025), 16)],
    ["hkdfSync unknown digest", (c) => c("nope", Buffer.alloc(4), Buffer.alloc(0), Buffer.alloc(0), 16)],
    ["hkdfSync oversized output", (c) => c("sha256", Buffer.alloc(4), Buffer.alloc(0), Buffer.alloc(0), 8161)],
  ];
  for (const [label, call] of cases) {
    compare(label, () => call(liteCrypto.hkdfSync), () => call(nodeCrypto.hkdfSync));
  }
}

// --- error parity -----------------------------------------------------------------------------

function checkErrors() {
  const cases = [
    ["createHash unknown", (c) => c.createHash("nope")],
    ["createHash bad alias sha512/224", (c) => c.createHash("sha512/224")],
    ["createHash bad alias sha-512-224", (c) => c.createHash("sha-512-224")],
    ["createHash non-string", (c) => c.createHash(5)],
    ["createHash missing", (c) => c.createHash()],
    ["createHash String object", (c) => c.createHash(new String("sha256"))],
    ["hash update number", (c) => c.createHash("sha256").update(5)],
    ["hash update null", (c) => c.createHash("sha256").update(null)],
    ["hash update ArrayBuffer", (c) => c.createHash("sha256").update(new ArrayBuffer(2))],
    ["hash update String object", (c) => c.createHash("sha256").update(new String("abc"))],
    ["hash update odd hex", (c) => c.createHash("sha256").update("abc", "hex")],
    ["hash digest twice", (c) => {
      const hash = c.createHash("sha256");
      hash.digest();
      return hash.digest();
    }],
    ["hash update after digest", (c) => {
      const hash = c.createHash("sha256");
      hash.digest();
      return hash.update("x");
    }],
    ["hash copy after digest", (c) => {
      const hash = c.createHash("sha256");
      hash.digest();
      return hash.copy();
    }],
    ["hmac unknown digest", (c) => c.createHmac("nope", "k")],
    ["hmac non-string digest", (c) => c.createHmac(5, "k")],
    ["hmac number key", (c) => c.createHmac("sha256", 5)],
    ["hmac missing key", (c) => c.createHmac("sha256")],
    ["hmac update after digest", (c) => {
      const hmac = c.createHmac("sha256", "k");
      hmac.update("x");
      hmac.digest();
      return hmac.update("y");
    }],
    ["randomBytes negative", (c) => c.randomBytes(-1)],
    ["randomBytes too large", (c) => c.randomBytes(2147483648)],
    ["randomBytes NaN", (c) => c.randomBytes(NaN)],
    ["randomBytes string", (c) => c.randomBytes("4")],
    ["randomBytes boolean", (c) => c.randomBytes(true)],
    ["randomBytes bad callback", (c) => c.randomBytes(4, 5)],
    ["randomBytes null callback", (c) => c.randomBytes(4, null)],
    ["randomInt empty range", (c) => c.randomInt(5, 5)],
    ["randomInt inverted range", (c) => c.randomInt(0, -5)],
    ["randomInt range too wide", (c) => c.randomInt(0, 281474976710656)],
    ["randomInt fractional min", (c) => c.randomInt(1.5, 3)],
    ["randomInt fractional max", (c) => c.randomInt(0, 1.5)],
    ["randomInt unsafe integer", (c) => c.randomInt(0, 2 ** 53)],
    ["randomInt string", (c) => c.randomInt("1", 3)],
    ["randomInt bad callback", (c) => c.randomInt(2, 5, 7)],
    ["randomUUID number", (c) => c.randomUUID(5)],
    ["randomUUID null", (c) => c.randomUUID(null)],
    ["timingSafeEqual length", (c) => c.timingSafeEqual(Buffer.from("ab"), Buffer.from("abc"))],
    ["timingSafeEqual buf1", (c) => c.timingSafeEqual("ab", Buffer.from("ab"))],
    ["timingSafeEqual buf2", (c) => c.timingSafeEqual(Buffer.from("ab"), "ab")],
    ["timingSafeEqual null", (c) => c.timingSafeEqual(null, null)],
  ];

  for (const [label, call] of cases) {
    // Clone the argument construction per API: Buffer/typed values are not mutated by the call,
    // so passing a builder is enough for these argument-only errors.
    assert.deepStrictEqual(capture(() => call(liteCrypto)), capture(() => call(nodeCrypto)), label);
  }

  // hkdf validates its parameters in Node's order; the lite sync form mirrors `hkdfSync`.
  const hkdfCases = [
    ["hkdf digest type", (c) => c(5, Buffer.alloc(4), Buffer.alloc(0), Buffer.alloc(0), 16)],
    ["hkdf ikm number", (c) => c("sha256", 5, Buffer.alloc(0), Buffer.alloc(0), 16)],
    ["hkdf ikm undefined", (c) => c("sha256", undefined, Buffer.alloc(0), Buffer.alloc(0), 16)],
    ["hkdf salt null", (c) => c("sha256", Buffer.alloc(4), null, Buffer.alloc(0), 16)],
    ["hkdf salt number", (c) => c("sha256", Buffer.alloc(4), Buffer.alloc(0), 5, 16)],
    ["hkdf length undefined", (c) => c("sha256", Buffer.alloc(4), Buffer.alloc(0), Buffer.alloc(0), undefined)],
    ["hkdf length negative", (c) => c("sha256", Buffer.alloc(4), Buffer.alloc(0), Buffer.alloc(0), -1)],
    ["hkdf length fractional", (c) => c("sha256", Buffer.alloc(4), Buffer.alloc(0), Buffer.alloc(0), 1.5)],
    ["hkdf info too long", (c) => c("sha256", Buffer.alloc(4), Buffer.alloc(0), Buffer.alloc(1025), 16)],
    ["hkdf unknown digest", (c) => c("nope", Buffer.alloc(4), Buffer.alloc(0), Buffer.alloc(0), 16)],
    ["hkdf oversized output", (c) => c("sha256", Buffer.alloc(4), Buffer.alloc(0), Buffer.alloc(0), 8161)],
    ["hkdf unknown digest beats keylen", (c) => c("nope", Buffer.alloc(4), Buffer.alloc(0), Buffer.alloc(0), 9000)],
  ];
  for (const [label, call] of hkdfCases) {
    assert.deepStrictEqual(
      capture(() => call(liteCrypto.hkdf)),
      capture(() => call(nodeCrypto.hkdfSync)),
      label,
    );
  }

  // The callback slot is validated last, after the parameters.
  assert.deepStrictEqual(
    capture(() => liteCrypto.hkdf("sha256", Buffer.alloc(4), Buffer.alloc(0), Buffer.alloc(0), 16, 7)),
    capture(() => nodeCrypto.hkdf("sha256", Buffer.alloc(4), Buffer.alloc(0), Buffer.alloc(0), 16, 7)),
    "hkdf bad callback",
  );
}

// --- timingSafeEqual values -------------------------------------------------------------------

function checkTimingSafeEqual() {
  const left = Buffer.from("0001020304050607", "hex");
  const right = Buffer.from("0001020304050607", "hex");
  const different = Buffer.from("0001020304050608", "hex");
  assert.strictEqual(
    liteCrypto.timingSafeEqual(left, right),
    nodeCrypto.timingSafeEqual(left, right),
    "timingSafeEqual equal buffers",
  );
  assert.strictEqual(
    liteCrypto.timingSafeEqual(left, different),
    nodeCrypto.timingSafeEqual(left, different),
    "timingSafeEqual different buffers",
  );
  assert.strictEqual(
    liteCrypto.timingSafeEqual(new Uint8Array([0, 1, 2]).subarray(1), new Uint8Array([1, 2, 3]).subarray(0, 2)),
    nodeCrypto.timingSafeEqual(new Uint8Array([0, 1, 2]).subarray(1), new Uint8Array([1, 2, 3]).subarray(0, 2)),
    "timingSafeEqual uses the view bytes",
  );
  assert.strictEqual(
    liteCrypto.timingSafeEqual(new ArrayBuffer(0), new ArrayBuffer(0)),
    nodeCrypto.timingSafeEqual(new ArrayBuffer(0), new ArrayBuffer(0)),
    "timingSafeEqual empty ArrayBuffers",
  );
}

// --- one-shot hash, randomFill and getRandomValues --------------------------------------------

function normalize(value) {
  if (Buffer.isBuffer(value)) return `buf:${value.toString("hex")}`;
  if (typeof value === "string") return `str:${value}`;
  if (ArrayBuffer.isView(value)) return `${value.constructor.name}:${value.byteLength}`;
  if (value instanceof ArrayBuffer) return `ab:${value.byteLength}`;
  return String(value);
}

function result(fn) {
  try {
    return { ok: normalize(fn()) };
  } catch (error) {
    return {
      error: {
        // DOMException subclasses report their legacy name on `.name`, not the constructor.
        name: error && error.name,
        code: error && error.code,
        message: error && error.message,
      },
    };
  }
}

function compare(label, liteCall, nodeCall) {
  assert.deepStrictEqual(result(liteCall), result(nodeCall), label);
}

function checkOneShotHash() {
  const cases = [
    ["sha256", "abc"],
    ["sha224", "abc", "hex"],
    ["sha512-256", "abc", "base64"],
    ["md5", Buffer.from("abc"), "latin1"],
    ["sha256", "abc", { outputEncoding: "hex" }],
    ["sha256", "abc", { outputEncoding: "buffer" }],
    ["sha256", "abc", { outputEncoding: "base64url" }],
    ["sha256", "abc", {}],
    ["sha256", "abc", ""],
    ["sha256", "abc", "nope"],
    ["sha256", "abc", 5],
    ["sha256", "abc", null],
    ["nope", "abc"],
    ["nope", "abc", "bad"],
    ["sha256", 5],
    ["sha256", "abc", { outputEncoding: 5 }],
    ["sha256", new Uint8Array([97, 98, 99])],
    ["sha256", new DataView(new Uint8Array([97, 98, 99]).buffer)],
    ["sha256", new Uint8Array([97, 98, 99]).buffer],
    ["sha256", new String("abc")],
    [5, "abc"],
    ["sha256"],
  ];
  for (const args of cases) {
    compare(
      `hash(${args.map((value) => String(value)).join(", ")})`,
      () => liteCrypto.hash(...args),
      () => nodeCrypto.hash(...args),
    );
  }
}

function checkRandomFill() {
  const errorCases = [
    ["randomFillSync()", (c) => c.randomFillSync()],
    ["randomFillSync(string)", (c) => c.randomFillSync("abcd")],
    ["randomFillSync(null)", (c) => c.randomFillSync(null)],
    ["randomFillSync(offset 5)", (c) => c.randomFillSync(Buffer.alloc(4), 5)],
    ["randomFillSync(offset -1)", (c) => c.randomFillSync(Buffer.alloc(4), -1)],
    ["randomFillSync(offset NaN)", (c) => c.randomFillSync(Buffer.alloc(4), NaN)],
    ["randomFillSync(offset 4.9)", (c) => c.randomFillSync(Buffer.alloc(4), 4.9)],
    ["randomFillSync(offset string)", (c) => c.randomFillSync(Buffer.alloc(4), "1")],
    ["randomFillSync(size 5)", (c) => c.randomFillSync(Buffer.alloc(4), 0, 5)],
    ["randomFillSync(size -1)", (c) => c.randomFillSync(Buffer.alloc(4), 0, -1)],
    ["randomFillSync(size string)", (c) => c.randomFillSync(Buffer.alloc(4), 0, "1")],
    ["randomFillSync(size+offset 5)", (c) => c.randomFillSync(Buffer.alloc(4), 1, 4)],
    ["randomFill(no callback)", (c) => c.randomFill(Buffer.alloc(4))],
    ["randomFill(bad buf)", (c) => c.randomFill("x", () => {})],
    ["randomFill(bad offset)", (c) => c.randomFill(Buffer.alloc(4), "2", () => {})],
    ["randomFill(bad offset range)", (c) => c.randomFill(Buffer.alloc(4), 9, () => {})],
    ["randomFill(bad callback)", (c) => c.randomFill(Buffer.alloc(4), 5)],
  ];
  for (const [label, call] of errorCases) {
    compare(label, () => call(liteCrypto), () => call(nodeCrypto));
  }

  // Identity and the written window are the observable parts of a successful fill.
  for (const [label, make] of [
    ["Buffer", () => Buffer.alloc(4)],
    ["Uint8Array", () => new Uint8Array(4)],
    ["ArrayBuffer", () => new ArrayBuffer(4)],
    ["DataView", () => new DataView(new ArrayBuffer(4))],
    ["SharedArrayBuffer", () => new SharedArrayBuffer(4)],
  ]) {
    const lite = make();
    const node = make();
    assert.strictEqual(liteCrypto.randomFillSync(lite), lite, `randomFillSync returns ${label}`);
    assert.strictEqual(nodeCrypto.randomFillSync(node), node, `node randomFillSync returns ${label}`);
  }

  const liteWindow = Buffer.alloc(4, 0xaa);
  const nodeWindow = Buffer.alloc(4, 0xaa);
  liteCrypto.randomFillSync(liteWindow, 1, 2);
  nodeCrypto.randomFillSync(nodeWindow, 1, 2);
  assert.strictEqual(liteWindow[0], 0xaa, "randomFillSync leaves bytes before the window alone");
  assert.strictEqual(liteWindow[3], 0xaa, "randomFillSync leaves bytes after the window alone");
  assert.strictEqual(nodeWindow[0], 0xaa, "node randomFillSync leaves bytes before the window alone");
  assert.strictEqual(nodeWindow[3], 0xaa, "node randomFillSync leaves bytes after the window alone");
}

async function checkRandomFillAsync() {
  const liteBuffer = Buffer.alloc(4);
  const nodeBuffer = Buffer.alloc(4);
  let liteSync = true;
  let nodeSync = true;
  const liteResult = await new Promise((resolve) => {
    liteCrypto.randomFill(liteBuffer, 1, 2, (error, filled) => {
      resolve({ isSync: liteSync, error, same: filled === liteBuffer });
    });
    liteSync = false;
  });
  const nodeResult = await new Promise((resolve) => {
    nodeCrypto.randomFill(nodeBuffer, 1, 2, (error, filled) => {
      resolve({ isSync: nodeSync, error, same: filled === nodeBuffer });
    });
    nodeSync = false;
  });
  assert.deepStrictEqual(liteResult, nodeResult, "randomFill callback contract");
  assert.strictEqual(liteResult.isSync, false, "randomFill calls back asynchronously");
}

function checkGetRandomValues() {
  for (const make of [
    () => new Uint8Array(4),
    () => new Uint16Array(2),
    () => new Int32Array(1),
    () => new Uint8ClampedArray(4),
    () => new BigInt64Array(1),
    () => new Uint8Array(new SharedArrayBuffer(4)),
    () => new Uint8Array(65536),
    () => Buffer.alloc(4),
    () => {
      class CustomBytes extends Uint8Array {}
      return new CustomBytes(4);
    },
  ]) {
    const lite = make();
    const node = make();
    assert.strictEqual(liteCrypto.getRandomValues(lite), lite, "getRandomValues returns its argument");
    assert.strictEqual(nodeCrypto.getRandomValues(node), node, "node getRandomValues returns its argument");
  }

  const errorCases = [
    ["getRandomValues()", (c) => c.getRandomValues()],
    ["getRandomValues(5)", (c) => c.getRandomValues(5)],
    ["getRandomValues(DataView)", (c) => c.getRandomValues(new DataView(new ArrayBuffer(4)))],
    ["getRandomValues(Float64Array)", (c) => c.getRandomValues(new Float64Array(1))],
    ["getRandomValues(too big)", (c) => c.getRandomValues(new Uint8Array(65537))],
  ];
  for (const [label, call] of errorCases) {
    compare(label, () => call(liteCrypto), () => call(nodeCrypto));
  }
}

// --- callback forms ---------------------------------------------------------------------------

async function checkCallbacks() {
  let synchronous = true;
  const results = await new Promise((resolve) => {
    const out = {};
    let pending = 3;
    const done = () => {
      pending -= 1;
      if (pending === 0) resolve(out);
    };

    liteCrypto.randomBytes(8, (error, bytes) => {
      out.bytes = { error, isBuffer: Buffer.isBuffer(bytes), length: bytes && bytes.length };
      done();
    });
    liteCrypto.randomInt(1, 10, (error, value) => {
      out.int = { error, value };
      done();
    });
    liteCrypto.hkdf(
      "sha256",
      Buffer.from("ikm"),
      Buffer.from("salt"),
      Buffer.from("info"),
      16,
      (error, output) => {
        out.hkdf = {
          error,
          isArrayBuffer: output instanceof ArrayBuffer,
          hex: Buffer.from(output).toString("hex"),
        };
        done();
      },
    );
    synchronous = false;
  });

  assert.strictEqual(synchronous, false, "callbacks are asynchronous");
  assert.deepStrictEqual(results.bytes, { error: null, isBuffer: true, length: 8 }, "randomBytes callback");
  assert.strictEqual(results.int.error, null, "randomInt callback has no error");
  assert.ok(results.int.value >= 1 && results.int.value < 10, "randomInt callback value in range");
  assert.strictEqual(results.hkdf.error, null, "hkdf callback has no error");
  assert.strictEqual(results.hkdf.isArrayBuffer, true, "hkdf callback yields an ArrayBuffer");
  assert.deepStrictEqual(
    results.hkdf.hex,
    Buffer.from(nodeCrypto.hkdfSync("sha256", "ikm", "salt", "info", 16)).toString("hex"),
    "hkdf callback output matches hkdfSync",
  );
}

// --- surface ----------------------------------------------------------------------------------

function checkSurface() {
  assert.deepStrictEqual(
    liteCrypto.getHashes(),
    ["md5", "sha1", "sha224", "sha256", "sha384", "sha512", "sha512-224", "sha512-256"],
    "getHashes lists the supported digests",
  );
  const uuid = liteCrypto.randomUUID();
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  // randomUUIDv7: same shape and timestamp prefix, values are random so only structure is
  // compared against the Node oracle.
  const v7 = liteCrypto.randomUUIDv7();
  const nodeV7 = nodeCrypto.randomUUIDv7();
  assert.match(v7, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(nodeV7, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const prefix = (value) => Number.parseInt(value.slice(0, 8) + value.slice(9, 13), 16);
  const now = Date.now();
  assert.ok(Math.abs(prefix(v7) - now) < 1000, "randomUUIDv7 timestamp is current");
  for (const args of [[{ disableEntropyCache: true }], [5], [null], [{ disableEntropyCache: 5 }]]) {
    compare(
      `randomUUIDv7(${args.map((value) => String(value)).join(", ")})`,
      () => {
        const value = liteCrypto.randomUUIDv7(...args);
        return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
          ? "v7"
          : value;
      },
      () => {
        const value = nodeCrypto.randomUUIDv7(...args);
        return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
          ? "v7"
          : value;
      },
    );
  }
}

// Deliberate M3 gap, asserted rather than skipped: Node's OpenSSL accepts SHA-3 and the
// truncated SHA-256 variants; lite supports the digests listed in docs/compat.md and rejects the
// rest. Keeping this explicit stops the divergence from silently disappearing from the oracle.
function checkUnsupportedDigests() {
  for (const algorithm of ["sha3-256", "sha3-512", "sha256-192", "ripemd160"]) {
    assert.throws(
      () => liteCrypto.createHash(algorithm),
      /Digest method not supported/,
      `lite rejects unsupported digest ${algorithm}`,
    );
    assert.doesNotThrow(
      () => nodeCrypto.createHash(algorithm),
      `node supports ${algorithm}`,
    );
  }
}

async function main() {
  checkHashes();
  checkHmac();
  checkHkdf();
  checkHkdfSync();
  checkErrors();
  checkUnsupportedDigests();
  checkTimingSafeEqual();
  checkSurface();
  checkOneShotHash();
  checkRandomFill();
  checkGetRandomValues();
  await checkRandomFillAsync();
  await checkCallbacks();
  console.log("crypto.oracle.js: all differential checks passed");
}

main().catch((error) => {
  console.error("crypto.oracle.js failed:", error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
