"use strict";

// Node-only differential oracle for js/lib/url.js.
//
//   node test/js/lib/url.oracle.js
//
// Compares our implementation with `node:url` over a broad input table. Every
// case must produce the same serialization/fields, or throw the same error
// name + code. Known gaps are listed in `docs/compat.md`; the few cases that
// fall outside the implemented IDNA subset are skipped explicitly below.

process.noDeprecation = true;

const assert = require("node:assert");
const nodeUrl = require("node:url");
const url = require("../../../js/lib/url.js");

let checks = 0;
const failures = [];

function attempt(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return {
      ok: false,
      name: err && err.name,
      code: err && err.code,
      input: err && err.input,
    };
  }
}

function errorShape(result) {
  const input = result.input === undefined ? "" : JSON.stringify(result.input);
  return `${result.name}:${result.code}:${input}`;
}

function expect(label, oursFn, nodeFn) {
  checks++;
  const ours = attempt(oursFn);
  const node = attempt(nodeFn);
  if (!ours.ok || !node.ok) {
    const oursShape = ours.ok ? "ok" : errorShape(ours);
    const nodeShape = node.ok ? "ok" : errorShape(node);
    if (ours.ok !== node.ok || oursShape !== nodeShape) {
      failures.push(`${label}: ours=${oursShape} node=${nodeShape}`);
    }
    return;
  }
  const a = JSON.stringify(ours.value);
  const b = JSON.stringify(node.value);
  if (a !== b) {
    failures.push(`${label}: ours=${a} node=${b}`);
  }
}

function expectURL(input, base) {
  const label = `new URL(${JSON.stringify(input)}` +
    (base === undefined ? ")" : `, ${JSON.stringify(base)})`);
  expect(label, () => {
    const parsed = new url.URL(input, base);
    return {
      href: parsed.href,
      origin: parsed.origin,
      protocol: parsed.protocol,
      username: parsed.username,
      password: parsed.password,
      host: parsed.host,
      hostname: parsed.hostname,
      port: parsed.port,
      pathname: parsed.pathname,
      search: parsed.search,
      hash: parsed.hash,
      params: parsed.searchParams.toString(),
    };
  }, () => {
    const parsed = new nodeUrl.URL(input, base);
    return {
      href: parsed.href,
      origin: parsed.origin,
      protocol: parsed.protocol,
      username: parsed.username,
      password: parsed.password,
      host: parsed.host,
      hostname: parsed.hostname,
      port: parsed.port,
      pathname: parsed.pathname,
      search: parsed.search,
      hash: parsed.hash,
      params: parsed.searchParams.toString(),
    };
  });
}

// --- URL parsing table (valid and invalid) --------------------------------

