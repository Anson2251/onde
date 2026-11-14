"use strict";

// WHATWG URL + Node's legacy `url` API.
//
// The parser implements the common path of the WHATWG URL Standard: special
// and non-special schemes, authority/userinfo, IPv4/IPv6 hosts, path
// dot-segment normalisation, the query/fragment encode sets, and relative
// resolution against a base. IDNA is implemented with punycode plus the UTS46
// mappings that matter in practice (case folding, NFC/NFKC normalisation,
// fullwidth ASCII and the RFC 3490 dot separators); characters outside that
// subset are rejected rather than mis-mapped.
//
// The legacy `parse`/`format`/`resolve` implementation follows Node's
// `lib/url.js` (MIT) so its quirks are preserved.

function loadModule(relative, builtin) {
  try {
    return require(relative);
  } catch {
    return require(builtin);
  }
}

const querystring = loadModule("./querystring.js", "querystring");
const punycode = loadModule("./punycode.js", "punycode");

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function invalidURL(input) {
  const err = new TypeError("Invalid URL");
  err.code = "ERR_INVALID_URL";
  err.input = input;
  return err;
}

function invalidArgType(name, expected, actual) {
  let received;
  if (actual === null) received = "null";
  else if (typeof actual === "object") received = "an instance of " + (actual.constructor && actual.constructor.name || "Object");
  else received = "type " + typeof actual + " (" + String(actual) + ")";
  const err = new TypeError(
    `The "${name}" argument must be ${expected}. Received ${received}`,
  );
  err.code = "ERR_INVALID_ARG_TYPE";
  return err;
}

function missingArgs(name) {
  const err = new TypeError(`The "${name}" argument must be specified`);
  err.code = "ERR_MISSING_ARGS";
  return err;
}

function invalidURLScheme(expected) {
  const err = new TypeError(`The URL must be of scheme ${expected}`);
  err.code = "ERR_INVALID_URL_SCHEME";
  return err;
}

function invalidFileURLHost(platform) {
  const err = new TypeError(
    `File URL host must be "localhost" or empty on ${platform}`,
  );
  err.code = "ERR_INVALID_FILE_URL_HOST";
  return err;
}

function invalidFileURLPath(message, url) {
  const err = new TypeError(`File URL path ${message}`);
  err.code = "ERR_INVALID_FILE_URL_PATH";
  if (url !== undefined) err.input = url;
  return err;
}

function invalidTuple() {
  const err = new TypeError(
    "Each query pair must be an iterable [name, value] tuple",
  );
  err.code = "ERR_INVALID_TUPLE";
  return err;
}

// ---------------------------------------------------------------------------
// Strings and percent encoding
// ---------------------------------------------------------------------------

const HEX = "0123456789ABCDEF";

function toUSVString(value) {
  const str = typeof value === "string" ? value : `${value}`;
  if (typeof str.toWellFormed === "function") return str.toWellFormed();
  let out = "";
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += str[i] + str[i + 1];
        i++;
      } else {
        out += "\uFFFD";
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      out += "\uFFFD";
    } else {
      out += str[i];
    }
  }
  return out;
}

function pct(byte) {
  return "%" + HEX[(byte >> 4) & 0xf] + HEX[byte & 0xf];
}

function utf8Pct(cp) {
  if (cp < 0x80) return pct(cp);
  if (cp < 0x800) {
    return pct(0xc0 | (cp >> 6)) + pct(0x80 | (cp & 0x3f));
  }
  if (cp < 0x10000) {
    return pct(0xe0 | (cp >> 12)) +
      pct(0x80 | ((cp >> 6) & 0x3f)) +
      pct(0x80 | (cp & 0x3f));
  }
  return pct(0xf0 | (cp >> 18)) +
    pct(0x80 | ((cp >> 12) & 0x3f)) +
    pct(0x80 | ((cp >> 6) & 0x3f)) +
    pct(0x80 | (cp & 0x3f));
}

// Encode sets (WHATWG URL Standard §1.3).
const SET_OPAQUE = 0;
const SET_PATH = 1;
const SET_USERINFO = 2;
const SET_QUERY = 3;
const SET_SPECIAL_QUERY = 4;
const SET_FRAGMENT = 5;
const SET_PATH_FILE = 6; // path set + the characters pathToFileURL escapes

function asciiInSet(c, set) {
  if (c <= 0x1f || c > 0x7e) return true;
  switch (set) {
    case SET_OPAQUE:
      return false;
    case SET_QUERY:
      return c === 0x20 || c === 0x22 || c === 0x23 ||
        c === 0x3c || c === 0x3e;
    case SET_SPECIAL_QUERY:
      return c === 0x20 || c === 0x22 || c === 0x23 ||
        c === 0x3c || c === 0x3e || c === 0x27;
    case SET_FRAGMENT:
      return c === 0x20 || c === 0x22 || c === 0x3c ||
        c === 0x3e || c === 0x60;
    case SET_PATH:
      return c === 0x20 || c === 0x22 || c === 0x23 || c === 0x3c ||
        c === 0x3e || c === 0x3f || c === 0x5e || c === 0x60 ||
        c === 0x7b || c === 0x7d;
    case SET_USERINFO:
      return c === 0x20 || c === 0x22 || c === 0x23 || c === 0x2f ||
        c === 0x3a || c === 0x3b || c === 0x3c || c === 0x3d ||
        c === 0x3e || c === 0x3f || c === 0x40 || c === 0x5b ||
        c === 0x5c || c === 0x5d || c === 0x5e || c === 0x60 ||
        c === 0x7b || c === 0x7c || c === 0x7d;
    case SET_PATH_FILE:
      return !(c >= 0x30 && c <= 0x39) &&
        !(c >= 0x41 && c <= 0x5a) &&
        !(c >= 0x61 && c <= 0x7a) &&
        "!$&'()*+,-.:;=@_/".indexOf(String.fromCharCode(c)) === -1;
    default:
      return false;
  }
}

function encodeString(str, set) {
  let out = "";
  for (let i = 0; i < str.length; i++) {
    const cp = str.codePointAt(i);
    if (cp > 0xffff) i++;
    if (cp < 0x80) {
      out += asciiInSet(cp, set) ? pct(cp) : String.fromCharCode(cp);
    } else {
      out += utf8Pct(cp);
    }
  }
  return out;
}

// application/x-www-form-urlencoded serialization.
function formEncode(str) {
  let out = "";
  for (let i = 0; i < str.length; i++) {
    const cp = str.codePointAt(i);
    if (cp > 0xffff) i++;
    if (cp === 0x20) {
      out += "+";
    } else if (cp < 0x80 &&
               ((cp >= 0x30 && cp <= 0x39) ||
                (cp >= 0x41 && cp <= 0x5a) ||
                (cp >= 0x61 && cp <= 0x7a) ||
                cp === 0x2a || cp === 0x2d || cp === 0x2e || cp === 0x5f)) {
      out += String.fromCharCode(cp);
    } else {
      out += utf8Pct(cp);
    }
  }
  return out;
}

function hasPercentHex(str) {
  const end = str.length - 2;
  for (let i = 0; i < end; i++) {
    if (str.charCodeAt(i) === 0x25 &&
        isHex(str.charCodeAt(i + 1)) &&
        isHex(str.charCodeAt(i + 2))) {
      return true;
    }
  }
  return false;
}

function isHex(c) {
  return (c >= 0x30 && c <= 0x39) ||
    (c >= 0x41 && c <= 0x46) ||
    (c >= 0x61 && c <= 0x66);
}

// Decode application/x-www-form-urlencoded text. Invalid percent sequences
// survive literally; malformed UTF-8 becomes U+FFFD (Node's behaviour).
function formDecode(str) {
  if (str.indexOf("+") !== -1) str = str.replace(/\+/g, " ");
  if (!hasPercentHex(str)) return str;
  try {
    return decodeURIComponent(str);
  } catch {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c === 0x25 && i + 2 < str.length &&
          isHex(str.charCodeAt(i + 1)) && isHex(str.charCodeAt(i + 2))) {
        bytes.push(parseInt(str.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        bytes.push(c & 0xff);
      }
    }
    return utf8DecodeBytes(bytes);
  }
}

function utf8DecodeBytes(bytes) {
  let out = "";
  let i = 0;
  const len = bytes.length;
  while (i < len) {
    const b0 = bytes[i];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i++;
      continue;
    }
    let need = 0;
    if (b0 >= 0xc2 && b0 <= 0xdf) need = 2;
    else if (b0 >= 0xe0 && b0 <= 0xef) need = 3;
    else if (b0 >= 0xf0 && b0 <= 0xf4) need = 4;

    if (need === 0) {
      out += "\uFFFD";
      i++;
      continue;
    }

    let seen = 1;
    while (seen < need && i + seen < len &&
           (bytes[i + seen] & 0xc0) === 0x80) {
      seen++;
    }
    if (seen < need) {
      // Truncated / interrupted sequence: one replacement for the bytes
      // consumed so far, then continue after them.
      out += "\uFFFD";
      i += seen;
      continue;
    }

    let cp;
    if (need === 2) {
      cp = ((b0 & 0x1f) << 6) | (bytes[i + 1] & 0x3f);
    } else if (need === 3) {
      cp = ((b0 & 0x0f) << 12) |
        ((bytes[i + 1] & 0x3f) << 6) |
        (bytes[i + 2] & 0x3f);
    } else {
      cp = ((b0 & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f);
    }
    if ((need === 2 && cp < 0x80) ||
        (need === 3 && cp < 0x800) ||
        (need === 4 && cp < 0x10000) ||
        (cp >= 0xd800 && cp <= 0xdfff) ||
        cp > 0x10ffff) {
      // Structurally complete but not a valid scalar value; like Node's
      // UTF-8 decoder, emit one replacement per byte.
      out += "\uFFFD";
      i++;
      continue;
    }
    out += String.fromCodePoint(cp);
    i += need;
  }
  return out;
}
// ---------------------------------------------------------------------------
// IDNA (punycode + the practical UTS46 mappings)
// ---------------------------------------------------------------------------

function mapIDNA(input) {
  let s = input;
  // Characters UTS46 maps to nothing.
  s = s.replace(/[\u00AD\u034F\u180B-\u180D\u200B\u2060\uFE00-\uFE0F\uFEFF]/g, "");
  // NFKC folds fullwidth ASCII and other compatibility characters.
  if (typeof s.normalize === "function") {
    try {
      s = s.normalize("NFKC");
    } catch {
      // ignore — fall through with the raw string
    }
  }
  s = s.toLowerCase();
  return s.replace(/[\u3002\uFF0E\uFF61]/g, ".");
}

