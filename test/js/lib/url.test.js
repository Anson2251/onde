"use strict";

// Runtime-agnostic self-check for js/lib/url.js.
// Run with `node test/js/lib/url.test.js`.

const url = require("../../../js/lib/url.js");
const { URL, URLSearchParams } = url;

let passed = 0;

function assert(condition, label, detail) {
  if (!condition) {
    console.error("not ok " + label + (detail ? " — " + detail : ""));
    process.exit(1);
  }
  passed++;
  console.log("ok " + label);
}

function assertEqual(actual, expected, label) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  assert(
    actualJson === expectedJson,
    label,
    actualJson === expectedJson ? "" : `expected ${expectedJson}, got ${actualJson}`,
  );
}

function assertThrowsURL(input, label, base) {
  try {
    // eslint-disable-next-line no-new
    new URL(input, base);
  } catch (err) {
    assert(
      err instanceof TypeError && err.code === "ERR_INVALID_URL" &&
        err.input === String(input),
      label,
      `${err.name} code=${err.code} input=${JSON.stringify(err.input)}`,
    );
    return;
  }
  assert(false, label, "did not throw");
}

// --- WHATWG URL: parsing and serialisation --------------------------------

const basic = new URL("HTTP://User:Pa%20ss@Example.COM:80/a/../b?q=a b#f g");
assertEqual(basic.href, "http://User:Pa%20ss@example.com/b?q=a%20b#f%20g", "href normalises scheme, host, port, path and query");
assertEqual(basic.protocol, "http:", "protocol getter");
assertEqual(basic.username, "User", "username getter");
assertEqual(basic.password, "Pa%20ss", "password getter keeps percent encoding");
assertEqual(basic.host, "example.com", "host getter strips the default port");
assertEqual(basic.hostname, "example.com", "hostname getter lowercases the host");
assertEqual(basic.port, "", "port getter strips the scheme's default port");
assertEqual(basic.pathname, "/b", "pathname normalises dot segments");
assertEqual(basic.search, "?q=a%20b", "search getter percent-encodes a space as %20");
assertEqual(basic.hash, "#f%20g", "hash getter percent-encodes a space");
assertEqual(basic.origin, "http://example.com", "origin for an http URL");
assertEqual(basic.toString(), basic.href, "toString() returns href");
assertEqual(basic.toJSON(), basic.href, "toJSON() returns href");

assertEqual(new URL("https://example.com:443/").href, "https://example.com/", "https default port is stripped");
assertEqual(new URL("ws://a:80/b").href, "ws://a/b", "ws default port is stripped");
assertEqual(new URL("foo://a:99/b").href, "foo://a:99/b", "non-special URLs keep explicit ports");
assertEqual(new URL("http://example.com/a/./b/../c").pathname, "/a/c", "path dot-segment normalisation");
assertEqual(new URL("http://example.com/%2e%2e/a").pathname, "/a", "percent-encoded dot segments are normalised");
assertEqual(new URL("http://example.com/%zz?x=%zz#%zz").href, "http://example.com/%zz?x=%zz#%zz", "invalid percent escapes survive in URL components");
assertEqual(new URL("http://example.com/?q='").search, "?q=%27", "special-query encodes the apostrophe");
assertEqual(new URL("foo://example.com/?q='").search, "?q='", "non-special query leaves the apostrophe");
assertEqual(new URL("http://a%2eb.com/").hostname, "a.b.com", "percent-decoded host dots");
assertEqual(new URL("http://0x7f.1/").host, "127.0.0.1", "IPv4 hex and short-form canonicalisation");
assertEqual(new URL("http://2130706433/").host, "127.0.0.1", "IPv4 decimal canonicalisation");
assertEqual(new URL("http://[0:0:0:0:0:0:0:1]/").host, "[::1]", "IPv6 compression");
assertEqual(new URL("http://[::ffff:1.2.3.4]/").host, "[::ffff:102:304]", "IPv6 embedded IPv4 serialisation");
assertEqual(new URL("http://[::1]:8080/").host, "[::1]:8080", "IPv6 host with port");
assertEqual(new URL("http://☃.net/").host, "xn--n3h.net", "Unicode host is punycoded");
assertEqual(new URL("http://faß.de/").host, "xn--fa-hia.de", "IDNA is non-transitional for ß");
assertEqual(new URL("foo://A.B/").host, "A.B", "non-special hosts are not lowercased");
assertEqual(new URL("foo://☃/").host, "%E2%98%83", "non-special hosts are percent-encoded");
assertEqual(new URL("http://u s@host/").href, "http://u%20s@host/", "userinfo encodes a space");
assertEqual(new URL("http://a@b@c/").href, "http://a%40b@c/", "only the last @ separates the host");
assertEqual(new URL("http://example.com:/").port, "", "an empty port is dropped");
assertEqual(new URL("http://example.com:00080/").port, "", "leading zeroes in a default port are dropped");