const parseInputs = [
  "https://User:Pa%20ss@Example.COM:80/a/../b?q=a b#f g",
  "http://example.com",
  "https://example.com/",
  "HTTP://A/B",
  "http://example.com/a/b?c#d",
  "http://example.com/a/./b/../c",
  "http://example.com/%2e%2e/a",
  "http://a/%2e./x",
  "http://a/..%2f/x",
  "http://a/%zz?x=%zz#%zz",
  "https://a/b?c+d",
  "http://a/b?c\\d",
  "http://a/#a\\b",
  "http://user:pass@host:8080/p",
  "http://user:@ex/",
  "http://:pass@ex/",
  "http://a@b@c/",
  "http://u s@host/",
  "http://[::1]:8080/",
  "http://[0:0:0:0:0:0:0:1]/",
  "http://[::]/",
  "http://[1:2:3:4:5:6:7:8]/",
  "http://[::ffff:1.2.3.4]/",
  "http://[1::2::3]/",
  "http://[::1]x/",
  "http://[::1]:65536/",
  "http://1.2.3.4/",
  "http://0x7f.1/",
  "http://2130706433/",
  "http://0177.0.0.1/",
  "http://0xffffffff/",
  "http://1.2.3.4.5/",
  "http://1.2.3.256/",
  "http://1.2.3.4./",
  "http://a.1/",
  "http://1a/",
  "http://0x/",
  "http://0xgg/",
  "http://08/",
  "https://example.com:443/",
  "http://example.com:/",
  "http://example.com:00080/",
  "http://example.com:65535/",
  "http://example.com:65536/",
  "http://example.com:80abc/",
  "http://a:-1/",
  "ws://a:80/",
  "wss://a:443/",
  "ftp://a:21/",
  "foo://a:99/",
  "http://",
  "http:",
  "http:/",
  "http:///x",
  "http:?x",
  "http:#y",
  "http://a?x",
  "http://a#f",
  "http://a/b?c#d?e#f",
  "http://a/#f?x",
  "https://a/b/c?x#y",
  "http://a/b/..",
  "http://a/b/../",
  "http://a/..",
  "http://a/.",
  "http://a/%2e",
  "http://a/%2e%2e/",
  "http://example.com/a b",
  "http://example.com/?a b#c d",
  "http://example.com/%2F",
  "http://example.com/a%20b",
  "http://exa%20mple.com/",
  "http://%41.com/",
  "http://a%2eb.com/",
  "http://A.B.C/",
  "http://a..b/",
  "http://.a/",
  "http://./",
  "http://a../",
  "http://☃.net/",
  "http://xn--n3h.net/",
  "http://faß.de/",
  "http://ü.com/",
  "http://%C3%BC.com/",
  "http://中文.tw/",
  "http://a%25b.com/",
  "http://%zz.com/",
  "http://%FF.com/",
  "http://a%00b/",
  "http://a\u00a0b/",
  "http://a\u200bb/",
  "http://a\u00adb.com/",
  "http://a\u200cb.com/",
  "javascript:alert(1)",
  "mailto:a@b.com",
  "data:text/plain,hi there",
  "data:text/plain;base64,aGk=",
  "data:hi  there",
  "data:hi  ",
  "data:hi ?x",
  "data:hi #y",
  "data:hi ?x#y",
  "data:",
  "data:?x",
  "data:#y",
  "data://x/y",
  "foo://a",
  "foo://a/",
  "foo://a?x",
  "foo:/a",
  "foo:/a/../b",
  "foo:a/../b",
  "foo:",
  "foo:/",
  "foo://",
  "foo:///x",
  "foo:////x",
  "foo://a//b",
  "foo://A.B/",
  "foo://a.b./",
  "foo://[::1]:80/",
  "foo://a:/",
  "foo://a:abc/",
  "foo://@a/",
  "foo://a\\b",
  "foo://☃/",
  "foo://u:p@/x",
  "foo://:/x",
  "foo://u:p@a:80/x",
  "file:",
  "file:/",
  "file://",
  "file:///",
  "file:////x",
  "file:///tmp/x",
  "file://localhost/tmp/x",
  "file://LOCALHOST/x",
  "file://host/tmp/x",
  "file:relative",
  "file:C:/x",
  "file:///C:/x",
  "file:///C|/x",
  "file:///c|/x",
  "file:///C:/a/../../b",
  "file:///C:/a/../../../b",
  "file:///c:/a/..",
  "file:///a/./b",
  "file:///a//b",
  "file:///a/",
  "file:?x",
  "file:#y",
  "file://host",
  "file://[::1]/x",
  "file://host:80/x",
  "file:///a%2Fb",
  "blob:https://example.com/id",
  "blob:null/x",
  "blob:file:///x",
  "blob:blob:https://x/y",
  "blob:https://x:99/y",
  "not a url",
  "/foo",
  "//foo",
  "",
  " ",
  "\t",
  "  https://a/  ",
  "https://a/\t/b",
  "https://a/b\n?c\r#d",
  "ftp://a/b",
  "gopher://a/",
  "custom+scheme://h/p?q#f",
  "a://b",
  "a-b.c://d",
  "+x://y",
  "1x://y",
];

for (const input of parseInputs) expectURL(input);
expectURL("https://a/b", null); // a non-URL base stringifies and fails

// --- Relative resolution ---------------------------------------------------