const FORBIDDEN_HOST = "#/:<>?@[\\]^|%";
const FORBIDDEN_HOST_OPAQUE = "#/:<>?@[\\]^|";

function isForbiddenHostCodePoint(cp, opaque) {
  if (cp <= 0x20 || cp === 0x7f) return true;
  const ch = String.fromCharCode(cp);
  return (opaque ? FORBIDDEN_HOST_OPAQUE : FORBIDDEN_HOST).indexOf(ch) !== -1;
}

function idnaToASCII(domain) {
  const mapped = mapIDNA(domain);
  const labels = mapped.split(".");
  const out = [];
  for (const label of labels) {
    for (let i = 0; i < label.length; i++) {
      const cp = label.codePointAt(i);
      if (isForbiddenHostCodePoint(cp, false) ||
          cp === 0x200c || cp === 0x200d) {
        throw new Error("invalid host");
      }
    }
    if (/[^\0-\x7F]/.test(label)) {
      out.push("xn--" + punycode.encode(label));
    } else {
      out.push(label);
    }
  }
  return out.join(".");
}

function domainToASCIISafe(domain) {
  let decoded;
  try {
    decoded = decodeURIComponent(domain);
  } catch {
    return "";
  }
  const mapped = mapIDNA(decoded);
  if (mapped === "") return "";
  try {
    return idnaToASCII(decoded);
  } catch {
    return "";
  }
}

// NOTE (known gap, docs/compat.md): this implements punycode plus the
// practical UTS46 mappings (NFKC, case folding, ignored characters, RFC 3490
// separators). The full UTS46 status table is not implemented, so code points
// UTS46 marks disallowed/unassigned may be punycoded instead of rejected.
function prepareDomainInput(value) {
  let result = value.replace(/[\t\n\r]/g, "");
  const cut = result.search(/[/?#\\]/);
  if (cut !== -1) result = result.slice(0, cut);
  return decodeURIComponent(result);
}

function domainToUnicode(domain) {
  if (arguments.length < 1) throw missingArgs("domain");
  const domainString = `${domain}`;
  let input;
  try {
    input = prepareDomainInput(domainString);
  } catch {
    return "";
  }
  if (input === "") return "";
  if (input[0] === "[") {
    try {
      return "[" + serializeIPv6(parseIPv6(input.slice(1, -1))) + "]";
    } catch {
      return "";
    }
  }
  if (endsInNumber(input)) {
    try {
      return parseIPv4(input);
    } catch {
      return "";
    }
  }
  const mapped = mapIDNA(input);
  for (let i = 0; i < mapped.length; i++) {
    const cp = mapped.codePointAt(i);
    if (isForbiddenHostCodePoint(cp, false) ||
        cp === 0x200c || cp === 0x200d) return "";
  }
  const labels = mapped.split(".");
  const out = [];
  for (const label of labels) {
    if (/^xn--/i.test(label)) {
      try {
        const decoded = punycode.decode(label.slice(4).toLowerCase());
        out.push(decoded === "" ? label : decoded);
      } catch {
        out.push(label);
      }
    } else {
      out.push(label);
    }
  }
  return out.join(".");
}

function domainToASCII(domain) {
  if (arguments.length < 1) throw missingArgs("domain");
  const domainString = `${domain}`;
  let input;
  try {
    input = prepareDomainInput(domainString);
  } catch {
    return "";
  }
  if (input === "") return "";
  if (input[0] === "[") {
    try {
      return "[" + serializeIPv6(parseIPv6(input.slice(1, -1))) + "]";
    } catch {
      return "";
    }
  }
  if (endsInNumber(input)) {
    try {
      return parseIPv4(input);
    } catch {
      return "";
    }
  }
  try {
    return idnaToASCII(input);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// IPv4 / IPv6
// ---------------------------------------------------------------------------

function endsInNumber(domain) {
  const parts = domain.split(".");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return /^(?:[0-9]+|0[xX][0-9a-fA-F]*)$/.test(parts[parts.length - 1]);
}

function parseIPv4(domain) {
  const parts = domain.split(".");
  if (parts[parts.length - 1] === "") parts.pop();
  if (parts.length === 0 || parts.length > 4) throw new Error("invalid ipv4");

  const numbers = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === "") throw new Error("invalid ipv4");
    let radix = 10;
    let digits = part;
    let value;
    if (/^0[xX]/.test(part)) {
      radix = 16;
      digits = part.slice(2);
      if (digits === "") value = 0;
      else if (!/^[0-9a-fA-F]+$/.test(digits)) throw new Error("invalid ipv4");
    } else if (part.length >= 2 && part[0] === "0") {
      radix = 8;
      digits = part.slice(1);
      if (!/^[0-7]+$/.test(digits)) throw new Error("invalid ipv4");
    } else if (!/^[0-9]+$/.test(part)) {
      throw new Error("invalid ipv4");
    }
    if (value === undefined) value = parseInt(digits, radix);
    if (i < parts.length - 1) {
      if (value > 255) throw new Error("invalid ipv4");
    } else {
      const bound = 256 ** (5 - parts.length);
      if (value >= bound) throw new Error("invalid ipv4");
    }
    numbers.push(value);
  }

  let ipv4 = numbers[numbers.length - 1];
  for (let i = numbers.length - 2; i >= 0; i--) {
    ipv4 += numbers[i] * 256 ** (3 - i);
  }
  return [
    Math.floor(ipv4 / 0x1000000) & 0xff,
    Math.floor(ipv4 / 0x10000) & 0xff,
    Math.floor(ipv4 / 0x100) & 0xff,
    ipv4 & 0xff,
  ].join(".");
}

function parseEmbeddedIPv4(group) {
  const parts = group.split(".");
  if (parts.length !== 4) throw new Error("invalid ipv4");
  const values = [];
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) throw new Error("invalid ipv4");
    const value = parseInt(part, 10);
    if (value > 255) throw new Error("invalid ipv4");
    values.push(value);
  }
  return [(values[0] << 8) | values[1], (values[2] << 8) | values[3]];
}

function parseIPv6(input) {
  if (input === "") throw new Error("invalid ipv6");
  let left;
  let right = null;
  const doubleColon = input.indexOf("::");
  let compressed = false;
  if (doubleColon !== -1) {
    compressed = true;
    left = input.slice(0, doubleColon);
    right = input.slice(doubleColon + 2);
    if (right.indexOf("::") !== -1) throw new Error("invalid ipv6");
  } else {
    left = input;
  }

  function parseGroups(str, allowIPv4AtEnd) {
    if (str === "") return [];
    const groups = str.split(":");
    const out = [];
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (group === "") throw new Error("invalid ipv6");
      if (allowIPv4AtEnd && i === groups.length - 1 && group.indexOf(".") !== -1) {
        const pair = parseEmbeddedIPv4(group);
        out.push(pair[0], pair[1]);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(group)) throw new Error("invalid ipv6");
        out.push(parseInt(group, 16));
      }
    }
    return out;
  }

  const leftGroups = parseGroups(left, !compressed);
  const rightGroups = compressed ? parseGroups(right, true) : [];

  if (compressed) {
    if (leftGroups.length + rightGroups.length >= 8) throw new Error("invalid ipv6");
    const zeros = 8 - leftGroups.length - rightGroups.length;
    const out = leftGroups.slice();
    for (let i = 0; i < zeros; i++) out.push(0);
    return out.concat(rightGroups);
  }
  if (leftGroups.length !== 8) throw new Error("invalid ipv6");
  return leftGroups;
}

function serializeIPv6(address) {
  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  for (let i = 0; i < 8; i++) {
    if (address[i] === 0) {
      if (runStart === -1) runStart = i;
    } else if (runStart !== -1) {
      const length = i - runStart;
      if (length > bestLength) {
        bestLength = length;
        bestStart = runStart;
      }
      runStart = -1;
    }
  }
  if (runStart !== -1) {
    const length = 8 - runStart;
    if (length > bestLength) {
      bestLength = length;
      bestStart = runStart;
    }
  }

  if (bestLength > 1) {
    const left = address.slice(0, bestStart)
      .map((piece) => piece.toString(16)).join(":");
    const right = address.slice(bestStart + bestLength)
      .map((piece) => piece.toString(16)).join(":");
    return left + "::" + right;
  }
  return address.map((piece) => piece.toString(16)).join(":");
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

const SPECIAL_SCHEMES = new Map([
  ["ftp", 21],
  ["file", null],
  ["http", 80],
  ["https", 443],
  ["ws", 80],
  ["wss", 443],
]);

function isSpecial(scheme) {
  return SPECIAL_SCHEMES.has(scheme);
}

function defaultPort(scheme) {
  return SPECIAL_SCHEMES.get(scheme);
}

function preprocess(input) {
  let s = toUSVString(input);
  s = s.replace(/^[\u0000-\u0020]+/, "").replace(/[\u0000-\u0020]+$/, "");
  return s.replace(/[\t\n\r]/g, "");
}

function stripTabsNewlines(value) {
  return toUSVString(value).replace(/[\t\n\r]/g, "");
}

function splitSetterHost(value, special) {
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "/" || c === "?" || c === "#" || (special && c === "\\")) {
      return value.slice(0, i);
    }
  }
  return value;
}

function baseDriveLetter(path) {
  const match = /^\/([A-Za-z]:)(?=\/|$)/.exec(path);
  return match === null ? null : match[1];
}