assertEqual(new URL("mailto:a@b.com").href, "mailto:a@b.com", "opaque path href");
assertEqual(new URL("mailto:a@b.com").origin, "null", "opaque URLs have a null origin");
assertEqual(new URL("data:text/plain,hi there").pathname, "text/plain,hi there", "opaque paths keep interior spaces");
assertEqual(new URL("data:hi ?x").href, "data:hi%20?x", "a trailing opaque space before a query is encoded");
assertEqual(new URL("data:hi  ").href, "data:hi", "trailing opaque spaces are removed");
assertEqual(new URL("blob:https://example.com/id").origin, "https://example.com", "blob origin comes from the inner URL");
assertEqual(new URL("blob:null/x").origin, "null", "blob with a null inner origin");

assertEqual(new URL("file:///tmp/x").href, "file:///tmp/x", "file URL with an empty host");
assertEqual(new URL("file://localhost/tmp/x").href, "file:///tmp/x", "file localhost host is emptied");
assertEqual(new URL("file:relative").href, "file:///relative", "file-relative input is rooted");
assertEqual(new URL("file:///C|/x").href, "file:///C:/x", "file drive letter normalisation");
assertEqual(new URL("file:///C:/a/../../b").href, "file:///C:/b", "file '..' cannot escape the drive root");
assertEqual(new URL("file:///tmp/x").origin, "null", "file URLs have a null origin");

// Relative resolution.
assertEqual(new URL("../d", "https://a/b/c").href, "https://a/d", "relative '../d' resolution");
assertEqual(new URL("//h/x", "https://a/b/c").href, "https://h/x", "protocol-relative resolution");
assertEqual(new URL("?q", "https://a/b/c?x#y").href, "https://a/b/c?q", "query-only relative clears the fragment");
assertEqual(new URL("#f", "https://a/b/c?x#y").href, "https://a/b/c?x#f", "fragment-only relative keeps the query");
assertEqual(new URL("", "https://a/b/c?x#y").href, "https://a/b/c?x", "empty relative keeps query, clears fragment");
assertEqual(new URL("/x/y", "https://a/b/c").href, "https://a/x/y", "absolute path resolution");
assertEqual(new URL("x/./y/../z", "https://a/b/c").href, "https://a/b/x/z", "relative path dot normalisation");
assertEqual(new URL("https:g", "https://a/b/c").href, "https://a/b/g", "same special scheme resolves relatively");
assertEqual(new URL("http:g", "https://a/b/c").href, "http://g/", "different special scheme is absolute");
assertEqual(new URL("d", "foo://a/b/c").href, "foo://a/b/d", "relative resolution for a non-special URL");
assertEqual(new URL("//h/x", "file://host/a/b").href, "file://h/x", "file protocol-relative resolution");
assertEqual(new URL("/x", "file:///C:/a/b").href, "file:///C:/x", "file absolute path inherits the drive");
assertEqual(new URL("///x", "file:///a/b").href, "file:///x", "file keeps extra slashes as path segments");

// Invalid input.
assertThrowsURL("http://exa mple.com", "space in host throws ERR_INVALID_URL");
assertThrowsURL("/foo", "relative URL without a base throws");
assertThrowsURL("http://example.com:99999", "out-of-range port throws");
assertThrowsURL("http://[::1", "unclosed IPv6 host throws");
assertThrowsURL("http://1.2.3.256/", "out-of-range IPv4 throws");
assertThrowsURL("not a url", "plain text throws");
assertEqual(URL.canParse("https://a/"), true, "URL.canParse() accepts a valid URL");
assertEqual(URL.canParse("/x"), false, "URL.canParse() rejects a relative URL without a base");
assertEqual(URL.canParse("/x", "https://a/"), true, "URL.canParse() honours a base");
assertEqual(URL.parse("not a url"), null, "URL.parse() returns null for invalid input");
assertEqual(URL.parse("/x", "https://a/b").href, "https://a/x", "URL.parse() returns a URL for valid input");

// --- Setters ---------------------------------------------------------------