const relativeCases = [
  ["..", "https://a/b/c"],
  ["../d", "https://a/b/c"],
  ["../../../d", "https://a/b/c"],
  ["/x/y", "https://a/b/c"],
  ["x/./y/../z", "https://a/b/c"],
  ["", "https://a/b/c?x#y"],
  ["//", "https://a/b/c"],
  ["//h/x", "https://a/b/c"],
  ["?q", "https://a/b/c?x#y"],
  ["?q#f", "https://a/b/c?x#y"],
  ["#f", "https://a/b/c?x#y"],
  ["http:g", "https://a/b/c"],
  ["https:g", "https://a/b/c"],
  ["https:/g", "https://a/b/c"],
  ["https:", "https://a/b/c"],
  ["http:", "http://a/b"],
  ["d", "foo://a/b/c"],
  ["/d", "foo://a/b/c"],
  ["//d", "foo://a/b/c"],
  ["///a", "foo://a/b"],
  ["a", "foo://a"],
  ["a", "foo://"],
  ["//b", "foo://"],
  ["foo:d", "foo://a/b/c"],
  ["foo:/d", "foo://a/b/c"],
  ["#f", "foo:bar"],
  ["", "foo:bar"],
  ["?q", "foo:bar"],
  ["d", "foo:bar"],
  ["//h/x", "foo://a/b"],
  ["c", "file:///a/b"],
  ["/c", "file:///a/b"],
  ["?x", "file:///a/b"],
  ["#y", "file:///a/b"],
  ["..", "file:///a/b"],
  ["..", "file:///C:/a/b"],
  ["..", "file://host/a/b"],
  ["d", "file:///C:/a/b"],
  ["/x", "file:///C:/a/b"],
  ["///x", "file:///a/b"],
  ["////x", "file:///a/b"],
  ["//x", "file:///a/b"],
  ["/x", "file://host/a/b"],
  ["file:/x", "file://host/a/b"],
  ["//h/x", "file://host/a/b"],
  ["\\\\h\\x", "https://a/b/c"],
  ["\\\\h\\x", "foo://a/b"],
  ["http:\\\\g\\x", "http://a/b"],
  ["\\\\g\\x", "http://a/b"],
  ["a", "foo://a/b"],
  ["http:g", "http://a/b"],
  ["http:/g", "http://a/b"],
  ["http://g", "http://a/b"],
  ["https:g", "http://a/b"],
  ["//a", "http://b"],
  ["///a", "http://b"],
  ["////a", "http://b"],
  ["..//g", "foo:/a/b"],
  ["g?y/./x", "http://a/b/c/d;p?q"],
  ["g#s/../x", "http://a/b/c/d;p?q"],
];
for (const [relative, base] of relativeCases) expectURL(relative, base);

// --- Setters ---------------------------------------------------------------

const setterCases = [
  ["https://a/b?q#h", "protocol", "FOO:"],
  ["https://a/b", "protocol", "http:"],
  ["foo://a/b", "protocol", "https:"],
  ["file:///x", "protocol", "https:"],
  ["http://u:p@a:8080/b", "protocol", "file:"],
  ["http://a/b", "protocol", "file:"],
  ["foo://a/b", "protocol", "bar:"],
  ["https://u:p@a/", "username", "x y@"],
  ["https://a/", "username", ""],
  ["file:///x", "username", "u"],
  ["https://u:p@a/", "password", "p:q"],
  ["https://a/b", "host", "ex:8080"],
  ["https://a/b", "host", "ex"],
  ["https://a/b", "host", ""],
  ["https://a:81/b", "host", "ex:99999"],
  ["https://a:81/b", "host", "ex:"],
  ["https://x/y", "host", "a/b"],
  ["https://x/y", "host", "[::1]"],
  ["file:///x", "host", ""],
  ["file:///x", "host", "localhost"],
  ["foo://a/b", "host", "b:9"],
  ["foo://a/b", "host", ""],
  ["https://a/b:81", "hostname", "ex"],
  ["https://a/b:81", "hostname", ""],
  ["https://x/y", "hostname", "a/b"],
  ["https://x/y", "hostname", "a:9"],
  ["file://host/x", "hostname", ""],
  ["file://host/x", "hostname", "other"],
  ["foo://a/b", "hostname", "c"],
  ["https://a/b", "port", "8080"],
  ["https://a/b", "port", ""],
  ["https://a/b", "port", "443"],
  ["https://a/b", "port", "0"],
  ["https://a/b", "port", "99999"],
  ["https://a/b", "port", "80abc"],
  ["https://a:81/b", "port", "80 "],
  ["https://a:81/b", "port", " 80"],
  ["file:///x", "port", "9"],
  ["foo://a/b", "port", "9"],
  ["https://a/b", "pathname", "x/../y"],
  ["https://a/b", "pathname", "/x y"],
  ["foo://a/b", "pathname", "x"],
  ["foo://a/", "pathname", ""],
  ["foo://a", "pathname", ""],
  ["foo:/a/b", "pathname", ""],
  ["file:///a/b", "pathname", "C|/x"],
  ["file:///C:/a", "pathname", "/x/y"],
  ["file:///C:/a", "pathname", "/../x"],
  ["https://a/b?x", "search", "a b#c"],
  ["https://a/b?x", "search", "?a b"],
  ["https://a/b?x", "search", "?"],
  ["https://a/b?x", "search", ""],
  ["https://a/b?x", "hash", "#a b"],
  ["https://a/b?x", "hash", ""],
  ["https://a/b?x", "hash", "#"],
  ["https://a/b", "href", "https://c/d?e#f"],
  ["https://a/b", "href", "not a url"],
  ["https://a:81/b", "host", "ex"],
  ["foo://a:9/b", "host", "ex"],
  ["foo://a:9/b", "host", ""],
  ["foo://a:9/b", "hostname", ""],
  ["foo://u:p@a/b", "host", ""],
  ["https://a/b", "search", "\t"],
  ["https://a/b", "hash", "\t"],
  ["https://a:81/b", "port", "\t"],
  ["https://x/y", "host", "a\\b"],
  ["https://a/b", "pathname", "a\tb"],
];
for (const [base, property, value] of setterCases) {
  expect(`new URL(${JSON.stringify(base)}).${property} = ${JSON.stringify(value)}`, () => {
    const parsed = new url.URL(base);
    parsed[property] = value;
    return { href: parsed.href, params: parsed.searchParams.toString() };
  }, () => {
    const parsed = new nodeUrl.URL(base);
    parsed[property] = value;
    return { href: parsed.href, params: parsed.searchParams.toString() };
  });
}