function replaceBackslashes(value) {
  const split = value.search(/[?#]/);
  if (split === -1) return value.replace(/\\/g, "/");
  return value.slice(0, split).replace(/\\/g, "/") + value.slice(split);
}

function makeState(scheme, username, password, hostname, port, pathname,
                   query, fragment, opaque) {
  return {
    scheme,
    username,
    password,
    hostname,
    port,
    path: pathname,
    query,
    fragment,
    opaque: !!opaque,
  };
}

function serializeState(st) {
  let out = st.scheme + ":";
  if (st.hostname !== null) {
    out += "//";
    if (st.username !== "" || st.password !== "") {
      out += st.username;
      if (st.password !== "") out += ":" + st.password;
      out += "@";
    }
    out += st.hostname;
    if (st.port !== "") out += ":" + st.port;
  }
  let path = st.path;
  if (st.hostname === null && path.slice(0, 2) === "//") path = "/." + path;
  out += path;
  if (st.query !== null) out += "?" + st.query;
  if (st.fragment !== null) out += "#" + st.fragment;
  return out;
}

function parsePort(raw, scheme) {
  if (raw === "") return "";
  if (!/^[0-9]+$/.test(raw)) throw new Error("invalid port");
  const value = parseInt(raw, 10);
  if (value > 65535) throw new Error("invalid port");
  if (value === defaultPort(scheme)) return "";
  return String(value);
}

function parseHostName(raw, scheme) {
  const special = isSpecial(scheme);
  if (raw === "") {
    if (special && scheme !== "file") throw new Error("empty host");
    return "";
  }
  if (special) {
    if (raw[0] === "[") {
      if (raw[raw.length - 1] !== "]") throw new Error("invalid ipv6 host");
      return "[" + serializeIPv6(parseIPv6(raw.slice(1, -1))) + "]";
    }
    let decoded;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      throw new Error("invalid host percent encoding");
    }
    if (endsInNumber(decoded)) return parseIPv4(decoded);
    const ascii = idnaToASCII(decoded);
    if (ascii === "") throw new Error("empty host");
    return ascii;
  }
  // Opaque host.
  for (let i = 0; i < raw.length; i++) {
    if (isForbiddenHostCodePoint(raw.codePointAt(i), true)) {
      throw new Error("invalid opaque host");
    }
  }
  return encodeString(raw, SET_OPAQUE);
}

function parseHostAndPort(hostport, scheme) {
  if (hostport[0] === "[") {
    const close = hostport.indexOf("]");
    if (close === -1) throw new Error("invalid ipv6 host");
    const after = hostport.slice(close + 1);
    if (after !== "" && after[0] !== ":") throw new Error("invalid host");
    const hostname = "[" + serializeIPv6(parseIPv6(hostport.slice(1, close))) + "]";
    if (scheme === "file" && after !== "") throw new Error("file port");
    const port = after === "" ? "" : parsePort(after.slice(1), scheme);
    return { hostname, port, hasPort: after !== "" };
  }

  const colon = hostport.lastIndexOf(":");
  let hostRaw = hostport;
  let portRaw = null;
  if (colon !== -1) {
    hostRaw = hostport.slice(0, colon);
    portRaw = hostport.slice(colon + 1);
  }
  if (scheme === "file" && portRaw !== null) throw new Error("file port");
  const hostname = parseHostName(hostRaw, scheme);
  const port = portRaw === null ? "" : parsePort(portRaw, scheme);
  return { hostname, port, hasPort: portRaw !== null };
}

function parseFileHost(authority) {
  if (authority === "") return "";
  if (authority[0] === "[") {
    if (authority[authority.length - 1] !== "]") throw new Error("invalid ipv6 host");
    return "[" + serializeIPv6(parseIPv6(authority.slice(1, -1))) + "]";
  }
  if (authority.indexOf(":") !== -1) throw new Error("file host port");
  let decoded;
  try {
    decoded = decodeURIComponent(authority);
  } catch {
    throw new Error("invalid file host");
  }
  if (endsInNumber(decoded)) return parseIPv4(decoded);
  const ascii = idnaToASCII(decoded);
  if (ascii === "localhost" || ascii === "") return "";
  return ascii;
}

function parseAuthorityUserInfo(authority, scheme) {
  let username = "";
  let password = "";
  let hostport = authority;
  const at = authority.lastIndexOf("@");
  let hasUserInfo = false;
  if (at !== -1) {
    hasUserInfo = true;
    const userinfo = authority.slice(0, at);
    hostport = authority.slice(at + 1);
    const colon = userinfo.indexOf(":");
    const rawUser = colon === -1 ? userinfo : userinfo.slice(0, colon);
    const rawPass = colon === -1 ? "" : userinfo.slice(colon + 1);
    if (scheme === "file") throw new Error("file userinfo");
    username = encodeString(rawUser, SET_USERINFO);
    password = encodeString(rawPass, SET_USERINFO);
  }
  return { username, password, hostport, hasUserInfo };
}

function isDotSegment(segment) {
  return segment === "." || segment.toLowerCase() === "%2e";
}

function isDoubleDotSegment(segment) {
  const lower = segment.toLowerCase();
  return lower === ".." || lower === ".%2e" ||
    lower === "%2e." || lower === "%2e%2e";
}

function normalizeDriveLetter(segment) {
  if (/^[A-Za-z][:|]$/.test(segment)) {
    return segment[0] + ":";
  }
  return segment;
}

function isDriveLetter(segment) {
  return /^[A-Za-z]:$/.test(segment);
}

function computePath(raw, special, file) {
  if (raw === "") return special ? "/" : "";
  let value = raw;
  if (value[0] !== "/") value = "/" + value;
  const parts = value.split("/");
  const out = [""];
  for (let i = 1; i < parts.length; i++) {
    let segment = parts[i];
    const isLast = i === parts.length - 1;
    if (file && i === 1) segment = normalizeDriveLetter(segment);
    if (isDoubleDotSegment(segment)) {
      if (out.length > 1) {
        if (!(file && out.length === 2 && isDriveLetter(out[1]))) out.pop();
      }
      if (isLast) out.push("");
    } else if (isDotSegment(segment)) {
      if (isLast) out.push("");
    } else {
      out.push(encodeString(segment, SET_PATH));
    }
  }
  let path = out.join("/");
  if (special && path === "") path = "/";
  return path;
}

function consumePathQueryFragment(rest, scheme, file) {
  let value = rest;
  let fragment = null;
  const hashIndex = value.indexOf("#");
  if (hashIndex !== -1) {
    fragment = encodeString(value.slice(hashIndex + 1), SET_FRAGMENT);
    value = value.slice(0, hashIndex);
  }
  let query = null;
  const queryIndex = value.indexOf("?");
  if (queryIndex !== -1) {
    query = encodeString(
      value.slice(queryIndex + 1),
      isSpecial(scheme) ? SET_SPECIAL_QUERY : SET_QUERY,
    );
    value = value.slice(0, queryIndex);
  }
  return {
    pathname: computePath(value, isSpecial(scheme), !!file),
    query,
    fragment,
  };
}

function parseAuthorityPath(scheme, rest) {
  if (isSpecial(scheme)) rest = replaceBackslashes(rest);
  let end = rest.search(/[/?#]/);
  if (end === -1) end = rest.length;
  const authority = rest.slice(0, end);
  const after = rest.slice(end);
  const { username, password, hostport, hasUserInfo } =
    parseAuthorityUserInfo(authority, scheme);
  const { hostname, port, hasPort } = parseHostAndPort(hostport, scheme);
  if (hostname === "" && (hasUserInfo || hasPort)) {
    throw new Error("empty host with credentials or port");
  }
  const { pathname, query, fragment } = consumePathQueryFragment(after, scheme, false);
  return makeState(scheme, username, password, hostname, port, pathname, query,
    fragment, false);
}

function parseSpecialAbsolute(scheme, rest) {
  // "special authority ignore slashes": any run of slashes/backslashes.
  rest = rest.replace(/^[/\\]+/, "");
  return parseAuthorityPath(scheme, rest);
}

function parseOpaquePathAndTail(rest, scheme) {
  const value = rest;
  const queryIndex = value.indexOf("?");
  const hashIndex = value.indexOf("#");
  let pathEnd = value.length;
  if (queryIndex !== -1 && (hashIndex === -1 || queryIndex < hashIndex)) {
    pathEnd = queryIndex;
  } else if (hashIndex !== -1) {
    pathEnd = hashIndex;
  }

  let rawPath = value.slice(0, pathEnd);
  if (pathEnd < value.length) {
    // A single trailing space before ? or # is percent-encoded.
    if (rawPath[rawPath.length - 1] === " ") {
      rawPath = rawPath.slice(0, -1) + "%20";
    }
  } else {
    // Trailing spaces at EOF disappear.
    rawPath = rawPath.replace(/ +$/, "");
  }

  let query = null;
  let fragment = null;
  if (queryIndex !== -1 && (hashIndex === -1 || queryIndex < hashIndex)) {
    const queryEnd = hashIndex === -1 ? value.length : hashIndex;
    query = encodeString(value.slice(queryIndex + 1, queryEnd), SET_QUERY);
    if (hashIndex !== -1) {
      fragment = encodeString(value.slice(hashIndex + 1), SET_FRAGMENT);
    }
  } else if (hashIndex !== -1) {
    fragment = encodeString(value.slice(hashIndex + 1), SET_FRAGMENT);
  }

  return {
    pathname: encodeString(rawPath, SET_OPAQUE),
    query,
    fragment,
  };
}

function parseNonSpecialAbsolute(scheme, rest) {
  if (rest.slice(0, 2) === "//") {
    return parseAuthorityPath(scheme, rest.slice(2));
  }
  if (rest[0] === "/") {
    const { pathname, query, fragment } = consumePathQueryFragment(rest, scheme, false);
    return makeState(scheme, "", "", null, "", pathname, query, fragment, false);
  }
  const { pathname, query, fragment } = parseOpaquePathAndTail(rest, scheme);
  return makeState(scheme, "", "", null, "", pathname, query, fragment, true);
}

function parseFileAbsolute(rest, base) {
  const baseFile = base && base.scheme === "file";
  rest = replaceBackslashes(rest);
  if (rest.slice(0, 2) === "//") {
    let afterSlashes = rest.slice(2);
    let end = afterSlashes.search(/[/?#]/);
    if (end === -1) end = afterSlashes.length;
    const authority = afterSlashes.slice(0, end);
    const after = afterSlashes.slice(end);
    const hostname = parseFileHost(authority);
    const { pathname, query, fragment } = consumePathQueryFragment(after, "file", true);
    return makeState("file", "", "", hostname, "", pathname, query, fragment, false);
  }

  if (rest[0] === "/") {
    const hostname = baseFile ? base.hostname : "";
    let value = replaceBackslashes(rest);
    if (baseFile) {
      const drive = /^\/([A-Za-z]:)(?=\/|$)/.exec(base.path);
      if (drive && !/^[A-Za-z][:|]/.test(value.slice(1))) {
        value = "/" + drive[1] + value;
      }
    }
    const { pathname, query, fragment } = consumePathQueryFragment(value, "file", true);
    return makeState("file", "", "", hostname, "", pathname, query, fragment, false);
  }

  if (baseFile) {
    return parseRelative(rest, base, true, true);
  }

  const value = replaceBackslashes(rest);
  const { pathname, query, fragment } = consumePathQueryFragment("/" + value, "file", true);
  return makeState("file", "", "", "", "", pathname, query, fragment, false);
}

function shortenPath(path) {
  if (path === "" || path === "/") return "/";
  const index = path.lastIndexOf("/");
  return index === -1 ? "/" : path.slice(0, index + 1);
}

function parseRelative(input, base, special, file) {
  if (special) input = replaceBackslashes(input);

  if (base.opaque) {
    if (input.length > 0 && input[0] === "#") {
      return makeState(base.scheme, base.username, base.password, base.hostname,
        base.port, base.path, base.query,
        encodeString(input.slice(1), SET_FRAGMENT), true);
    }
    throw new Error("cannot resolve relative against opaque path");
  }

  if (input.slice(0, 2) === "//") {
    let rest = input.slice(2);
    if (special && base.scheme !== "file") {
      rest = rest.replace(/^[/\\]+/, "");
    }
    return parseAuthorityPath(base.scheme, rest);
  }

  if (input[0] === "/") {
    let value = input;
    if (file) {
      const drive = baseDriveLetter(base.path);
      if (drive && !/^[A-Za-z][:|]/.test(value.slice(1))) {
        value = "/" + drive + value;
      }
    }
    const { pathname, query, fragment } = consumePathQueryFragment(value, base.scheme, file);
    return makeState(base.scheme, base.username, base.password, base.hostname,
      base.port, pathname, query, fragment, false);
  }

  if (input[0] === "?") {
    const { query, fragment } = consumePathQueryFragment(input, base.scheme, file);
    return makeState(base.scheme, base.username, base.password, base.hostname,
      base.port, base.path, query, fragment, false);
  }

  if (input[0] === "#") {
    return makeState(base.scheme, base.username, base.password, base.hostname,
      base.port, base.path, base.query,
      encodeString(input.slice(1), SET_FRAGMENT), false);
  }

  if (input === "") {
    return makeState(base.scheme, base.username, base.password, base.hostname,
      base.port, base.path, base.query, null, false);
  }

  const merged = shortenPath(base.path) + input;
  const { pathname, query, fragment } = consumePathQueryFragment(merged, base.scheme, file);
  return makeState(base.scheme, base.username, base.password, base.hostname,
    base.port, pathname, query, fragment, false);
}

function parseString(input, base) {
  const s = preprocess(input);
  const match = /^([A-Za-z][A-Za-z0-9+.\-]*):/.exec(s);
  if (match) {
    const scheme = match[1].toLowerCase();
    const rest = s.slice(match[0].length);
    if (scheme === "file") return parseFileAbsolute(rest, base);
    if (isSpecial(scheme)) {
      if (base && base.scheme === scheme) {
        return parseRelative(rest, base, true, false);
      }
      return parseSpecialAbsolute(scheme, rest);
    }
    return parseNonSpecialAbsolute(scheme, rest);
  }
  if (!base) throw new Error("missing base");
  return parseRelative(s, base, isSpecial(base.scheme), base.scheme === "file");
}

// ---------------------------------------------------------------------------
// URLSearchParams
// ---------------------------------------------------------------------------

const paramsState = new WeakMap();
const urlState = new WeakMap();
const urlParams = new WeakMap();

function parseQueryString(query) {
  const list = [];
  if (query === null) return list;
  let s = query;
  if (s[0] === "?") s = s.slice(1);
  if (s === "") return list;
  const parts = s.split("&");
  for (const part of parts) {
    if (part === "") continue;
    const eq = part.indexOf("=");
    if (eq === -1) {
      list.push([formDecode(part), ""]);
    } else {
      list.push([formDecode(part.slice(0, eq)), formDecode(part.slice(eq + 1))]);
    }
  }
  return list;
}

function serializeQuery(list) {
  const parts = [];
  for (const [name, value] of list) {
    parts.push(formEncode(name) + "=" + formEncode(value));
  }
  return parts.join("&");
}

function getParamsState(params) {
  const state = paramsState.get(params);
  if (state === undefined) {
    const err = new TypeError(
      'Value of "this" must be of type URLSearchParams',
    );
    err.code = "ERR_INVALID_THIS";
    throw err;
  }
  return state;
}

function updateURLFromParams(params) {
  const state = getParamsState(params);
  if (state.url === null) return;
  const url = state.url;
  const urlStateValue = urlState.get(url);
  const serialized = serializeQuery(state.list);
  urlStateValue.query = serialized === "" ? null : serialized;
}

function resetParamsList(params, query) {
  paramsState.get(params).list = parseQueryString(query);
}

class URLSearchParamsIterator {
  constructor(params, kind) {
    this._params = params;
    this._kind = kind;
    this._index = 0;
  }

  next() {
    const state = getParamsState(this._params);
    if (this._index >= state.list.length) {
      return { value: undefined, done: true };
    }
    const pair = state.list[this._index++];
    if (this._kind === "keys") return { value: pair[0], done: false };
    if (this._kind === "values") return { value: pair[1], done: false };
    return { value: [pair[0], pair[1]], done: false };
  }

  [Symbol.iterator]() {
    return this;
  }
}

Object.defineProperty(URLSearchParamsIterator.prototype, Symbol.toStringTag, {
  value: "URLSearchParams Iterator",
  configurable: true,
});

class URLSearchParams {
  constructor(init) {
    let list = [];
    if (init !== undefined) {
      if (init === null) {
        list = parseQueryString("null");
      } else if (typeof init !== "object") {
        list = parseQueryString(toUSVString(init));
      } else if (typeof init[Symbol.iterator] === "function") {
        for (const pair of init) {
          if (pair === null || typeof pair !== "object" ||
              typeof pair[Symbol.iterator] !== "function") {
            throw invalidTuple();
          }
          const values = Array.from(pair);
          if (values.length !== 2) throw invalidTuple();
          list.push([toUSVString(values[0]), toUSVString(values[1])]);
        }
      } else {
        const keys = Object.keys(init);
        for (const sym of Object.getOwnPropertySymbols(init)) {
          const descriptor = Object.getOwnPropertyDescriptor(init, sym);
          if (descriptor && descriptor.enumerable) keys.push(sym);
        }
        for (const key of keys) {
          list.push([toUSVString(key), toUSVString(init[key])]);
        }
      }
    }
    paramsState.set(this, { list, url: null });
  }

  get size() {
    return getParamsState(this).list.length;
  }

  append(name, value) {
    const state = getParamsState(this);
    state.list.push([toUSVString(name), toUSVString(value)]);
    updateURLFromParams(this);
  }

  delete(name, value) {
    const state = getParamsState(this);
    const key = toUSVString(name);
    if (value === undefined) {
      state.list = state.list.filter((pair) => pair[0] !== key);
    } else {
      const stringValue = toUSVString(value);
      state.list = state.list.filter(
        (pair) => !(pair[0] === key && pair[1] === stringValue),
      );
    }
    updateURLFromParams(this);
  }

  get(name) {
    const key = toUSVString(name);
    for (const pair of getParamsState(this).list) {
      if (pair[0] === key) return pair[1];
    }
    return null;
  }

  getAll(name) {
    const key = toUSVString(name);
    const out = [];
    for (const pair of getParamsState(this).list) {
      if (pair[0] === key) out.push(pair[1]);
    }
    return out;
  }

  has(name, value) {
    const key = toUSVString(name);
    if (value === undefined) {
      return getParamsState(this).list.some((pair) => pair[0] === key);
    }
    const stringValue = toUSVString(value);
    return getParamsState(this).list.some(
      (pair) => pair[0] === key && pair[1] === stringValue,
    );
  }

  set(name, value) {
    const state = getParamsState(this);
    const key = toUSVString(name);
    const stringValue = toUSVString(value);
    let found = -1;
    for (let i = 0; i < state.list.length; i++) {
      if (state.list[i][0] === key) {
        found = i;
        state.list[i][1] = stringValue;
        break;
      }
    }
    if (found === -1) state.list.push([key, stringValue]);
    else {
      for (let i = state.list.length - 1; i > found; i--) {
        if (state.list[i][0] === key) state.list.splice(i, 1);
      }
    }
    updateURLFromParams(this);
  }

  sort() {
    const state = getParamsState(this);
    const decorated = state.list.map((pair, index) => ({ pair, index }));
    decorated.sort((a, b) => {
      if (a.pair[0] < b.pair[0]) return -1;
      if (a.pair[0] > b.pair[0]) return 1;
      return a.index - b.index;
    });
    state.list = decorated.map((entry) => entry.pair);
    updateURLFromParams(this);
  }

  forEach(callback, thisArg) {
    if (typeof callback !== "function") {
      throw invalidArgType("callback", "of type function", callback);
    }
    const state = getParamsState(this);
    for (let i = 0; i < state.list.length; i++) {
      const pair = state.list[i];
      callback.call(thisArg, pair[1], pair[0], this);
    }
  }

  keys() {
    return new URLSearchParamsIterator(this, "keys");
  }

  values() {
    return new URLSearchParamsIterator(this, "values");
  }

  entries() {
    return new URLSearchParamsIterator(this, "entries");
  }

  toString() {
    return serializeQuery(getParamsState(this).list);
  }

  [Symbol.iterator]() {
    return this.entries();
  }
}

Object.defineProperty(URLSearchParams.prototype, Symbol.toStringTag, {
  value: "URLSearchParams",
  configurable: true,
});

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

const SEARCH_PARAMS_GETTER = function searchParams() {
  let params = urlParams.get(this);
  if (params === undefined) {
    const state = urlState.get(this);
    params = Object.create(URLSearchParams.prototype);
    paramsState.set(params, {
      list: parseQueryString(state.query),
      url: this,
    });
    urlParams.set(this, params);
  }
  return params;
};

function replaceURLState(url, state) {
  urlState.set(url, state);
  const params = urlParams.get(url);
  if (params !== undefined) resetParamsList(params, state.query);
}

function getURLState(url) {
  const state = urlState.get(url);
  if (state === undefined) {
    throw new TypeError("Receiver must be an instance of class URL");
  }
  return state;
}

function cloneState(state) {
  return makeState(state.scheme, state.username, state.password, state.hostname,
    state.port, state.path, state.query, state.fragment, state.opaque);
}

function getHostForOrigin(state) {
  return state.hostname === null ? "" : state.hostname;
}

class URL {
  constructor(input, base) {
    let baseState = null;
    if (base !== undefined) {
      if (base instanceof URL) {
        baseState = getURLState(base);
      } else {
        try {
          baseState = parseString(toUSVString(base), null);
        } catch {
          throw invalidURL(toUSVString(input));
        }
      }
    }
    let state;
    try {
      state = parseString(toUSVString(input), baseState);
    } catch {
      throw invalidURL(toUSVString(input));
    }
    urlState.set(this, state);
  }

  get href() {
    return serializeState(getURLState(this));
  }

  set href(value) {
    const input = toUSVString(value);
    let state;
    try {
      state = parseString(input, null);
    } catch {
      throw invalidURL(input);
    }
    replaceURLState(this, state);
  }

  get origin() {
    return getOrigin(getURLState(this));
  }

  get protocol() {
    return getURLState(this).scheme + ":";
  }

  set protocol(value) {
    const state = getURLState(this);
    let scheme = stripTabsNewlines(value);
    if (scheme === "") return;
    const colon = scheme.indexOf(":");
    if (colon !== -1) scheme = scheme.slice(0, colon);
    if (!/^[A-Za-z][A-Za-z0-9+.\-]*$/.test(scheme)) return;
    scheme = scheme.toLowerCase();
    if (scheme === state.scheme) return;
    if (isSpecial(scheme) !== isSpecial(state.scheme)) return;
    if (scheme === "file" &&
        (state.username !== "" || state.password !== "" || state.port !== "")) {
      return;
    }
    if (state.scheme === "file" && state.hostname === "") return;
    state.scheme = scheme;
  }

  get username() {
    return getURLState(this).username;
  }

  set username(value) {
    const state = getURLState(this);
    if (state.hostname === null || state.hostname === "" ||
        state.scheme === "file") return;
    state.username = encodeString(toUSVString(value), SET_USERINFO);
  }

  get password() {
    return getURLState(this).password;
  }

  set password(value) {
    const state = getURLState(this);
    if (state.hostname === null || state.hostname === "" ||
        state.scheme === "file") return;
    state.password = encodeString(toUSVString(value), SET_USERINFO);
  }

  get host() {
    const state = getURLState(this);
    if (state.hostname === null) return "";
    return state.hostname + (state.port === "" ? "" : ":" + state.port);
  }

  set host(value) {
    const state = getURLState(this);
    if (state.opaque) return;
    const special = isSpecial(state.scheme);
    const raw = splitSetterHost(stripTabsNewlines(value), special);
    try {
      if (state.scheme === "file") {
        if (raw === "") {
          state.hostname = "";
          state.port = "";
          return;
        }
        state.hostname = parseFileHost(raw);
        state.port = "";
        return;
      }

      let hostPart = raw;
      let portPart = null;
      if (raw[0] === "[") {
        const close = raw.indexOf("]");
        if (close === -1) return;
        hostPart = raw.slice(0, close + 1);
        const after = raw.slice(close + 1);
        if (after !== "") {
          if (after[0] !== ":") return;
          portPart = after.slice(1);
        }
      } else {
        const colon = raw.lastIndexOf(":");
        if (colon !== -1) {
          hostPart = raw.slice(0, colon);
          portPart = raw.slice(colon + 1);
        }
      }

      let hostname;
      if (hostPart[0] === "[") {
        if (hostPart[hostPart.length - 1] !== "]") return;
        hostname = "[" + serializeIPv6(parseIPv6(hostPart.slice(1, -1))) + "]";
      } else {
        hostname = parseHostName(hostPart, state.scheme);
      }
      const hasCredentials = state.username !== "" || state.password !== "";
      if (hostname === "" &&
          (special || portPart !== null || state.port !== "" || hasCredentials)) {
        return;
      }
      state.hostname = hostname;
      if (portPart !== null && /^[0-9]/.test(portPart)) {
        const match = /^[0-9]+/.exec(portPart);
        const parsed = parseInt(match[0], 10);
        if (parsed <= 65535) {
          state.port = parsed === defaultPort(state.scheme) ? "" : String(parsed);
        }
      }
    } catch {
      // Invalid hosts are ignored by the setter.
    }
  }

  get hostname() {
    const state = getURLState(this);
    return state.hostname === null ? "" : state.hostname;
  }

  set hostname(value) {
    const state = getURLState(this);
    if (state.opaque) return;
    const special = isSpecial(state.scheme);
    let raw = splitSetterHost(stripTabsNewlines(value), special);
    try {
      if (state.scheme === "file") {
        if (raw[0] === "[") {
          const close = raw.indexOf("]");
          if (close !== raw.length - 1) return;
          state.hostname = parseFileHost(raw);
        } else {
          if (raw.indexOf(":") !== -1) return;
          state.hostname = raw === "" ? "" : parseFileHost(raw);
        }
        return;
      }
      if (raw[0] === "[") {
        const close = raw.indexOf("]");
        if (close === -1 || close !== raw.length - 1) return;
        state.hostname = "[" + serializeIPv6(parseIPv6(raw.slice(1, -1))) + "]";
        return;
      }
      if (raw.indexOf(":") !== -1) return;
      const hostname = parseHostName(raw, state.scheme);
      const hasCredentials = state.username !== "" || state.password !== "";
      if (hostname === "" &&
          (special || state.port !== "" || hasCredentials)) {
        return;
      }
      state.hostname = hostname;
    } catch {
      // Ignore invalid hostnames.
    }
  }

  get port() {
    return getURLState(this).port;
  }

  set port(value) {
    const state = getURLState(this);
    if (state.hostname === null || state.hostname === "" ||
        state.scheme === "file") return;
    const original = toUSVString(value);
    if (original === "") {
      state.port = "";
      return;
    }
    const raw = original.replace(/[\t\n\r]/g, "");
    const match = /^[0-9]+/.exec(raw);
    if (match === null) return;
    const number = parseInt(match[0], 10);
    if (number > 65535) return;
    state.port = number === defaultPort(state.scheme) ? "" : String(number);
  }

  get pathname() {
    return getURLState(this).path;
  }

  set pathname(value) {
    const state = getURLState(this);
    if (state.opaque) return;
    const raw = stripTabsNewlines(value);
    const file = state.scheme === "file";
    if (raw === "" && state.hostname === null) {
      state.path = "/";
      return;
    }
    state.path = computePath(raw, isSpecial(state.scheme), file);
  }

  get search() {
    const state = getURLState(this);
    return state.query === null || state.query === "" ? "" : "?" + state.query;
  }

  set search(value) {
    const state = getURLState(this);
    const original = toUSVString(value);
    if (original === "") {
      state.query = null;
    } else {
      const raw = original.replace(/[\t\n\r]/g, "");
      const body = raw[0] === "?" ? raw.slice(1) : raw;
      state.query = encodeString(
        body,
        isSpecial(state.scheme) ? SET_SPECIAL_QUERY : SET_QUERY,
      );
    }
    const params = urlParams.get(this);
    if (params !== undefined) resetParamsList(params, state.query);
  }

  get searchParams() {
    return SEARCH_PARAMS_GETTER.call(this);
  }

  get hash() {
    const state = getURLState(this);
    return state.fragment === null || state.fragment === ""
      ? ""
      : "#" + state.fragment;
  }

  set hash(value) {
    const state = getURLState(this);
    const original = toUSVString(value);
    if (original === "") {
      state.fragment = null;
      return;
    }
    const raw = original.replace(/[\t\n\r]/g, "");
    const body = raw[0] === "#" ? raw.slice(1) : raw;
    state.fragment = encodeString(body, SET_FRAGMENT);
  }

  toString() {
    return this.href;
  }

  toJSON() {
    return this.href;
  }

  static canParse(input, base) {
    if (arguments.length === 0) throw missingArgs("url");
    try {
      // eslint-disable-next-line no-new
      new URL(input, base);
      return true;
    } catch {
      return false;
    }
  }

  static parse(input, base) {
    if (arguments.length === 0) throw missingArgs("url");
    try {
      return new URL(input, base);
    } catch {
      return null;
    }
  }
}

Object.defineProperty(URL.prototype, Symbol.toStringTag, {
  value: "URL",
  configurable: true,
});

function getOrigin(state) {
  if (state.scheme === "blob") {
    try {
      const inner = parseString(state.path, null);
      if (inner.scheme === "blob") return "null";
      return getOrigin(inner);
    } catch {
      return "null";
    }
  }
  if (!isSpecial(state.scheme) || state.scheme === "file") return "null";
  const host = getHostForOrigin(state);
  if (host === "") return "null";
  return state.scheme + "://" + host + (state.port === "" ? "" : ":" + state.port);
}

// ---------------------------------------------------------------------------
// Legacy Url API (ported from Node's lib/url.js, MIT)
// ---------------------------------------------------------------------------

function Url() {
  this.protocol = null;
  this.slashes = null;
  this.auth = null;
  this.host = null;
  this.port = null;
  this.hostname = null;
  this.hash = null;
  this.search = null;
  this.query = null;
  this.pathname = null;
  this.path = null;
  this.href = null;
}

const protocolPattern = /^[a-z0-9.+-]+:/i;
const portPattern = /:[0-9]*$/;
const hostPattern = /^\/\/[^@/]+@[^@/]+/;
const simplePathPattern = /^(\/\/?(?!\/)[^?\s]*)(\?[^\s]*)?$/;
const hostnameMaxLen = 255;

const CHAR_SPACE = 32;
const CHAR_TAB = 9;
const CHAR_LINE_FEED = 10;
const CHAR_CARRIAGE_RETURN = 13;
const CHAR_NO_BREAK_SPACE = 0xa0;
const CHAR_ZERO_WIDTH_NOBREAK_SPACE = 0xfeff;
const CHAR_HASH = 35;
const CHAR_FORWARD_SLASH = 47;
const CHAR_LEFT_SQUARE_BRACKET = 91;
const CHAR_RIGHT_SQUARE_BRACKET = 93;
const CHAR_LEFT_ANGLE_BRACKET = 60;
const CHAR_RIGHT_ANGLE_BRACKET = 62;
const CHAR_LEFT_CURLY_BRACKET = 123;
const CHAR_RIGHT_CURLY_BRACKET = 125;
const CHAR_QUESTION_MARK = 63;
const CHAR_DOUBLE_QUOTE = 34;
const CHAR_SINGLE_QUOTE = 39;
const CHAR_PERCENT = 37;
const CHAR_SEMICOLON = 59;
const CHAR_BACKWARD_SLASH = 92;
const CHAR_CIRCUMFLEX_ACCENT = 94;
const CHAR_GRAVE_ACCENT = 96;
const CHAR_VERTICAL_LINE = 124;
const CHAR_AT = 64;
const CHAR_COLON = 58;

const unsafeProtocol = new Set(["javascript", "javascript:"]);
const hostlessProtocol = new Set(["javascript", "javascript:"]);
const slashedProtocol = new Set([
  "http", "http:",
  "https", "https:",
  "ftp", "ftp:",
  "gopher", "gopher:",
  "file", "file:",
  "ws", "ws:",
  "wss", "wss:",
]);

function validateString(value, name) {
  if (typeof value !== "string") throw invalidArgType(name, "of type string", value);
}

function isIpv6Hostname(hostname) {
  return hostname.charCodeAt(0) === CHAR_LEFT_SQUARE_BRACKET &&
    hostname.charCodeAt(hostname.length - 1) === CHAR_RIGHT_SQUARE_BRACKET;
}

const forbiddenHostChars = /[\0\t\n\r #%/:<>?@[\\\]^|]/;
const forbiddenHostCharsIpv6 = /[\0\t\n\r #%/<>?@\\^|]/;

Url.prototype.parse = function parse(url, parseQueryString, slashesDenoteHost) {
  validateString(url, "url");

  let hasHash = false;
  let hasAt = false;
  let start = -1;
  let end = -1;
  let rest = "";
  let lastPos = 0;
  for (let i = 0, inWs = false, split = false; i < url.length; ++i) {
    const code = url.charCodeAt(i);

    const isWs = code < 33 ||
      code === CHAR_NO_BREAK_SPACE ||
      code === CHAR_ZERO_WIDTH_NOBREAK_SPACE;
    if (start === -1) {
      if (isWs) continue;
      lastPos = start = i;
    } else if (inWs) {
      if (!isWs) {
        end = -1;
        inWs = false;
      }
    } else if (isWs) {
      end = i;
      inWs = true;
    }

    if (!split) {
      switch (code) {
        case CHAR_AT:
          hasAt = true;
          break;
        case CHAR_HASH:
          hasHash = true;
        // fall through
        case CHAR_QUESTION_MARK:
          split = true;
          break;
        case CHAR_BACKWARD_SLASH:
          if (i - lastPos > 0) rest += url.slice(lastPos, i);
          rest += "/";
          lastPos = i + 1;
          break;
      }
    } else if (!hasHash && code === CHAR_HASH) {
      hasHash = true;
    }
  }

  if (start !== -1) {
    if (lastPos === start) {
      if (end === -1) {
        rest = start === 0 ? url : url.slice(start);
      } else {
        rest = url.slice(start, end);
      }
    } else if (end === -1 && lastPos < url.length) {
      rest += url.slice(lastPos);
    } else if (end !== -1 && lastPos < end) {
      rest += url.slice(lastPos, end);
    }
  }

  if (!slashesDenoteHost && !hasHash && !hasAt) {
    const simplePath = simplePathPattern.exec(rest);
    if (simplePath) {
      this.path = rest;
      this.href = rest;
      this.pathname = simplePath[1];
      if (simplePath[2]) {
        this.search = simplePath[2];
        if (parseQueryString) {
          this.query = querystring.parse(this.search.slice(1));
        } else {
          this.query = this.search.slice(1);
        }
      } else if (parseQueryString) {
        this.search = null;
        this.query = { __proto__: null };
      }
      return this;
    }
  }

  let proto = protocolPattern.exec(rest);
  let lowerProto;
  if (proto) {
    proto = proto[0];
    lowerProto = proto.toLowerCase();
    this.protocol = lowerProto;
    rest = rest.slice(proto.length);
  }

  let slashes;
  if (slashesDenoteHost || proto || hostPattern.test(rest)) {
    slashes = rest.charCodeAt(0) === CHAR_FORWARD_SLASH &&
      rest.charCodeAt(1) === CHAR_FORWARD_SLASH;
    if (slashes && !(proto && hostlessProtocol.has(lowerProto))) {
      rest = rest.slice(2);
      this.slashes = true;
    }
  }

  if (!hostlessProtocol.has(lowerProto) &&
      (slashes || (proto && !slashedProtocol.has(proto)))) {
    let hostEnd = -1;
    let atSign = -1;
    let nonHost = -1;
    for (let i = 0; i < rest.length; ++i) {
      switch (rest.charCodeAt(i)) {
        case CHAR_TAB:
        case CHAR_LINE_FEED:
        case CHAR_CARRIAGE_RETURN:
          rest = rest.slice(0, i) + rest.slice(i + 1);
          i -= 1;
          break;
        case CHAR_SPACE:
        case CHAR_DOUBLE_QUOTE:
        case CHAR_PERCENT:
        case CHAR_SINGLE_QUOTE:
        case CHAR_SEMICOLON:
        case CHAR_LEFT_ANGLE_BRACKET:
        case CHAR_RIGHT_ANGLE_BRACKET:
        case CHAR_BACKWARD_SLASH:
        case CHAR_CIRCUMFLEX_ACCENT:
        case CHAR_GRAVE_ACCENT:
        case CHAR_LEFT_CURLY_BRACKET:
        case CHAR_VERTICAL_LINE:
        case CHAR_RIGHT_CURLY_BRACKET:
          if (nonHost === -1) nonHost = i;
          break;
        case CHAR_HASH:
        case CHAR_FORWARD_SLASH:
        case CHAR_QUESTION_MARK:
          if (nonHost === -1) nonHost = i;
          hostEnd = i;
          break;
        case CHAR_AT:
          atSign = i;
          nonHost = -1;
          break;
      }
      if (hostEnd !== -1) break;
    }
    start = 0;
    if (atSign !== -1) {
      this.auth = decodeURIComponent(rest.slice(0, atSign));
      start = atSign + 1;
    }
    if (nonHost === -1) {
      this.host = rest.slice(start);
      rest = "";
    } else {
      this.host = rest.slice(start, nonHost);
      rest = rest.slice(nonHost);
    }

    this.parseHost();

    if (typeof this.hostname !== "string") this.hostname = "";

    const hostname = this.hostname;
    const ipv6Hostname = isIpv6Hostname(hostname);

    if (!ipv6Hostname) {
      rest = getHostname(this, rest, hostname, url);
    }

    if (this.hostname.length > hostnameMaxLen) {
      this.hostname = "";
    } else {
      this.hostname = this.hostname.toLowerCase();
    }

    if (this.hostname !== "") {
      if (ipv6Hostname) {
        if (forbiddenHostCharsIpv6.test(this.hostname)) {
          throw invalidURL(url);
        }
      } else {
        this.hostname = domainToASCIISafe(this.hostname);
        if (this.hostname === "" || forbiddenHostChars.test(this.hostname)) {
          throw invalidURL(url);
        }
      }
    }

    const p = this.port ? ":" + this.port : "";
    const h = this.hostname || "";
    this.host = h + p;

    if (ipv6Hostname) {
      this.hostname = this.hostname.slice(1, -1);
      if (rest[0] !== "/") rest = "/" + rest;
    }
  }

  if (!unsafeProtocol.has(lowerProto)) {
    rest = autoEscapeStr(rest);
  }

  let questionIdx = -1;
  let hashIdx = -1;
  for (let i = 0; i < rest.length; ++i) {
    const code = rest.charCodeAt(i);
    if (code === CHAR_HASH) {
      this.hash = rest.slice(i);
      hashIdx = i;
      break;
    } else if (code === CHAR_QUESTION_MARK && questionIdx === -1) {
      questionIdx = i;
    }
  }

  if (questionIdx !== -1) {
    if (hashIdx === -1) {
      this.search = rest.slice(questionIdx);
      this.query = rest.slice(questionIdx + 1);
    } else {
      this.search = rest.slice(questionIdx, hashIdx);
      this.query = rest.slice(questionIdx + 1, hashIdx);
    }
    if (parseQueryString) {
      this.query = querystring.parse(this.query);
    }
  } else if (parseQueryString) {
    this.search = null;
    this.query = { __proto__: null };
  }

  const useQuestionIdx = questionIdx !== -1 &&
    (hashIdx === -1 || questionIdx < hashIdx);
  const firstIdx = useQuestionIdx ? questionIdx : hashIdx;
  if (firstIdx === -1) {
    if (rest.length > 0) this.pathname = rest;
  } else if (firstIdx > 0) {
    this.pathname = rest.slice(0, firstIdx);
  }
  if (slashedProtocol.has(lowerProto) && this.hostname && !this.pathname) {
    this.pathname = "/";
  }

  if (this.pathname || this.search) {
    const p = this.pathname || "";
    const s = this.search || "";
    this.path = p + s;
  }

  this.href = this.format();
  return this;
};

function getHostname(self, rest, hostname, url) {
  for (let i = 0; i < hostname.length; ++i) {
    const code = hostname.charCodeAt(i);
    const isValid = code !== CHAR_FORWARD_SLASH &&
      code !== CHAR_BACKWARD_SLASH &&
      code !== CHAR_HASH &&
      code !== CHAR_QUESTION_MARK &&
      code !== CHAR_COLON;

    if (!isValid) {
      if (code === CHAR_COLON) {
        const err = new TypeError(
          `The argument 'url' is invalid. Invalid port in url. Received '${url}'`,
        );
        err.code = "ERR_INVALID_ARG_VALUE";
        throw err;
      }
      self.hostname = hostname.slice(0, i);
      return `/${hostname.slice(i)}${rest}`;
    }
  }
  return rest;
}

const escapedCodes = [
  /* 0 - 9 */ "", "", "", "", "", "", "", "", "", "%09",
  /* 10 - 19 */ "%0A", "", "", "%0D", "", "", "", "", "", "",
  /* 20 - 29 */ "", "", "", "", "", "", "", "", "", "",
  /* 30 - 39 */ "", "", "%20", "", "%22", "", "", "", "", "%27",
  /* 40 - 49 */ "", "", "", "", "", "", "", "", "", "",
  /* 50 - 59 */ "", "", "", "", "", "", "", "", "", "",
  /* 60 - 69 */ "%3C", "", "%3E", "", "", "", "", "", "", "",
  /* 70 - 79 */ "", "", "", "", "", "", "", "", "", "",
  /* 80 - 89 */ "", "", "", "", "", "", "", "", "", "",
  /* 90 - 99 */ "", "", "%5C", "", "%5E", "", "%60", "", "", "",
  /* 100 - 109 */ "", "", "", "", "", "", "", "", "", "",
  /* 110 - 119 */ "", "", "", "", "", "", "", "", "", "",
  /* 120 - 125 */ "", "", "", "%7B", "%7C", "%7D",
];

function autoEscapeStr(rest) {
  let escaped = "";
  let lastEscapedPos = 0;
  for (let i = 0; i < rest.length; ++i) {
    const escapedChar = escapedCodes[rest.charCodeAt(i)];
    if (escapedChar) {
      if (i > lastEscapedPos) escaped += rest.slice(lastEscapedPos, i);
      escaped += escapedChar;
      lastEscapedPos = i + 1;
    }
  }
  if (lastEscapedPos === 0) return rest;
  if (lastEscapedPos < rest.length) escaped += rest.slice(lastEscapedPos);
  return escaped;
}

function encodeWithTable(str, table) {
  let out = "";
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) {
      out += table[c] === 1 ? str[i] : pct(c);
    } else if (c < 0x800) {
      out += pct(0xc0 | (c >> 6)) + pct(0x80 | (c & 0x3f));
    } else if (c < 0xd800 || c >= 0xe000) {
      out += pct(0xe0 | (c >> 12)) +
        pct(0x80 | ((c >> 6) & 0x3f)) +
        pct(0x80 | (c & 0x3f));
    } else {
      i++;
      const c2 = (str.charCodeAt(i) | 0) & 0x3ff;
      const cp = 0x10000 + (((c & 0x3ff) << 10) | c2);
      out += pct(0xf0 | (cp >> 18)) +
        pct(0x80 | ((cp >> 12) & 0x3f)) +
        pct(0x80 | ((cp >> 6) & 0x3f)) +
        pct(0x80 | (cp & 0x3f));
    }
  }
  return out;
}

// ! - . _ ~ ' ( ) * : digits alpha left unescaped in auth.
const noEscapeAuth = new Int8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 0x00 - 0x0F
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 0x10 - 0x1F
  0, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 0, // 0x20 - 0x2F
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, // 0x30 - 0x3F
  0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 0x40 - 0x4F
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, // 0x50 - 0x5F
  0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 0x60 - 0x6F
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0, // 0x70 - 0x7F
]);

Url.prototype.format = function format() {
  let auth = this.auth || "";
  if (auth) {
    auth = encodeWithTable(auth, noEscapeAuth);
    auth += "@";
  }

  let protocol = this.protocol || "";
  if (protocol && protocol.charCodeAt(protocol.length - 1) !== CHAR_COLON) {
    protocol += ":";
  }

  let pathname = this.pathname || "";
  let hash = this.hash || "";
  let host = "";
  let query = "";

  if (this.host) {
    host = auth + this.host;
  } else if (this.hostname) {
    host = auth + (
      this.hostname.indexOf(":") !== -1 && !isIpv6Hostname(this.hostname)
        ? "[" + this.hostname + "]"
        : this.hostname
    );
    if (this.port) host += ":" + this.port;
  }

  if (this.query !== null && typeof this.query === "object") {
    query = querystring.stringify(this.query);
  }
  let search = this.search || (query && "?" + query) || "";

  if (pathname.indexOf("#") !== -1 || pathname.indexOf("?") !== -1) {
    let newPathname = "";
    let lastPos = 0;
    const len = pathname.length;
    for (let i = 0; i < len; i++) {
      const code = pathname.charCodeAt(i);
      if (code === CHAR_HASH || code === CHAR_QUESTION_MARK) {
        if (i > lastPos) newPathname += pathname.slice(lastPos, i);
        newPathname += code === CHAR_HASH ? "%23" : "%3F";
        lastPos = i + 1;
      }
    }
    if (lastPos < len) newPathname += pathname.slice(lastPos);
    pathname = newPathname;
  }

  if (this.slashes || slashedProtocol.has(protocol)) {
    if (this.slashes || host) {
      if (pathname && pathname.charCodeAt(0) !== CHAR_FORWARD_SLASH) {
        pathname = "/" + pathname;
      }
      host = "//" + host;
    } else if (protocol.length >= 4 &&
               protocol.charCodeAt(0) === 102 /* f */ &&
               protocol.charCodeAt(1) === 105 /* i */ &&
               protocol.charCodeAt(2) === 108 /* l */ &&
               protocol.charCodeAt(3) === 101 /* e */) {
      host = "//";
    }
  }

  if (search.indexOf("#") !== -1) {
    search = search.replace(/#/g, "%23");
  }

  if (hash && hash.charCodeAt(0) !== CHAR_HASH) hash = "#" + hash;
  if (search && search.charCodeAt(0) !== CHAR_QUESTION_MARK) search = "?" + search;

  return protocol + host + pathname + search + hash;
};

function urlFormat(urlObject, options) {
  if (typeof urlObject === "string") {
    urlObject = urlParse(urlObject);
  } else if (typeof urlObject !== "object" || urlObject === null) {
    throw invalidArgType("urlObject", "one of type object or string", urlObject);
  } else if (urlObject instanceof URL) {
    let fragment = true;
    let unicode = false;
    let search = true;
    let auth = true;

    if (options !== undefined) {
      if (typeof options !== "object" || options === null) {
        throw invalidArgType("options", "of type object", options);
      }
      if (options.fragment != null) fragment = Boolean(options.fragment);
      if (options.unicode != null) unicode = Boolean(options.unicode);
      if (options.search != null) search = Boolean(options.search);
      if (options.auth != null) auth = Boolean(options.auth);
    }

    const state = getURLState(urlObject);
    let host = state.hostname === null ? "" : state.hostname;
    if (unicode && host !== "" && host[0] !== "[") {
      const decoded = domainToUnicode(host);
      if (decoded !== "") host = decoded;
    }
    let userinfo = "";
    if (auth && (state.username !== "" || state.password !== "")) {
      userinfo = state.username;
      if (state.password !== "") userinfo += ":" + state.password;
      userinfo += "@";
    }
    let href = state.scheme + ":";
    if (state.hostname !== null) {
      href += "//" + userinfo + host;
      if (state.port !== "") href += ":" + state.port;
    }
    href += state.path;
    if (search && state.query !== null) href += "?" + state.query;
    if (fragment && state.fragment !== null) href += "#" + state.fragment;
    return href;
  }

  return Url.prototype.format.call(urlObject);
}

function urlParse(url, parseQueryString, slashesDenoteHost) {
  if (url instanceof Url) return url;

  const urlObject = new Url();
  urlObject.parse(url, parseQueryString, slashesDenoteHost);
  return urlObject;
}

function spliceOne(list, index) {
  for (let i = index; i + 1 < list.length; i++) list[i] = list[i + 1];
  list.pop();
}

function urlResolve(source, relative) {
  return urlParse(source, false, true).resolve(relative);
}

Url.prototype.resolve = function resolve(relative) {
  return this.resolveObject(urlParse(relative, false, true)).format();
};

function urlResolveObject(source, relative) {
  if (!source) return relative;
  return urlParse(source, false, true).resolveObject(relative);
}

Url.prototype.resolveObject = function resolveObject(relative) {
  if (typeof relative === "string") {
    const rel = new Url();
    rel.parse(relative, false, true);
    relative = rel;
  }

  const result = new Url();
  Object.assign(result, this);

  result.hash = relative.hash;

  if (relative.href === "") {
    result.href = result.format();
    return result;
  }

  if (relative.slashes && !relative.protocol) {
    const relativeWithoutProtocol = {};
    for (const key of Object.keys(relative)) {
      if (key !== "protocol") relativeWithoutProtocol[key] = relative[key];
    }
    Object.assign(result, relativeWithoutProtocol);

    if (slashedProtocol.has(result.protocol) &&
        result.hostname && !result.pathname) {
      result.path = result.pathname = "/";
    }

    result.href = result.format();
    return result;
  }

  if (relative.protocol && relative.protocol !== result.protocol) {
    if (!slashedProtocol.has(relative.protocol)) {
      Object.assign(result, relative);
      result.href = result.format();
      return result;
    }

    result.protocol = relative.protocol;
    if (!relative.host &&
        !/^file:?$/.test(relative.protocol) &&
        !hostlessProtocol.has(relative.protocol)) {
      const relPath = (relative.pathname || "").split("/");
      while (relPath.length && !(relative.host = relPath.shift())) {
        // keep shifting until a host segment is found
      }
      relative.host ||= "";
      relative.hostname ||= "";
      if (relPath[0] !== "") relPath.unshift("");
      if (relPath.length < 2) relPath.unshift("");
      result.pathname = relPath.join("/");
    } else {
      result.pathname = relative.pathname;
    }
    result.search = relative.search;
    result.query = relative.query;
    result.host = relative.host || "";
    result.auth = relative.auth;
    result.hostname = relative.hostname || relative.host;
    result.port = relative.port;
    if (result.pathname || result.search) {
      const p = result.pathname || "";
      const s = result.search || "";
      result.path = p + s;
    }
    result.slashes ||= relative.slashes;
    result.href = result.format();
    return result;
  }

  const isSourceAbs = result.pathname && result.pathname.charAt(0) === "/";
  const isRelAbs = relative.host ||
    (relative.pathname && relative.pathname.charAt(0) === "/");
  let mustEndAbs = isRelAbs || isSourceAbs || (result.host && relative.pathname);
  const removeAllDots = mustEndAbs;
  let srcPath = (result.pathname && result.pathname.split("/")) || [];
  const relPath = (relative.pathname && relative.pathname.split("/")) || [];
  const noLeadingSlashes = result.protocol &&
    !slashedProtocol.has(result.protocol);

  if (noLeadingSlashes) {
    result.hostname = "";
    result.port = null;
    if (result.host) {
      if (srcPath[0] === "") srcPath[0] = result.host;
      else srcPath.unshift(result.host);
    }
    result.host = "";
    if (relative.protocol) {
      relative.hostname = null;
      relative.port = null;
      result.auth = null;
      if (relative.host) {
        if (relPath[0] === "") relPath[0] = relative.host;
        else relPath.unshift(relative.host);
      }
      relative.host = null;
    }
    mustEndAbs &&= relPath[0] === "" || srcPath[0] === "";
  }

  if (isRelAbs) {
    if (relative.host || relative.host === "") {
      if (result.host !== relative.host) result.auth = null;
      result.host = relative.host;
      result.port = relative.port;
    }
    if (relative.hostname || relative.hostname === "") {
      if (result.hostname !== relative.hostname) result.auth = null;
      result.hostname = relative.hostname;
    }
    result.search = relative.search;
    result.query = relative.query;
    srcPath = relPath;
  } else if (relPath.length) {
    srcPath ||= [];
    srcPath.pop();
    srcPath = srcPath.concat(relPath);
    result.search = relative.search;
    result.query = relative.query;
  } else if (relative.search !== null && relative.search !== undefined) {
    if (noLeadingSlashes) {
      result.hostname = result.host = srcPath.shift();
      const authInHost = result.host && result.host.indexOf("@") > 0 &&
        result.host.split("@");
      if (authInHost) {
        result.auth = authInHost.shift();
        result.host = result.hostname = authInHost.shift();
      }
    }
    result.search = relative.search;
    result.query = relative.query;
    if (result.pathname !== null || result.search !== null) {
      result.path = (result.pathname ? result.pathname : "") +
        (result.search ? result.search : "");
    }
    result.href = result.format();
    return result;
  }

  if (!srcPath.length) {
    result.pathname = null;
    if (result.search) result.path = "/" + result.search;
    else result.path = null;
    result.href = result.format();
    return result;
  }

  let last = srcPath[srcPath.length - 1];
  const hasTrailingSlash =
    ((result.host || relative.host || srcPath.length > 1) &&
      (last === "." || last === "..")) || last === "";

  let up = 0;
  for (let i = srcPath.length - 1; i >= 0; i--) {
    last = srcPath[i];
    if (last === ".") {
      spliceOne(srcPath, i);
    } else if (last === "..") {
      spliceOne(srcPath, i);
      up++;
    } else if (up) {
      spliceOne(srcPath, i);
      up--;
    }
  }

  if (!mustEndAbs && !removeAllDots) {
    while (up--) srcPath.unshift("..");
  }

  if (mustEndAbs && srcPath[0] !== "" &&
      (!srcPath[0] || srcPath[0].charAt(0) !== "/")) {
    srcPath.unshift("");
  }

  if (hasTrailingSlash && srcPath.join("/").slice(-1) !== "/") {
    srcPath.push("");
  }

  const isAbsolute = srcPath[0] === "" ||
    (srcPath[0] && srcPath[0].charAt(0) === "/");

  if (noLeadingSlashes) {
    result.hostname = result.host = isAbsolute ? "" :
      srcPath.length ? srcPath.shift() : "";
    const authInHost = result.host && result.host.indexOf("@") > 0
      ? result.host.split("@")
      : false;
    if (authInHost) {
      result.auth = authInHost.shift();
      result.host = result.hostname = authInHost.shift();
    }
  }

  mustEndAbs ||= (result.host && srcPath.length);

  if (mustEndAbs && !isAbsolute) srcPath.unshift("");

  if (!srcPath.length) {
    result.pathname = null;
    result.path = null;
  } else {
    result.pathname = srcPath.join("/");
  }

  if (result.pathname !== null || result.search !== null) {
    result.path = (result.pathname ? result.pathname : "") +
      (result.search ? result.search : "");
  }
  result.auth = relative.auth || result.auth;
  result.slashes ||= relative.slashes;
  result.href = result.format();
  return result;
};

Url.prototype.parseHost = function parseHost() {
  let host = this.host;
  let port = portPattern.exec(host);
  if (port) {
    port = port[0];
    if (port !== ":") this.port = port.slice(1);
    host = host.slice(0, host.length - port.length);
  }
  if (host) this.hostname = host;
};

// ---------------------------------------------------------------------------
// HTTP options + file URL helpers
// ---------------------------------------------------------------------------

function urlToHttpOptions(url) {
  if (typeof url !== "object" || url === null) {
    throw invalidArgType("url", "of type object", url);
  }
  const { hostname, pathname, port, username, password, search } = url;
  const options = {
    __proto__: null,
    ...url,
    protocol: url.protocol,
    hostname: hostname && hostname[0] === "[" ? hostname.slice(1, -1) : hostname,
    hash: url.hash,
    search,
    pathname,
    path: `${pathname || ""}${search || ""}`,
    href: url.href,
  };
  if (port !== "") options.port = Number(port);
  if (username || password) {
    options.auth = `${decodeURIComponent(username)}:${decodeURIComponent(password)}`;
  }
  return options;
}

function currentPlatform() {
  if (typeof globalThis.process === "object" && globalThis.process &&
      typeof globalThis.process.platform === "string") {
    return globalThis.process.platform;
  }
  if (globalThis.__ln_host && typeof globalThis.__ln_host.platform === "string") {
    return globalThis.__ln_host.platform;
  }
  return "linux";
}

function currentCwd() {
  if (typeof globalThis.process === "object" && globalThis.process &&
      typeof globalThis.process.cwd === "function") {
    return globalThis.process.cwd();
  }
  if (globalThis.__ln_host && typeof globalThis.__ln_host.cwd === "function") {
    return globalThis.__ln_host.cwd();
  }
  return "/";
}

let cachedPath;
let triedPath = false;

function getPathModule() {
  if (!triedPath) {
    triedPath = true;
    try {
      cachedPath = require("path");
    } catch {
      cachedPath = null;
    }
  }
  return cachedPath;
}

function getPathFromURLPosix(url) {
  if (url.hostname !== "") {
    throw invalidFileURLHost(currentPlatform());
  }
  const pathname = url.pathname;
  for (let n = 0; n < pathname.length; n++) {
    if (pathname[n] === "%") {
      const third = pathname.codePointAt(n + 2) | 0x20;
      if (pathname[n + 1] === "2" && third === 0x66) {
        throw invalidFileURLPath("must not include encoded / characters", url);
      }
    }
  }
  return pathname.includes("%") ? decodeURIComponent(pathname) : pathname;
}

function getPathFromURLWin32(url) {
  const hostname = url.hostname;
  let pathname = url.pathname;
  for (let n = 0; n < pathname.length; n++) {
    if (pathname[n] === "%") {
      const third = pathname.codePointAt(n + 2) | 0x20;
      if ((pathname[n + 1] === "2" && third === 0x66) ||
          (pathname[n + 1] === "5" && third === 0x63)) {
        throw invalidFileURLPath(
          "must not include encoded \\ or / characters", url,
        );
      }
    }
  }
  pathname = pathname.replace(/\//g, "\\");
  if (pathname.includes("%")) pathname = decodeURIComponent(pathname);
  if (hostname !== "") {
    return `\\\\${domainToUnicode(hostname)}${pathname}`;
  }
  const letter = pathname.codePointAt(1) | 0x20;
  const sep = pathname[2];
  if (letter < 0x61 || letter > 0x7a || sep !== ":") {
    throw invalidFileURLPath("must be absolute", url);
  }
  return pathname.slice(1);
}

function fileURLToPath(path, options = {}) {
  const windows = options !== null && options !== undefined ? options.windows : undefined;
  if (typeof path === "string") path = new URL(path);
  else if (!(path instanceof URL)) {
    throw invalidArgType("path", "of type string or an instance of URL", path);
  }
  if (path.protocol !== "file:") throw invalidURLScheme("file");
  const useWindows = windows ?? currentPlatform() === "win32";
  return useWindows ? getPathFromURLWin32(path) : getPathFromURLPosix(path);
}

function percentEncodeFilePath(path) {
  return encodeString(path, SET_PATH_FILE);
}

function fallbackPosixResolve(input) {
  let value = input;
  let cwd = currentCwd();
  if (value[0] !== "/") value = cwd + "/" + value;
  const parts = value.split("/");
  const out = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0) out.pop();
    } else {
      out.push(part);
    }
  }
  return "/" + out.join("/");
}

// NOTE (known gap, docs/compat.md): Windows paths are converted directly
// instead of through the internal windows-path URL constructor. Drive paths
// match Node; the bare Windows roots ("\", "/") and the error cases for
// malformed UNC paths (missing share, empty server) differ.
function pathToFileURL(filepath, options = {}) {
  if (typeof filepath !== "string") {
    throw invalidArgType("path", "of type string", filepath);
  }
  const hostWindows = currentPlatform() === "win32";
  const windows = options !== null && options !== undefined &&
    options.windows !== undefined ? options.windows : hostWindows;
  const pathModule = getPathModule();
  const isUNC = windows && filepath.startsWith("\\\\");

  let resolved;
  let sep = windows ? "\\" : "/";
  if (isUNC) {
    resolved = filepath;
  } else if (pathModule) {
    resolved = windows
      ? pathModule.win32.resolve(filepath)
      : pathModule.posix.resolve(filepath);
    sep = windows ? pathModule.win32.sep : pathModule.posix.sep;
  } else {
    resolved = fallbackPosixResolve(filepath);
  }

  if (isUNC || (windows && resolved.startsWith("\\\\"))) {
    const body = resolved.replace(/\\/g, "/").replace(/^\/\//, "");
    const slash = body.indexOf("/");
    const hostRaw = slash === -1 ? body : body.slice(0, slash);
    let pathPart = slash === -1 ? "/" : body.slice(slash);
    if (!pathPart.startsWith("/")) pathPart = "/" + pathPart;
    let host = "";
    try {
      host = idnaToASCII(hostRaw);
    } catch {
      host = hostRaw;
    }
    return new URL("file://" + host + percentEncodeFilePath(pathPart));
  }

  const filePathLast = filepath.charCodeAt(filepath.length - 1);
  if ((filePathLast === 0x2f ||
       (windows && filePathLast === 0x5c)) &&
      resolved[resolved.length - 1] !== sep) {
    resolved += "/";
  }

  let urlPath = windows ? resolved.replace(/\\/g, "/") : resolved;
  if (urlPath[0] !== "/") urlPath = "/" + urlPath;
  return new URL("file://" + percentEncodeFilePath(urlPath));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  Url,
  parse: urlParse,
  resolve: urlResolve,
  resolveObject: urlResolveObject,
  format: urlFormat,

  URL,
  URLSearchParams,
  domainToASCII,
  domainToUnicode,

  pathToFileURL,
  fileURLToPath,
  urlToHttpOptions,
};