const setter = new URL("https://u:p@a:8080/b?c#d");
setter.protocol = "http:";
assertEqual(setter.href, "http://u:p@a:8080/b?c#d", "protocol setter changes the scheme");
setter.protocol = "mailto:";
assertEqual(setter.protocol, "http:", "protocol setter cannot switch special to non-special");
setter.username = "x y@";
assertEqual(setter.username, "x%20y%40", "username setter encodes userinfo");
setter.password = "p:q";
assertEqual(setter.password, "p%3Aq", "password setter encodes userinfo");
setter.host = "example.com:9090";
assertEqual(setter.href, "http://x%20y%40:p%3Aq@example.com:9090/b?c#d", "host setter replaces host and port");
setter.hostname = "other.example";
assertEqual(setter.host, "other.example:9090", "hostname setter keeps the port");
setter.port = "";
assertEqual(setter.host, "other.example", "port setter with '' clears the port");
setter.port = "80";
assertEqual(setter.port, "", "port setter drops the default port");
setter.pathname = "x/../y z";
assertEqual(setter.pathname, "/y%20z", "pathname setter normalises and encodes");
setter.search = "?a b#c";
assertEqual(setter.search, "?a%20b%23c", "search setter encodes");
setter.search = "";
assertEqual(setter.href, "http://x%20y%40:p%3Aq@other.example/y%20z#d", "search setter with '' removes the query but keeps the fragment");
setter.hash = "a b";
assertEqual(setter.hash, "#a%20b", "hash setter encodes");
setter.hash = "";
assertEqual(setter.hash, "", "hash setter with '' removes the fragment");

const setterFail = new URL("https://a/b");
setterFail.href = "https://a/\t/b";
assertEqual(setterFail.href, "https://a//b", "href setter removes tab characters");
try {
  setterFail.href = "not a url";
  assert(false, "href setter throws on invalid input");
} catch (err) {
  assert(err.code === "ERR_INVALID_URL", "href setter throws on invalid input");
}

// --- URLSearchParams -------------------------------------------------------

const params = new URLSearchParams("?a=1&a=2&b=%zz&c=+x&d=%E4%B8%AD&e");
assertEqual(params.size, 6, "URLSearchParams size");
assertEqual(params.get("a"), "1", "get() returns the first value");
assertEqual(params.getAll("a"), ["1", "2"], "getAll() returns every value");
assertEqual(params.get("b"), "%zz", "invalid percent escapes survive in URLSearchParams");
assertEqual(params.get("c"), " x", "'+' decodes to a space");
assertEqual(params.get("d"), "中", "URLSearchParams decodes UTF-8");
assertEqual(params.get("e"), "", "a key without '=' has an empty value");
assertEqual(params.has("a", "2"), true, "has(name, value) matches a value");
assertEqual(params.has("a", "3"), false, "has(name, value) rejects a missing value");
assertEqual(params.toString(), "a=1&a=2&b=%25zz&c=+x&d=%E4%B8%AD&e=", "toString() re-encodes");

params.delete("a", "2");
assertEqual(params.getAll("a"), ["1"], "delete(name, value) removes only that pair");
params.set("a", "9");
assertEqual(params.toString(), "a=9&b=%25zz&c=+x&d=%E4%B8%AD&e=", "set() replaces the first value and drops the rest");
params.append("a", "10");
params.sort();
assertEqual(params.toString(), "a=9&a=10&b=%25zz&c=+x&d=%E4%B8%AD&e=", "sort() is stable");

assertEqual([...new URLSearchParams("x=1&y=2")], [["x", "1"], ["y", "2"]], "iteration yields pairs");
assertEqual([...new URLSearchParams("x=1&y=2").keys()], ["x", "y"], "keys() iterator");
assertEqual([...new URLSearchParams("x=1&y=2").values()], ["1", "2"], "values() iterator");
assertEqual(new URLSearchParams({ a: 1, b: [1, 2] }).toString(), "a=1&b=1%2C2", "object init stringifies values");
assertEqual(new URLSearchParams("?a=1").toString(), "a=1", "leading '?' is tolerated");
assertEqual(new URLSearchParams("a=1 2").toString(), "a=1+2", "spaces are serialized as '+'");

const forEachPairs = [];
new URLSearchParams("a=1&b=2").forEach((value, name, owner) => {
  forEachPairs.push([name, value, owner instanceof URLSearchParams]);
});
assertEqual(forEachPairs, [["a", "1", true], ["b", "2", true]], "forEach() receives (value, name, owner)");