// --- URLSearchParams -------------------------------------------------------

const paramInits = [
  ["undefined", undefined],
  ["null", null],
  ["number", 5],
  ["boolean", true],
  ["query", "a=1&a=2&b="],
  ["leading ?", "?a=1"],
  ["empty", ""],
  ["plus", "a+b=1"],
  ["invalid percent", "a=%zz"],
  ["utf8", "a=%E4%B8%AD"],
  ["empty segments", "a=1&&b=2&"],
  ["pairs", [["a", "1"], ["b", "2"]]],
  ["bad tuple length", [["a", "b", "c"]]],
  ["numeric tuple", [[1, 2]]],
  ["null tuple", [null]],
  ["map", new Map([["a", "1"]])],
  ["record", { a: 1, b: [1, 2], c: undefined, d: null, e: true }],
  ["symbol record", { a: 1, [Symbol("x")]: 2 }],
];
for (const [name, init] of paramInits) {
  expect(`new URLSearchParams(${name})`, () => {
    const params = init === undefined
      ? new url.URLSearchParams()
      : new url.URLSearchParams(init);
    return { text: params.toString(), size: params.size, pairs: [...params] };
  }, () => {
    const params = init === undefined
      ? new nodeUrl.URLSearchParams()
      : new nodeUrl.URLSearchParams(init);
    return { text: params.toString(), size: params.size, pairs: [...params] };
  });
}

expect("URLSearchParams mutation", () => {
  const params = new url.URLSearchParams("a=1&a=2&b=%zz&c=+x&=empty&e");
  params.delete("a", "2");
  params.set("a", "9");
  params.append("a", "10");
  params.sort();
  const iterated = [];
  params.forEach((value, key, owner) => {
    iterated.push([key, value, owner === params]);
  });
  return {
    text: params.toString(),
    size: params.size,
    get: params.get("a"),
    all: params.getAll("a"),
    has: params.has("a"),
    hasValue: params.has("a", "9"),
    keys: [...params.keys()],
    values: [...params.values()],
    iterated,
  };
}, () => {
  const params = new nodeUrl.URLSearchParams("a=1&a=2&b=%zz&c=+x&=empty&e");
  params.delete("a", "2");
  params.set("a", "9");
  params.append("a", "10");
  params.sort();
  const iterated = [];
  params.forEach((value, key, owner) => {
    iterated.push([key, value, owner === params]);
  });
  return {
    text: params.toString(),
    size: params.size,
    get: params.get("a"),
    all: params.getAll("a"),
    has: params.has("a"),
    hasValue: params.has("a", "9"),
    keys: [...params.keys()],
    values: [...params.values()],
    iterated,
  };
});

