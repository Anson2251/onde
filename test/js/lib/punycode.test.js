"use strict";

// Runtime-agnostic self-check for js/lib/punycode.js.
// Run with `node test/js/lib/punycode.test.js`.

const punycode = require("../../../js/lib/punycode.js");

let passed = 0;

function assert(condition, label) {
  if (!condition) {
    console.error("not ok " + label);
    process.exit(1);
  }
  passed++;
  console.log("ok " + label);
}

function assertEqual(actual, expected, label) {
  const same = actual === expected;
  assert(
    same,
    label + (same ? "" : ` (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`),
  );
}

function assertThrows(fn, ErrorType, message, label) {
  try {
    fn();
  } catch (err) {
    const okType = err instanceof ErrorType;
    const okMessage = message === undefined || err.message === message;
    assert(
      okType && okMessage,
      label + (okType && okMessage ? "" : ` (got ${err.name}: ${err.message})`),
    );
    return;
  }
  assert(false, label + " (did not throw)");
}

assertEqual(punycode.version, "2.1.0", "version is 2.1.0");
assertEqual(punycode.encode(""), "", "encode() of empty string");
assertEqual(punycode.encode("abc"), "abc-", "encode() passes ASCII through");
assertEqual(punycode.encode("mañana"), "maana-pta", "encode() handles a Latin accent");
assertEqual(punycode.encode("☃-⌘"), "--dqo34k", "encode() handles non-BMP input");
assertEqual(punycode.decode("maana-pta"), "mañana", "decode() reverses encode()");
assertEqual(punycode.decode("--dqo34k"), "☃-⌘", "decode() handles a surrogate pair");
assertEqual(punycode.decode(punycode.encode("中文")), "中文", "encode/decode round-trip");
assertEqual(punycode.decode("bcher-kva"), "bücher", "decode() of a known label");
assertEqual(punycode.toASCII("münchen.de"), "xn--mnchen-3ya.de", "toASCII() encodes each label");
assertEqual(punycode.toASCII("EXAMPLE.COM"), "EXAMPLE.COM", "toASCII() leaves ASCII untouched");
assertEqual(punycode.toUnicode("xn--mnchen-3ya.de"), "münchen.de", "toUnicode() decodes labels");
assertEqual(punycode.toUnicode("xn--n3h.net"), "☃.net", "toUnicode() of the snowman domain");
assertEqual(
  punycode.toASCII("user@münchen.de"),
  "user@xn--mnchen-3ya.de",
  "toASCII() only maps the domain part of an email",
);
assertEqual(
  punycode.toUnicode("user@xn--mnchen-3ya.de"),
  "user@münchen.de",
  "toUnicode() only maps the domain part of an email",
);
assertEqual(punycode.toASCII("a。b"), "a.b", "toASCII() normalises RFC 3490 dot separators");
assertEqual(
  punycode.toUnicode("xn--n3h。net"),
  "☃.net",
  "toUnicode() normalises RFC 3490 dot separators",
);
assertEqual(JSON.stringify(punycode.ucs2.decode("𝌆")), "[119558]", "ucs2.decode() combines surrogate pairs");
assertEqual(punycode.ucs2.encode([119558]), "𝌆", "ucs2.encode() emits surrogate pairs");
assertEqual(JSON.stringify(punycode.ucs2.decode("\uD800a")), "[55296,97]", "ucs2.decode() keeps lone surrogates");
assertThrows(() => punycode.decode("xn--a-b"), RangeError, "Invalid input", "decode() rejects invalid input");
assertThrows(() => punycode.decode("é"), RangeError, "Invalid input", "decode() rejects non-basic bytes");
assertThrows(() => punycode.decode("é-a"), RangeError, "Illegal input >= 0x80 (not a basic code point)", "decode() rejects non-basic bytes before the delimiter");
assertThrows(
  () => punycode.decode("999999999999999999"),
  RangeError,
  "Overflow: input needs wider integers to process",
  "decode() reports overflow with a RangeError",
);

console.log(`# punycode: ${passed} assertions passed`);