// URL <-> searchParams synchronisation.
const synced = new URL("https://example.com/?a=1");
const syncedParams = synced.searchParams;
assert(synced.searchParams === syncedParams, "searchParams is a stable object");
syncedParams.append("b", "2 3");
assertEqual(synced.href, "https://example.com/?a=1&b=2+3", "mutating searchParams updates href");
synced.search = "?c=4%205";
assertEqual(syncedParams.toString(), "c=4+5", "assigning search reuses the searchParams object");
syncedParams.delete("c");
assertEqual(synced.href, "https://example.com/", "removing every param removes the '?'");
synced.href = "https://other.example/?d=6";
assert(synced.searchParams === syncedParams, "href setter keeps the searchParams object");
assertEqual(syncedParams.toString(), "d=6", "href setter refreshes searchParams contents");

// --- Legacy API ------------------------------------------------------------

const legacy = url.parse("https://u:p@example.com:8080/a/b?x=1&y=2#h");
assertEqual(legacy.protocol, "https:", "url.parse() protocol");
assertEqual(legacy.slashes, true, "url.parse() slashes flag");
assertEqual(legacy.auth, "u:p", "url.parse() splits auth from host");
assertEqual(legacy.host, "example.com:8080", "url.parse() host");
assertEqual(legacy.port, "8080", "url.parse() port");
assertEqual(legacy.hostname, "example.com", "url.parse() hostname");
assertEqual(legacy.pathname, "/a/b", "url.parse() pathname");
assertEqual(legacy.query, "x=1&y=2", "url.parse() query is a string by default");
assertEqual(legacy.search, "?x=1&y=2", "url.parse() search");
assertEqual(legacy.hash, "#h", "url.parse() hash");
assertEqual(legacy.path, "/a/b?x=1&y=2", "url.parse() path is pathname+search");

const legacyQuery = url.parse("https://example.com/?a=1&a=2", true);
assertEqual(Object.getPrototypeOf(legacyQuery.query), null, "parsed query has a null prototype");
assertEqual(legacyQuery.query.a, ["1", "2"], "parsed query turns repeated keys into arrays");

assertEqual(
  url.format({ protocol: "https:", host: "example.com", pathname: "/a b", query: { x: 1 }, hash: "h" }),
  "https://example.com/a b?x=1#h",
  "url.format() serialises a legacy object",
);
assertEqual(url.format(legacy), legacy.href, "url.format() round-trips url.parse() output");
assertEqual(url.resolve("https://a/b/c", "../d"), "https://a/d", "url.resolve() relative path");
assertEqual(url.resolve("https://a/b/c", "//h/x"), "https://h/x", "url.resolve() protocol-relative");

const httpOptions = url.urlToHttpOptions(
  new URL("https://user:p%40ss@example.com:8443/p/a?q=1#h"),
);
assertEqual(httpOptions.protocol, "https:", "urlToHttpOptions() protocol");
assertEqual(httpOptions.hostname, "example.com", "urlToHttpOptions() hostname");
assertEqual(httpOptions.port, 8443, "urlToHttpOptions() numeric port");
assertEqual(httpOptions.path, "/p/a?q=1", "urlToHttpOptions() path");
assertEqual(httpOptions.auth, "user:p@ss", "urlToHttpOptions() decoded auth");

assertEqual(url.fileURLToPath("file:///tmp/a%20b"), "/tmp/a b", "fileURLToPath() decodes");
try {
  url.fileURLToPath("file:///tmp/a%2Fb");
  assert(false, "fileURLToPath() rejects encoded slashes");
} catch (err) {
  assert(err.code === "ERR_INVALID_FILE_URL_PATH", "fileURLToPath() rejects encoded slashes");
}
assertEqual(url.pathToFileURL("/tmp/a b").href, "file:///tmp/a%20b", "pathToFileURL() encodes");
assertEqual(url.pathToFileURL("/tmp/%41").href, "file:///tmp/%2541", "pathToFileURL() escapes '%'");

assertEqual(url.domainToASCII("münchen.de"), "xn--mnchen-3ya.de", "domainToASCII()");
assertEqual(url.domainToASCII("0x7f.1"), "127.0.0.1", "domainToASCII() canonicalises IPv4");
assertEqual(url.domainToASCII("a b.com"), "", "domainToASCII() returns '' for invalid input");
assertEqual(url.domainToUnicode("xn--mnchen-3ya.de"), "münchen.de", "domainToUnicode()");
assertEqual(url.domainToUnicode("EXAMPLE.COM"), "example.com", "domainToUnicode() lowercases");

assert(url.URL === URL, "url.URL is the URL constructor");
assert(url.URLSearchParams === URLSearchParams, "url.URLSearchParams is the URLSearchParams constructor");
assert(typeof url.Url === "function", "url.Url is exported");

console.log(`# url: ${passed} assertions passed`);