expect("URL <-> searchParams synchronisation", () => {
  const parsed = new url.URL("https://a/?a=1");
  const params = parsed.searchParams;
  params.append("x", "1 2");
  const afterAppend = { href: parsed.href, same: params === parsed.searchParams };
  parsed.search = "?z=1%202";
  const afterSearch = { href: parsed.href, params: params.toString() };
  parsed.href = "https://b/?b=2";
  const afterHref = { href: parsed.href, params: params.toString(), same: params === parsed.searchParams };
  params.delete("b");
  return { afterAppend, afterSearch, afterHref, afterDelete: parsed.href };
}, () => {
  const parsed = new nodeUrl.URL("https://a/?a=1");
  const params = parsed.searchParams;
  params.append("x", "1 2");
  const afterAppend = { href: parsed.href, same: params === parsed.searchParams };
  parsed.search = "?z=1%202";
  const afterSearch = { href: parsed.href, params: params.toString() };
  parsed.href = "https://b/?b=2";
  const afterHref = { href: parsed.href, params: params.toString(), same: params === parsed.searchParams };
  params.delete("b");
  return { afterAppend, afterSearch, afterHref, afterDelete: parsed.href };
});

// --- Legacy API ------------------------------------------------------------

const legacyInputs = [
  "https://u:p@example.com:8080/a/b?x=1&y=2#h",
  "http://example.com",
  "HTTP://EXAMPLE.COM/A",
  "//foo/bar?x#y",
  "foo/bar",
  "mailto:a@b.com",
  "file:///a/b",
  "/a/b?x",
  "a/b",
  "//h/p?q#f",
  "http://a/b",
  "a//b",
  "javascript:alert(1)",
  "foo:/a/b",
  "http://0x7f.1/",
  "http://a.1/",
  "http://%41.com/",
  "",
  "  https://a/b  ",
];
for (const input of legacyInputs) {
  for (const parseQuery of [false, true]) {
    for (const slashesDenoteHost of [false, true]) {
      expect(`url.parse(${JSON.stringify(input)}, ${parseQuery}, ${slashesDenoteHost})`, () => {
        const parsed = url.parse(input, parseQuery, slashesDenoteHost);
        return {
          protocol: parsed.protocol,
          slashes: parsed.slashes,
          auth: parsed.auth,
          host: parsed.host,
          port: parsed.port,
          hostname: parsed.hostname,
          hash: parsed.hash,
          search: parsed.search,
          query: parsed.query,
          pathname: parsed.pathname,
          path: parsed.path,
          href: parsed.href,
        };
      }, () => {
        const parsed = nodeUrl.parse(input, parseQuery, slashesDenoteHost);
        return {
          protocol: parsed.protocol,
          slashes: parsed.slashes,
          auth: parsed.auth,
          host: parsed.host,
          port: parsed.port,
          hostname: parsed.hostname,
          hash: parsed.hash,
          search: parsed.search,
          query: parsed.query,
          pathname: parsed.pathname,
          path: parsed.path,
          href: parsed.href,
        };
      });
      expect(`url.format(url.parse(${JSON.stringify(input)}, ${parseQuery}, ${slashesDenoteHost}))`, () => {
        return url.format(url.parse(input, parseQuery, slashesDenoteHost));
      }, () => {
        return nodeUrl.format(nodeUrl.parse(input, parseQuery, slashesDenoteHost));
      });
    }
  }
}

const legacyObjects = [
  { protocol: "https:", host: "example.com", pathname: "/a b", query: { x: 1 }, hash: "h" },
  { protocol: "https:", hostname: "example.com", port: "8080", pathname: "/a", search: "?b" },
  { protocol: "mailto:", pathname: "a@b" },
  { protocol: "file:", hostname: "", pathname: "/x" },
  { host: "h", pathname: "p" },
  { protocol: "http", host: "h", pathname: "p", query: { a: ["1", "2"] } },
  { protocol: "http:", auth: "u:p", host: "h", pathname: "/p" },
  {},
];
for (const object of legacyObjects) {
  expect(`url.format(${JSON.stringify(object)})`, () => url.format(object), () => nodeUrl.format(object));
}

const resolveCases = [
  ["https://a/b/c", "../d"],
  ["http://a/b", "//h/x"],
  ["mailto:a@b", "c@d"],
  ["mailto:local1@domain1", "local2@domain2"],
  ["//a/b", "c"],
  ["a/b", "../c"],
  ["http://a/b", ""],
  ["http://a/b?x#y", "?z"],
  ["http://a/b?x#y", "#f"],
  ["http://a/b", "http://c/d"],
  ["file:///a/b", "/c"],
  ["http://a", "?x"],
];
for (const [from, to] of resolveCases) {
  expect(`url.resolve(${JSON.stringify(from)}, ${JSON.stringify(to)})`, () => url.resolve(from, to), () => nodeUrl.resolve(from, to));
  expect(`url.resolveObject(${JSON.stringify(from)}, ${JSON.stringify(to)})`, () => {
    return JSON.stringify(url.resolveObject(from, to));
  }, () => {
    return JSON.stringify(nodeUrl.resolveObject(from, to));
  });
}

for (const [input, options] of [
  ["https://u:p@example.com:8080/a%20b/c?q=a%20b&x=%E4%B8%AD#h%20h", undefined],
  ["https://u:p@example.com/a%20b?q=a%20b#h%20h", { fragment: false }],
  ["https://u:p@example.com/a%20b?q=a%20b#h%20h", { search: false }],
  ["https://u:p@example.com/a%20b?q=a%20b#h%20h", { auth: false }],
  ["https://xn--tda.com/%E4%B8%AD?q=%E4%B8%AD#%E4%B8%AD", { unicode: true }],
  ["ftp://u:p@xn--n3h.net/a?b#c", { auth: false, search: false }],
]) {
  expect(`url.format(new URL(${JSON.stringify(input)}), ${JSON.stringify(options)})`, () => {
    return url.format(new url.URL(input), options);
  }, () => {
    return nodeUrl.format(new nodeUrl.URL(input), options);
  });
}

// --- File URLs, HTTP options, domain helpers -------------------------------

const filePaths = [
  "/tmp/a b",
  "/tmp/%41",
  "/tmp/ü",
  "/tmp/a?b#c",
  "/tmp/a/",
  "/tmp/..",
  "/tmp/./x",
  "/tmp//x",
  "/tmp/a[b]",
  "/tmp/a^b",
  "/tmp/a|b",
  "/tmp/a~b",
  "/tmp/a:b",
  "/tmp/a@b",
  "/tmp/a#b",
  "/tmp/a%b",
  "/tmp/a'b",
  "/tmp/a,b",
  "/tmp/a;b",
  "/tmp/a=b",
  "/tmp/a&b",
  "/tmp/a$b",
  "/tmp/a+b",
  "/tmp/a!b",
  "/tmp/a(b)",
  "/tmp/a*b",
  "/tmp/a.b",
  "/tmp/a_b",
  "/tmp/☃",
  "/",
];
for (const filepath of filePaths) {
  expect(`pathToFileURL(${JSON.stringify(filepath)})`, () => url.pathToFileURL(filepath).href, () => nodeUrl.pathToFileURL(filepath).href);
}
// Windows drive paths that do not hit the documented UNC/root edge cases.
for (const filepath of ["C:\\x\\y", "C:\\x\\", "C:\\x y"]) {
  expect(`pathToFileURL(${JSON.stringify(filepath)}, { windows: true })`, () => {
    return url.pathToFileURL(filepath, { windows: true }).href;
  }, () => {
    return nodeUrl.pathToFileURL(filepath, { windows: true }).href;
  });
}
// SKIP (known gap, docs/compat.md): pathToFileURL({windows: true}) for the
// bare Windows root ("/", "//") differs from Node, which emits "file:////".
// SKIP (known gap): UNC/extended-UNC path handling is minimal.

const fileURLs = [
  "file:///tmp/a%20b",
  "file:///tmp/a%2Fb",
  "file:///tmp/a%2fb",
  "file:///tmp/a%5Cb",
  "file:///tmp/a%zz",
  "file:///tmp/a%25b",
  "file:///tmp/%E4%B8%AD",
  "file:///C:/x",
  "file:///c:/x",
  "file:///C|/x",
  "file://host/x",
  "file://localhost/x",
  "file:///",
  "file:///a/../b",
  "http://a/",
];
for (const fileURL of fileURLs) {
  expect(`fileURLToPath(${JSON.stringify(fileURL)})`, () => url.fileURLToPath(fileURL), () => nodeUrl.fileURLToPath(fileURL));
}
for (const fileURL of ["file:///C:/x", "file:///c:/x%5Cy"]) {
  expect(`fileURLToPath(${JSON.stringify(fileURL)}, { windows: true })`, () => {
    return url.fileURLToPath(fileURL, { windows: true });
  }, () => {
    return nodeUrl.fileURLToPath(fileURL, { windows: true });
  });
}

const httpOptionsInputs = [
  "https://u:p%40ss@example.com:8443/p/a?q=1#h",
  "http://[::1]:8080/x",
  "https://example.com/",
  "https://u@example.com/",
  "https://:p@example.com/",
];
for (const input of httpOptionsInputs) {
  expect(`urlToHttpOptions(${JSON.stringify(input)})`, () => {
    return { ...url.urlToHttpOptions(new url.URL(input)) };
  }, () => {
    return { ...nodeUrl.urlToHttpOptions(new nodeUrl.URL(input)) };
  });
}

const domains = [
  "example.com",
  "EXAMPLE.COM",
  "faß.de",
  "☃.net",
  "xn--n3h.net",
  "a b.com",
  "",
  "中文.tw",
  "a\u00adb.com",
  "a.b.",
  ".a",
  "a..b",
  "ＡＢＣ.com",
  "ü.com",
  "%41.com",
  "a%b.com",
  "xn--",
  "xn--a-b.com",
  "A.B.C",
  "-a.com",
  "a-.com",
  "a_b.com",
  "0",
  "1.2.3",
  "0x7f.1",
  "a.1",
  "1.2.3.256",
  "example.com/path",
  "example.com?x",
  "a\tb.com",
];
for (const domain of domains) {
  expect(`domainToASCII(${JSON.stringify(domain)})`, () => url.domainToASCII(domain), () => nodeUrl.domainToASCII(domain));
  expect(`domainToUnicode(${JSON.stringify(domain)})`, () => url.domainToUnicode(domain), () => nodeUrl.domainToUnicode(domain));
}
// SKIP (known gap, docs/compat.md): full UTS46 mapping. Characters whose
// IDNA2008/UTS46 status is "disallowed" or "unassigned" (for example
// U+1E69E, U+1914C, U+FB10) are punycoded by us while Node rejects them.
// The common path — ASCII, Latin accents, CJK, Cyrillic, Greek, emoji,
// fullwidth ASCII and the RFC 3490 separators — is covered above.

// --- Statics ---------------------------------------------------------------

for (const args of [[null], [undefined], [5], [true], [""], ["/x"], ["/x", "https://a/"], ["https://a/", 5], [{ toString: () => "https://a/" }]]) {
  expect(`URL.canParse(${JSON.stringify(args)})`, () => url.URL.canParse(...args), () => nodeUrl.URL.canParse(...args));
  expect(`URL.parse(${JSON.stringify(args)})`, () => {
    const parsed = url.URL.parse(...args);
    return parsed === null ? null : parsed.href;
  }, () => {
    const parsed = nodeUrl.URL.parse(...args);
    return parsed === null ? null : parsed.href;
  });
}
expect("URL.canParse() with no arguments", () => url.URL.canParse(), () => nodeUrl.URL.canParse());
expect("URL.parse() with no arguments", () => url.URL.parse(), () => nodeUrl.URL.parse());

// Explicitly skipped cases (known gaps, see docs/compat.md).
for (const skipped of ["\u{1E69E}.com", "\uFB10.com", "\u{1914C}.com"]) {
  console.log(`# skip domainToASCII(${JSON.stringify(skipped)}) / domainToUnicode: full UTS46 mapping is not implemented`);
}
console.log('# skip pathToFileURL("/", { windows: true }): Node emits "file:////" for a bare Windows root');
console.log('# skip pathToFileURL UNC error cases: UNC handling is minimal');

// --- Report ----------------------------------------------------------------

if (failures.length > 0) {
  for (const failure of failures.slice(0, 60)) {
    console.error("MISMATCH " + failure);
  }
  if (failures.length > 60) {
    console.error(`... and ${failures.length - 60} more`);
  }
  console.error(`# url oracle: ${failures.length} mismatches out of ${checks} checks`);
  process.exit(1);
}

assert.ok(checks >= 60, "the oracle must cover at least 60 inputs");
console.log(`ok url oracle (${checks} comparisons)`);
