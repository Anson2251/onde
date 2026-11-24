"use strict";

// onde's `util` module.
//
// The inspect() implementation is deliberately "Node-shaped" rather than a
// byte-for-byte port: it covers the value kinds a CLI or test runner actually
// prints (primitives, strings, arrays/objects, Map/Set, Date/RegExp/Error,
// typed arrays/Buffer, ArrayBuffer, boxed primitives, promises and circular
// structures) and follows Node's formatting rules for the common path.  Known
// gaps are documented in docs/compat.md; the differential oracle lives in
// test/js/lib/util.oracle.js.
//
// Nothing here may run at load time that depends on another stdlib module:
// util.js is loaded early and buffer.js/events.js may themselves require it.

const customInspectSymbol = Symbol.for("nodejs.util.inspect.custom");
const customPromisifySymbol = Symbol.for("nodejs.util.promisify.custom");
const customPromisifyArgsSymbol = Symbol.for("nodejs.util.promisify.customArgs");

const { invalidArgType } = require("./internal/errors.js");

const ObjectPrototypeToString = Object.prototype.toString;
const hasOwnProperty = Object.prototype.hasOwnProperty;
const propertyIsEnumerable = Object.prototype.propertyIsEnumerable;

const inspectDefaultOptions = {
  showHidden: false,
  depth: 2,
  colors: false,
  customInspect: true,
  showProxy: false,
  maxArrayLength: 100,
  maxStringLength: 10000,
  breakLength: 80,
  compact: 3,
  sorted: false,
  getters: false,
  numericSeparator: false,
};

// Copied from Node's internal/util/inspect (chalk/ansi-regex, MIT).
const ansiRegex = new RegExp(
  "(?:\\u001B\\][\\s\\S]*?(?:\\u0007|\\u001B\\u005C|\\u009C))" +
    "|[\\u001B\\u009B][[\\]()#;?]*" +
    "(?:\\d{1,4}(?:[;:]\\d{0,4})*)?" +
    "[\\dA-PR-TZcf-nq-uy=><~]",
  "g",
);

function isObjectLike(value) {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  );
}

function tagOf(value) {
  try {
    return ObjectPrototypeToString.call(value).slice(8, -1);
  } catch {
    return "Object";
  }
}

function hasOwn(value, key) {
  return hasOwnProperty.call(value, key);
}

function isEnumerable(value, key) {
  return propertyIsEnumerable.call(value, key);
}

function isErrorValue(value) {
  if (!isObjectLike(value)) return false;
  if (typeof Error !== "undefined" && value instanceof Error) return true;
  const tag = tagOf(value);
  return tag === "Error" || tag === "AggregateError";
}

function isDateValue(value) {
  return isObjectLike(value) && (tagOf(value) === "Date" || value instanceof Date);
}

function isRegExpValue(value) {
  return (
    isObjectLike(value) &&
    (tagOf(value) === "RegExp" || value instanceof RegExp)
  );
}

function isMapValue(value) {
  return isObjectLike(value) && tagOf(value) === "Map";
}

function isSetValue(value) {
  return isObjectLike(value) && tagOf(value) === "Set";
}

function isWeakMapValue(value) {
  return isObjectLike(value) && tagOf(value) === "WeakMap";
}

function isWeakSetValue(value) {
  return isObjectLike(value) && tagOf(value) === "WeakSet";
}

function isPromiseValue(value) {
  return isObjectLike(value) && tagOf(value) === "Promise";
}

function isArrayBufferValue(value) {
  const tag = isObjectLike(value) ? tagOf(value) : "";
  return tag === "ArrayBuffer" || tag === "SharedArrayBuffer";
}

function isSharedArrayBufferValue(value) {
  return isObjectLike(value) && tagOf(value) === "SharedArrayBuffer";
}

function isArrayBufferViewValue(value) {
  return (
    isObjectLike(value) &&
    typeof ArrayBuffer !== "undefined" &&
    ArrayBuffer.isView(value)
  );
}

function isDataViewValue(value) {
  return isObjectLike(value) && tagOf(value) === "DataView";
}

function isTypedArrayValue(value) {
  return isArrayBufferViewValue(value) && !isDataViewValue(value);
}

function isBoxedPrimitiveValue(value) {
  if (!isObjectLike(value) || typeof value === "function") return false;
  const tag = tagOf(value);
  return (
    tag === "Number" ||
    tag === "String" ||
    tag === "Boolean" ||
    tag === "Symbol" ||
    tag === "BigInt"
  );
}

function isPromiseLike(value) {
  return (
    isObjectLike(value) &&
    typeof value.then === "function" &&
    typeof value.catch === "function"
  );
}

function constructorName(value) {
  try {
    const proto = Object.getPrototypeOf(value);
    if (proto === null) return null;
    const ctor = value.constructor;
    if (typeof ctor === "function" && typeof ctor.name === "string") {
      return ctor.name;
    }
  } catch {
    // Fall through.
  }
  return "Object";
}

function isPlainishObject(value) {
  const tag = tagOf(value);
  return tag === "Object" || tag === "Arguments";
}

// ---------------------------------------------------------------------------
// Number / string / symbol formatting
// ---------------------------------------------------------------------------

function formatNumber(value, options) {
  if (Object.is(value, -0)) return "-0";
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  let out = String(value);
  if (options && options.numericSeparator && Number.isFinite(value)) {
    out = addNumericSeparators(out);
  }
  return out;
}

function addNumericSeparators(text) {
  let sign = "";
  if (text[0] === "-" || text[0] === "+") {
    sign = text[0];
    text = text.slice(1);
  }
  let exponent = "";
  const eIndex = text.search(/[eE]/);
  if (eIndex !== -1) {
    exponent = text.slice(eIndex);
    text = text.slice(0, eIndex);
  }
  let integer = text;
  let fraction = "";
  const dot = text.indexOf(".");
  if (dot !== -1) {
    integer = text.slice(0, dot);
    fraction = text.slice(dot);
  }
  integer = integer.replace(/\B(?=(\d{3})+(?!\d))/g, "_");
  if (fraction.length > 1) {
    fraction =
      "." +
      fraction
        .slice(1)
        .replace(/(\d{3})(?=\d)/g, "$1_");
  }
  return sign + integer + fraction + exponent;
}

function formatBigInt(value, options) {
  let out = value.toString();
  if (options && options.numericSeparator) {
    out = addNumericSeparators(out);
  }
  return out + "n";
}

function formatSymbol(value) {
  const desc = value.description;
  return `Symbol(${desc === undefined ? "" : desc})`;
}

function isIdentifierKey(key) {
  if (key.length === 0) return false;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

function hex(value, width, upper) {
  let out = value.toString(16);
  while (out.length < width) out = "0" + out;
  return upper ? out.toUpperCase() : out;
}

const namedEscapes = {
  0x08: "\\b",
  0x09: "\\t",
  0x0a: "\\n",
  0x0c: "\\f",
  0x0d: "\\r",
};

function chooseQuote(str) {
  if (str.indexOf("'") === -1) return "'";
  if (str.indexOf('"') === -1) return '"';
  if (str.indexOf("`") === -1 && str.indexOf("${") === -1) return "`";
  return "'";
}

function escapeStringBody(str, quote) {
  let out = "";
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    const ch = str[i];
    if (ch === "\\") {
      out += "\\\\";
      continue;
    }
    if (quote === "`" && ch === "`") {
      out += "\\`";
      continue;
    }
    if (ch === quote) {
      out += "\\" + quote;
      continue;
    }
    const named = namedEscapes[code];
    if (named !== undefined) {
      out += named;
      continue;
    }
    if (code === 0x00) {
      out += "\\x00";
      continue;
    }
    if (code === 0x7f) {
      out += "\\x7F";
      continue;
    }
    if (code < 0x20 || (code >= 0x80 && code <= 0x9f)) {
      out += "\\x" + hex(code, 2, true);
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += ch + str[i + 1];
        i++;
        continue;
      }
      out += "\\u" + hex(code, 4, false);
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += "\\u" + hex(code, 4, false);
      continue;
    }
    out += ch;
  }
  return out;
}

function formatString(value, maxLength) {
  let str = value;
  let truncated = "";
  if (typeof maxLength === "number" && maxLength >= 0 && str.length > maxLength) {
    truncated = `... ${str.length - maxLength} more character${
      str.length - maxLength === 1 ? "" : "s"
    }`;
    str = str.slice(0, maxLength);
  }
  const quote = chooseQuote(str);
  return quote + escapeStringBody(str, quote) + quote + truncated;
}

// ---------------------------------------------------------------------------
// inspect()
// ---------------------------------------------------------------------------

function normalizeInspectOptions(options) {
  const base = inspectDefaultOptions;
  const opts = {
    showHidden: base.showHidden,
    depth: base.depth,
    colors: base.colors,
    customInspect: base.customInspect,
    showProxy: base.showProxy,
    maxArrayLength: base.maxArrayLength,
    maxStringLength: base.maxStringLength,
    breakLength: base.breakLength,
    compact: base.compact,
    sorted: base.sorted,
    getters: base.getters,
    numericSeparator: base.numericSeparator,
  };
  if (options !== null && typeof options === "object") {
    for (const key of Object.keys(opts)) {
      if (options[key] !== undefined) opts[key] = options[key];
    }
    opts.seen = options.seen;
    opts.stylize =
      typeof options.stylize === "function"
        ? options.stylize
        : (text) => text;
  } else {
    opts.stylize = (text) => text;
  }
  return opts;
}

function inspect(value, options) {
  const opts = normalizeInspectOptions(options);
  const ctx = {
    options: opts,
    path: [],
    nextRefId: 1,
    currentDepth: 0,
  };
  const depth =
    opts.depth === null || opts.depth === Infinity ? Infinity : Number(opts.depth);
  const deepest = nodeDepth(value, depth, new Set(), ctx) - 1;
  ctx.currentDepth = deepest < 0 ? 0 : deepest;
  return renderValue(value, ctx, depth, 0);
}

function findInPath(path, value) {
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i].value === value) return i;
  }
  return -1;
}

function customInspect(value, ctx) {
  if (!ctx.options.customInspect || !isObjectLike(value)) return undefined;
  let fn;
  try {
    fn = value[customInspectSymbol];
  } catch {
    fn = undefined;
  }
  if (typeof fn !== "function" || fn === inspect) {
    try {
      fn = value.inspect;
    } catch {
      fn = undefined;
    }
    if (typeof fn !== "function" || fn === inspect) return undefined;
  }
  const depth =
    ctx.options.depth === null || ctx.options.depth === Infinity
      ? null
      : ctx.options.depth - ctx.path.length;
  const ret = fn.call(value, depth, ctx.options, inspect);
  if (typeof ret === "string") return ret;
  return undefined;
}

function abbreviatedValue(value) {
  if (Array.isArray(value)) return "[Array]";
  if (isMapValue(value)) return "[Map]";
  if (isSetValue(value)) return "[Set]";
  if (isPromiseValue(value)) return "[Promise]";
  if (isErrorValue(value)) return `[${safeName(value)}]`;
  if (isWeakMapValue(value)) return "[WeakMap]";
  if (isWeakSetValue(value)) return "[WeakSet]";
  if (isArrayBufferValue(value)) {
    return isSharedArrayBufferValue(value)
      ? "[SharedArrayBuffer]"
      : "[ArrayBuffer]";
  }
  if (isDataViewValue(value)) return "[DataView]";
  if (isTypedArrayValue(value)) return `[${tagOf(value)}]`;
  const name = constructorName(value);
  if (name !== null && name !== "Object") return `[${name}]`;
  return "[Object]";
}

function safeName(err) {
  try {
    if (typeof err.name === "string" && err.name.length > 0) return err.name;
  } catch {
    // ignore
  }
  return "Error";
}

function shouldAbbreviateAtDepth(value) {
  if (typeof value === "function") return false;
  if (
    isDateValue(value) ||
    isRegExpValue(value) ||
    isBoxedPrimitiveValue(value) ||
    isErrorValue(value)
  ) {
    return false;
  }
  if (isPromiseValue(value) || isWeakMapValue(value) || isWeakSetValue(value)) {
    return true;
  }
  if (Array.isArray(value)) return value.length > 0;
  if (isMapValue(value)) return value.size > 0;
  if (isSetValue(value)) return value.size > 0;
  if (isTypedArrayValue(value)) {
    return constructorName(value) !== "Buffer";
  }
  if (isArrayBufferValue(value) || isDataViewValue(value)) return true;
  if (isPlainishObject(value)) {
    for (const key of Object.keys(value)) {
      if (key === "length" && Array.isArray(value)) continue;
      return true;
    }
    return false;
  }
  return true;
}

function renderValue(value, ctx, depth, indent) {
  switch (typeof value) {
    case "string":
      return formatString(value, ctx.options.maxStringLength);
    case "number":
      return formatNumber(value, ctx.options);
    case "bigint":
      return formatBigInt(value, ctx.options);
    case "boolean":
      return value ? "true" : "false";
    case "undefined":
      return "undefined";
    case "symbol":
      return formatSymbol(value);
    case "function":
      break;
    case "object":
      break;
    default:
      return String(value);
  }
  if (value === null) return "null";

  const custom = customInspect(value, ctx);
  if (custom !== undefined) return custom;

  const pathIndex = findInPath(ctx.path, value);
  if (pathIndex !== -1) {
    const entry = ctx.path[pathIndex];
    if (entry.refId === null) entry.refId = ctx.nextRefId++;
    return `[Circular *${entry.refId}]`;
  }

  if (depth < 0 && shouldAbbreviateAtDepth(value)) {
    return abbreviatedValue(value);
  }

  const entry = { value, refId: null };
  ctx.path.push(entry);
  let text;
  try {
    text = renderObjectValue(value, ctx, depth, indent);
  } finally {
    ctx.path.pop();
  }
  if (entry.refId !== null) text = `<ref *${entry.refId}> ` + text;
  return text;
}

function formatExtraProperties(
  value,
  ctx,
  depth,
  indent,
  skipKeys,
  forceMultiline,
  baseLength,
) {
  const skip =
    skipKeys === undefined
      ? null
      : skipKeys instanceof Set
        ? skipKeys
        : new Set(skipKeys);
  const keys = objectKeys(value, ctx, false);
  const entries = [];
  for (const key of keys) {
    if (key.type === "index") continue;
    if (skip !== null && key.type === "string" && skip.has(key.key)) continue;
    entries.push(formatProperty(key, value, ctx, depth, indent));
  }
  if (entries.length === 0) return "";
  const useCtx = forceMultiline
    ? { ...ctx, options: { ...ctx.options, compact: false } }
    : ctx;
  return (
    " " +
    container("{", "}", entries, useCtx, indent, value, depth, false, 0)
  );
}

function renderArray(value, ctx, depth, indent) {
  const opts = ctx.options;
  const max =
    opts.maxArrayLength === null || opts.maxArrayLength === Infinity
      ? value.length
      : Math.max(0, Math.min(value.length, Math.trunc(opts.maxArrayLength)));
  const entries = [];
  let i = 0;
  while (i < max) {
    if (!hasOwn(value, i)) {
      let holes = 0;
      while (i < max && !hasOwn(value, i)) {
        holes++;
        i++;
      }
      entries.push(
        `<${holes} empty item${holes === 1 ? "" : "s"}>`,
      );
      continue;
    }
    entries.push(renderValue(value[i], ctx, depth - 1, indent + 2));
    i++;
  }
  let tail;
  if (value.length > max) {
    const more = value.length - max;
    tail = `... ${more} more item${more === 1 ? "" : "s"}`;
  }
  let output = entries;
  let grouped = false;
  const compact = ctx.options.compact;
  if (
    compact !== true &&
    typeof compact === "number" &&
    compact >= 1 &&
    entries.length > 6
  ) {
    const next = groupArrayElements(entries, ctx, indent, value);
    grouped = next !== entries;
    output = next;
  }
  // Extra enumerable non-index properties are rendered inside the brackets,
  // matching Node (`[ 1, x: 2 ]`).
  const keyList = objectKeys(value, ctx, false);
  const extras = [];
  for (const key of keyList) {
    if (key.type === "index") continue;
    extras.push(formatProperty(key, value, ctx, depth, indent));
  }
  if (tail !== undefined || extras.length > 0) {
    output = output.slice();
    if (tail !== undefined) output.push(tail);
    for (const extra of extras) output.push(extra);
    grouped = false;
  }
  return container("[", "]", output, ctx, indent, value, depth, grouped);
}

// Node groups arrays with more than six entries into aligned rows.  This is
// the same column calculation Node uses (see internal/util/inspect.js).
function groupArrayElements(entries, ctx, indent, value) {
  const outputLength = entries.length;
  const separatorSpace = 2;
  const dataLen = new Array(outputLength);
  let totalLength = 0;
  let maxLength = 0;
  for (let i = 0; i < outputLength; i++) {
    const len = entries[i].length;
    dataLen[i] = len;
    totalLength += len + separatorSpace;
    if (maxLength < len) maxLength = len;
  }
  const actualMax = maxLength + separatorSpace;
  const breakLength =
    ctx.options.breakLength === Infinity ? Infinity : Number(ctx.options.breakLength);
  if (
    !(
      actualMax * 3 + indent < breakLength &&
      (totalLength / actualMax > 5 || maxLength <= 6)
    )
  ) {
    return entries;
  }
  const approxCharHeights = 2.5;
  const averageBias = Math.sqrt(actualMax - totalLength / outputLength);
  const biasedMax = Math.max(actualMax - 3 - averageBias, 1);
  const compact =
    typeof ctx.options.compact === "number" ? ctx.options.compact : 1;
  const columns = Math.min(
    Math.round(
      Math.sqrt(approxCharHeights * biasedMax * outputLength) / biasedMax,
    ),
    Math.floor((breakLength - indent) / actualMax),
    compact * 4,
    15,
  );
  if (columns <= 1) return entries;
  const maxLineLength = [];
  for (let i = 0; i < columns; i++) {
    let lineMaxLength = 0;
    for (let j = i; j < outputLength; j += columns) {
      if (dataLen[j] > lineMaxLength) lineMaxLength = dataLen[j];
    }
    maxLineLength[i] = lineMaxLength + separatorSpace;
  }
  let numeric = true;
  if (value !== undefined) {
    for (let i = 0; i < outputLength; i++) {
      if (typeof value[i] !== "number" && typeof value[i] !== "bigint") {
        numeric = false;
        break;
      }
    }
  }
  const padStart = (str, len) => String(str).padStart(len, " ");
  const padEnd = (str, len) => String(str).padEnd(len, " ");
  const order = numeric ? padStart : padEnd;
  const out = [];
  for (let i = 0; i < outputLength; i += columns) {
    const max = Math.min(i + columns, outputLength);
    let str = "";
    let j = i;
    for (; j < max - 1; j++) {
      str += order(entries[j] + ", ", maxLineLength[j - i]);
    }
    if (numeric) {
      str += padStart(entries[j], maxLineLength[j - i] - separatorSpace);
    } else {
      str += entries[j];
    }
    out.push(str);
  }
  return out;
}

function renderFunction(value, ctx, depth, indent) {
  const source = Function.prototype.toString.call(value);
  const name = typeof value.name === "string" ? value.name : "";
  let head;
  if (/^\s*class\b/.test(source)) {
    head = `[class ${name || "(anonymous)"}]`;
  } else {
    const tag = tagOf(value);
    let kind = "Function";
    if (tag === "AsyncGeneratorFunction") kind = "AsyncGeneratorFunction";
    else if (tag === "GeneratorFunction") kind = "GeneratorFunction";
    else if (tag === "AsyncFunction") kind = "AsyncFunction";
    head = name
      ? `[${kind}: ${name}]`
      : `[${kind} (anonymous)]`;
  }
  if (depth < 0) return head;
  const extra = formatExtraProperties(
    value,
    ctx,
    depth,
    indent,
    undefined,
    false,
    head.length,
  );
  return head + extra;
}

function renderBoxed(value, ctx, depth, indent) {
  let body;
  switch (tagOf(value)) {
    case "Number":
      body = formatNumber(value.valueOf(), ctx.options);
      break;
    case "String":
      body = formatString(value.valueOf(), ctx.options.maxStringLength);
      break;
    case "Boolean":
      body = value.valueOf() ? "true" : "false";
      break;
    case "Symbol":
      body = formatSymbol(value.valueOf());
      break;
    case "BigInt":
      body = formatBigInt(value.valueOf(), ctx.options);
      break;
    default:
      body = "undefined";
      break;
  }
  const head = `[${tagOf(value)}: ${body}]`;
  return (
    head +
    formatExtraProperties(value, ctx, depth, indent, undefined, false, head.length)
  );
}

function renderMap(value, ctx, depth, indent) {
  const opts = ctx.options;
  const size = value.size;
  const max =
    opts.maxArrayLength === null || opts.maxArrayLength === Infinity
      ? size
      : Math.max(0, Math.min(size, Math.trunc(opts.maxArrayLength)));
  let pairs = [];
  for (const [key, val] of value) {
    pairs.push({
      key,
      value: val,
      keyText: renderValue(key, ctx, depth - 1, indent + 2),
      valueText: renderValue(val, ctx, depth - 1, indent + 2),
    });
  }
  if (opts.sorted) {
    pairs = pairs.sort((a, b) => (a.keyText < b.keyText ? -1 : a.keyText > b.keyText ? 1 : 0));
  }
  const entries = [];
  for (let i = 0; i < max && i < pairs.length; i++) {
    entries.push(pairs[i].keyText + " => " + pairs[i].valueText);
  }
  if (size > max) {
    const more = size - max;
    entries.push(`... ${more} more item${more === 1 ? "" : "s"}`);
  }
  for (const key of objectKeys(value, ctx, false)) {
    entries.push(formatProperty(key, value, ctx, depth, indent));
  }
  return (
    `Map(${size}) ` +
    container("{", "}", entries, ctx, indent, value, depth, false, `Map(${size})`.length)
  );
}

function renderSet(value, ctx, depth, indent) {
  const opts = ctx.options;
  const size = value.size;
  const max =
    opts.maxArrayLength === null || opts.maxArrayLength === Infinity
      ? size
      : Math.max(0, Math.min(size, Math.trunc(opts.maxArrayLength)));
  let rendered = [];
  for (const val of value) {
    rendered.push(renderValue(val, ctx, depth - 1, indent + 2));
  }
  if (opts.sorted) rendered = rendered.sort();
  const entries = rendered.slice(0, max);
  if (size > max) {
    const more = size - max;
    entries.push(`... ${more} more item${more === 1 ? "" : "s"}`);
  }
  for (const key of objectKeys(value, ctx, false)) {
    entries.push(formatProperty(key, value, ctx, depth, indent));
  }
  return (
    `Set(${size}) ` +
    container("{", "}", entries, ctx, indent, value, depth, false, `Set(${size})`.length)
  );
}

function renderDate(value, ctx, depth, indent) {
  let body;
  try {
    const time = value.getTime();
    body = Number.isNaN(time) ? "Invalid Date" : value.toISOString();
  } catch {
    body = "Invalid Date";
  }
  return (
    body +
    formatExtraProperties(value, ctx, depth, indent, undefined, false, body.length)
  );
}

function renderRegExp(value, ctx, depth, indent) {
  const head = `/${value.source}/${value.flags}`;
  return (
    head +
    formatExtraProperties(value, ctx, depth, indent, undefined, false, head.length)
  );
}

function renderError(value, ctx, depth, indent) {
  const name = safeName(value);
  let message;
  try {
    message = value.message;
  } catch {
    message = undefined;
  }
  let body;
  let stack;
  try {
    stack = value.stack;
  } catch {
    stack = undefined;
  }
  if (typeof stack === "string" && stack.length > 0) {
    const trimmed = stack.replace(/\n+$/, "");
    const header = typeof message === "string" && message.length > 0 ? `${name}: ${message}` : name;
    // V8 stacks start with the header; QuickJS stacks are frames only. Always render the header
    // first so `inspect(error).split("\n")[0]` is the error, as in Node.
    body =
      trimmed === header || trimmed.startsWith(`${header}\n`)
        ? trimmed
        : `${header}\n${trimmed}`;
  } else if (typeof message === "string" && message.length > 0) {
    body = `[${name}: ${message}]`;
  } else {
    body = `[${name}]`;
  }
  return body + formatErrorProperties(value, ctx, depth, indent);
}

function formatErrorProperties(value, ctx, depth, indent) {
  const entries = [];
  if (hasOwn(value, "cause")) {
    entries.push(
      "[cause]: " + renderValue(value.cause, ctx, depth - 1, indent + 2),
    );
  }
  if (hasOwn(value, "errors")) {
    entries.push(
      "[errors]: " + renderValue(value.errors, ctx, depth - 1, indent + 2),
    );
  }
  for (const key of objectKeys(value, ctx, false)) {
    if (key.type === "index") continue;
    if (key.type === "string" && (key.key === "name" || key.key === "message")) {
      continue;
    }
    entries.push(formatProperty(key, value, ctx, depth, indent));
  }
  if (entries.length === 0) return "";
  const useCtx = { ...ctx, options: { ...ctx.options, compact: false } };
  return (
    " " +
    container("{", "}", entries, useCtx, indent, value, depth, false, 0)
  );
}

function renderArrayBuffer(value, ctx, depth, indent) {
  const opts = ctx.options;
  const bytes = new Uint8Array(value);
  const max =
    opts.maxArrayLength === null || opts.maxArrayLength === Infinity
      ? bytes.length
      : Math.max(0, Math.min(bytes.length, Math.trunc(opts.maxArrayLength)));
  let parts = [];
  for (let i = 0; i < max; i++) {
    parts.push(hex(bytes[i], 2, false));
  }
  let contents;
  if (max < bytes.length) {
    const more = bytes.length - max;
    contents = parts.join(" ") + ` ... ${more} more byte${more === 1 ? "" : "s"}`;
  } else {
    contents = parts.join(" ");
  }
  const head = isSharedArrayBufferValue(value)
    ? "SharedArrayBuffer"
    : "ArrayBuffer";
  const body = container(
    "{",
    "}",
    [`[Uint8Contents]: <${contents}>`, `[byteLength]: ${value.byteLength}`],
    ctx,
    indent,
    value,
    depth,
    false,
    head.length,
  );
  return `${head} ${body}` +
    formatExtraProperties(value, ctx, depth, indent, ["byteLength"]);
}

function renderDataView(value, ctx, depth, indent) {
  let entries = [
    `[byteLength]: ${value.byteLength}`,
    `[byteOffset]: ${value.byteOffset}`,
    `[buffer]: ${renderValue(value.buffer, ctx, depth - 1, indent + 2)}`,
  ];
  if (ctx.options.sorted) {
    entries = entries.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
  return (
    "DataView " +
    container("{", "}", entries, ctx, indent, value, depth, false, "DataView".length)
  );
}

function renderTypedArray(value, ctx, depth, indent) {
  const opts = ctx.options;
  const tag = tagOf(value);
  const length = value.length;
  if (tag === "Buffer" || constructorName(value) === "Buffer") {
    let parts = [];
    for (let i = 0; i < value.length; i++) {
      parts.push(hex(value[i], 2, false));
    }
    return `<Buffer ${parts.join(" ")}>`;
  }
  const max =
    opts.maxArrayLength === null || opts.maxArrayLength === Infinity
      ? length
      : Math.max(0, Math.min(length, Math.trunc(opts.maxArrayLength)));
  const elements = [];
  for (let i = 0; i < max; i++) {
    const item = value[i];
    elements.push(
      typeof item === "bigint"
        ? formatBigInt(item, ctx.options)
        : formatNumber(item, ctx.options),
    );
  }
  let output = elements;
  let grouped = false;
  const compact = ctx.options.compact;
  if (
    compact !== true &&
    typeof compact === "number" &&
    compact >= 1 &&
    elements.length > 6
  ) {
    const next = groupArrayElements(elements, ctx, indent, value);
    grouped = next !== elements;
    output = next;
  }
  const tail =
    length > max
      ? `... ${length - max} more item${length - max === 1 ? "" : "s"}`
      : undefined;
  const extras = [];
  for (const key of objectKeys(value, ctx, false)) {
    if (key.type === "index") continue;
    extras.push(formatProperty(key, value, ctx, depth, indent));
  }
  if (tail !== undefined || extras.length > 0) {
    output = output.slice();
    if (tail !== undefined) output.push(tail);
    for (const extra of extras) output.push(extra);
    grouped = false;
  }
  return (
    `${tag}(${length}) ` +
    container(
      "[",
      "]",
      output,
      ctx,
      indent,
      value,
      depth,
      grouped,
      `${tag}(${length})`.length,
    )
  );
}

function renderPromise(value, ctx, depth, indent) {
  // QuickJS does not expose a promise's internal state to JS, so a promise is
  // always rendered as pending.  This is a documented divergence.
  return (
    "Promise " +
    container("{", "}", ["<pending>"], ctx, indent, value, depth, false, "Promise".length)
  );
}

function renderWeakMap(value, ctx, depth, indent) {
  const head = isWeakSetValue(value) ? "WeakSet" : "WeakMap";
  return (
    head +
    " " +
    container("{", "}", ["<items unknown>"], ctx, indent, value, depth, false, head.length)
  );
}

function renderPlainObject(value, ctx, depth, indent) {
  const name = constructorName(value);
  let prefix = "";
  if (name === null) {
    prefix = "[Object: null prototype] ";
  } else if (name !== "Object" && name !== "Arguments") {
    prefix = name + " ";
  }
  const entries = [];
  for (const key of objectKeys(value, ctx, true)) {
    // Symbols and non-enumerable keys are already filtered/formatted by
    // objectKeys; all that is left is the value rendering.
    entries.push(formatProperty(key, value, ctx, depth, indent));
  }
  if (entries.length === 0) return prefix + "{}";
  return prefix + container("{", "}", entries, ctx, indent, value, depth, false, prefix.length);
}

function renderObjectValue(value, ctx, depth, indent) {
  if (typeof value === "function") {
    return renderFunction(value, ctx, depth, indent);
  }
  if (Array.isArray(value)) return renderArray(value, ctx, depth, indent);
  if (isErrorValue(value)) return renderError(value, ctx, depth, indent);
  if (isDateValue(value)) return renderDate(value, ctx, depth, indent);
  if (isRegExpValue(value)) return renderRegExp(value, ctx, depth, indent);
  if (isMapValue(value)) return renderMap(value, ctx, depth, indent);
  if (isSetValue(value)) return renderSet(value, ctx, depth, indent);
  if (isPromiseValue(value)) return renderPromise(value, ctx, depth, indent);
  if (isWeakMapValue(value) || isWeakSetValue(value)) {
    return renderWeakMap(value, ctx, depth, indent);
  }
  if (isArrayBufferValue(value)) return renderArrayBuffer(value, ctx, depth, indent);
  if (isDataViewValue(value)) return renderDataView(value, ctx, depth, indent);
  if (isTypedArrayValue(value)) return renderTypedArray(value, ctx, depth, indent);
  if (isBoxedPrimitiveValue(value)) return renderBoxed(value, ctx, depth, indent);
  if (isPlainishObject(value)) return renderPlainObject(value, ctx, depth, indent);
  // Fallback: any other exotic object (WeakRef, URL, custom class...) prints
  // with its constructor prefix and own enumerable properties.
  return renderPlainObject(value, ctx, depth, indent);
}

// Keys are collected in Node's order: enumerable string keys (integer keys
// first, as Object.keys returns them), then enumerable symbols.  showHidden
// appends non-enumerable properties.
function objectKeys(value, ctx, includeKind) {
  const opts = ctx.options;
  const out = [];
  const names = Object.getOwnPropertyNames(value);
  const stringKeys = [];
  for (const name of names) {
    if (name === "length" && Array.isArray(value)) continue;
    const enumerable = isEnumerable(value, name);
    if (!enumerable && !opts.showHidden) continue;
    stringKeys.push({
      type: isArrayIndex(name) ? "index" : "string",
      key: name,
      enumerable,
    });
  }
  const symbols = Object.getOwnPropertySymbols(value);
  const symbolEntries = [];
  for (const sym of symbols) {
    const enumerable = isEnumerable(value, sym);
    if (!enumerable && !opts.showHidden) continue;
    symbolEntries.push({ type: "symbol", key: sym, enumerable });
  }
  if (opts.sorted) {
    // Node sorts by the rendered key text (quoted keys sort by their leading
    // quote, symbols by "Symbol(...)", identifiers by their bare name).
    const all = stringKeys.concat(symbolEntries);
    all.sort((a, b) => {
      const ak = formatKey(a, true, ctx);
      const bk = formatKey(b, true, ctx);
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    });
    return all;
  }
  for (const entry of stringKeys) out.push(entry);
  for (const entry of symbolEntries) out.push(entry);
  return out;
}

function isArrayIndex(key) {
  return /^(0|[1-9]\d*)$/.test(key) && Number(key) < 4294967295;
}

function formatKey(key, enumerable, ctx) {
  if (key.type === "symbol") {
    const text = formatSymbol(key.key);
    return enumerable ? text : `[${text}]`;
  }
  const text = isIdentifierKey(key.key)
    ? key.key
    : formatString(key.key, ctx.options.maxStringLength);
  return enumerable ? text : `[${text}]`;
}

function formatProperty(key, value, ctx, depth, indent) {
  const keyText = formatKey(key, key.enumerable, ctx);
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key.key);
  } catch {
    descriptor = undefined;
  }
  let text;
  if (descriptor && (descriptor.get || descriptor.set)) {
    const hasGetter = typeof descriptor.get === "function";
    const hasSetter = typeof descriptor.set === "function";
    let label;
    if (hasGetter && hasSetter) label = "Getter/Setter";
    else if (hasGetter) label = "Getter";
    else label = "Setter";
    if (hasGetter && ctx.options.getters) {
      let got;
      try {
        got = descriptor.get.call(value);
      } catch {
        text = `[${label}]`;
        return keyText + ": " + text;
      }
      text = `[${label}: ${renderValue(got, ctx, depth - 1, indent + 2)}]`;
    } else {
      text = `[${label}]`;
    }
  } else {
    let raw;
    try {
      raw = value[key.key];
    } catch {
      raw = undefined;
    }
    text = renderValue(raw, ctx, depth - 1, indent + 2);
  }
  return keyText + ": " + text;
}

function hasCustomInspectMethod(value, ctx) {
  if (!ctx.options.customInspect || !isObjectLike(value)) return false;
  try {
    if (typeof value[customInspectSymbol] === "function") return true;
    if (typeof value.inspect === "function" && value.inspect !== inspect) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

// Deepest nesting level that will actually be rendered below `value`, used to
// reproduce Node's `compact` collapse rule: the innermost `compact` levels are
// allowed to stay on one line.
function nodeDepth(value, depth, seen, ctx) {
  if (depth < 0) return 0;
  if (!isObjectLike(value)) return 0;
  if (hasCustomInspectMethod(value, ctx)) {
    return 0;
  }
  // Leaf-like values are rendered without recursing, so they do not count
  // towards Node's `currentDepth` collapse calculation.
  if (
    isDateValue(value) ||
    isRegExpValue(value) ||
    isBoxedPrimitiveValue(value) ||
    isTypedArrayValue(value) ||
    isDataViewValue(value) ||
    isArrayBufferValue(value) ||
    isPromiseValue(value) ||
    isWeakMapValue(value) ||
    isWeakSetValue(value) ||
    isErrorValue(value)
  ) {
    return 0;
  }
  if (seen.has(value)) return 0;
  seen.add(value);
  let childDepth = 0;
  const consider = (child) => {
    if (!isObjectLike(child)) return;
    const d = nodeDepth(child, depth - 1, seen, ctx);
    if (d > childDepth) childDepth = d;
  };
  try {
    if (Array.isArray(value)) {
      const max =
        value.length > 100 ? 100 : value.length;
      for (let i = 0; i < max; i++) consider(value[i]);
    } else if (isMapValue(value)) {
      for (const [key, val] of value) {
        consider(key);
        consider(val);
      }
    } else if (isSetValue(value)) {
      for (const item of value) consider(item);
    } else if (isTypedArrayValue(value) || isDataViewValue(value)) {
      // Numeric elements never nest.
    } else if (isArrayBufferValue(value) || isDateValue(value)) {
      // Only extra own properties can nest.
      for (const key of Object.keys(value)) consider(value[key]);
    } else if (isRegExpValue(value) || isPromiseValue(value) ||
               isWeakMapValue(value) || isWeakSetValue(value)) {
      // Leaves for depth purposes.
    } else if (isBoxedPrimitiveValue(value)) {
      // Leaves.
    } else {
      for (const key of Object.keys(value)) consider(value[key]);
    }
  } catch {
    // Ignore exotic objects.
  }
  seen.delete(value);
  return 1 + childDepth;
}

function container(
  open,
  close,
  entries,
  ctx,
  indent,
  value,
  depth,
  forceBreak,
  baseLength,
) {
  if (entries.length === 0) return open + close;
  const flat = open + " " + entries.join(", ") + " " + close;
  const opts = ctx.options;
  const compact = opts.compact;
  const breakLength =
    opts.breakLength === Infinity ? Infinity : Number(opts.breakLength);
  let fits;
  if (breakLength === Infinity) {
    fits = flat.indexOf("\n") === -1;
  } else if (compact === true) {
    // Node's compact:true path checks only the entries themselves.
    let totalLength = entries.length;
    for (let i = 0; i < entries.length; i++) totalLength += entries[i].length;
    fits = totalLength <= breakLength && flat.indexOf("\n") === -1;
  } else {
    // Mirrors Node's isBelowBreakLength(): the check is deliberately
    // conservative and includes per-entry separators plus a constant.
    let totalLength =
      entries.length + indent + open.length + (baseLength || 0) + 10;
    totalLength += entries.length;
    for (let i = 0; i < entries.length; i++) {
      totalLength += entries[i].length;
      if (totalLength > breakLength) break;
    }
    fits = totalLength <= breakLength && flat.indexOf("\n") === -1;
  }
  let compactAllowed;
  if (compact === true) {
    compactAllowed = true;
  } else if (typeof compact === "number" && compact >= 1) {
    const recurseTimes = Math.max(0, ctx.path.length - 1);
    compactAllowed = ctx.currentDepth - recurseTimes < compact;
  } else {
    compactAllowed = false;
  }
  if (!forceBreak && compactAllowed && fits) return flat;
  const pad = repeat(" ", indent);
  const innerPad = repeat(" ", indent + 2);
  if (compact === true && !forceBreak) {
    // Node's compact: true overflow layout: first entry stays next to the
    // opening brace and the closing brace trails the last entry.
    return open + " " + entries.join(",\n" + innerPad) + " " + close;
  }
  return (
    open +
    "\n" +
    entries.map((entry) => innerPad + entry).join(",\n") +
    "\n" +
    pad +
    close
  );
}

function repeat(str, count) {
  let out = "";
  for (let i = 0; i < count; i++) out += str;
  return out;
}

// ---------------------------------------------------------------------------
// format() / formatWithOptions()
// ---------------------------------------------------------------------------

function formatNumberNoColor(value, options) {
  return formatNumber(value, options || {});
}

function formatBigIntNoColor(value, options) {
  return formatBigInt(value, options || {});
}

function tryStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (err) {
    const message = err && err.message ? String(err.message) : "";
    if (/circular|cyclic/i.test(message)) return "[Circular]";
    throw err;
  }
}

function hasBuiltInToString(value) {
  let fn;
  let toPrimitive;
  try {
    fn = value.toString;
    toPrimitive = value[Symbol.toPrimitive];
  } catch {
    return true;
  }
  if (typeof fn !== "function") {
    // No toString: only treat it as built-in when there is no custom
    // Symbol.toPrimitive either.
    return typeof toPrimitive !== "function";
  }
  if (hasOwn(value, "toString")) return false;
  if (typeof toPrimitive === "function" && hasOwn(value, Symbol.toPrimitive)) {
    return false;
  }
  return fn === Object.prototype.toString ||
    fn === Array.prototype.toString ||
    fn === Number.prototype.toString ||
    fn === String.prototype.toString ||
    fn === Boolean.prototype.toString ||
    fn === Date.prototype.toString ||
    fn === RegExp.prototype.toString ||
    fn === Error.prototype.toString;
}

function formatWithOptionsInternal(inspectOptions, args) {
  const options = inspectOptions === null || inspectOptions === undefined
    ? {}
    : inspectOptions;
  const first = args[0];
  let a = 0;
  let str = "";
  let join = "";

  if (typeof first === "string") {
    if (args.length === 1) return first;
    let tempStr;
    let lastPos = 0;

    for (let i = 0; i < first.length - 1; i++) {
      if (first.charCodeAt(i) === 37) {
        const nextChar = first.charCodeAt(++i);
        if (a + 1 !== args.length) {
          switch (nextChar) {
            case 115: { // s
              const tempArg = args[++a];
              if (typeof tempArg === "number") {
                tempStr = formatNumberNoColor(tempArg, options);
              } else if (typeof tempArg === "bigint") {
                tempStr = formatBigIntNoColor(tempArg, options);
              } else if (
                typeof tempArg !== "object" ||
                tempArg === null ||
                !hasBuiltInToString(tempArg)
              ) {
                tempStr = String(tempArg);
              } else {
                tempStr = inspect(tempArg, {
                  ...options,
                  compact: 3,
                  colors: false,
                  depth: 0,
                });
              }
              break;
            }
            case 106: // j
              tempStr = tryStringify(args[++a]);
              break;
            case 100: { // d
              const tempNum = args[++a];
              if (typeof tempNum === "bigint") {
                tempStr = formatBigIntNoColor(tempNum, options);
              } else if (typeof tempNum === "symbol") {
                tempStr = "NaN";
              } else {
                tempStr = formatNumberNoColor(Number(tempNum), options);
              }
              break;
            }
            case 79: // O
              tempStr = inspect(args[++a], options);
              break;
            case 111: // o
              tempStr = inspect(args[++a], {
                ...options,
                showHidden: true,
                showProxy: true,
                depth: 4,
              });
              break;
            case 105: { // i
              const tempInteger = args[++a];
              if (typeof tempInteger === "bigint") {
                tempStr = formatBigIntNoColor(tempInteger, options);
              } else if (typeof tempInteger === "symbol") {
                tempStr = "NaN";
              } else {
                tempStr = formatNumberNoColor(parseInt(tempInteger), options);
              }
              break;
            }
            case 102: { // f
              const tempFloat = args[++a];
              if (typeof tempFloat === "symbol") {
                tempStr = "NaN";
              } else {
                tempStr = formatNumberNoColor(parseFloat(tempFloat), options);
              }
              break;
            }
            case 99: // c
              a += 1;
              tempStr = "";
              break;
            case 37: // %
              str += first.slice(lastPos, i);
              lastPos = i + 1;
              continue;
            default:
              continue;
          }
          if (lastPos !== i - 1) {
            str += first.slice(lastPos, i - 1);
          }
          str += tempStr;
          lastPos = i + 1;
        } else if (nextChar === 37) {
          str += first.slice(lastPos, i);
          lastPos = i + 1;
        }
      }
    }
    if (lastPos !== 0) {
      a++;
      join = " ";
      if (lastPos < first.length) {
        str += first.slice(lastPos);
      }
    }
  }

  while (a < args.length) {
    const value = args[a];
    str += join;
    str += typeof value !== "string" ? inspect(value, options) : value;
    join = " ";
    a++;
  }
  return str;
}

function format(...args) {
  return formatWithOptionsInternal(undefined, args);
}

function formatWithOptions(inspectOptions, ...args) {
  return formatWithOptionsInternal(inspectOptions, args);
}

// ---------------------------------------------------------------------------
// Deep equality
// ---------------------------------------------------------------------------

const wellKnownConstructors = new Set();
for (const ctor of [
  typeof Array !== "undefined" ? Array : undefined,
  typeof ArrayBuffer !== "undefined" ? ArrayBuffer : undefined,
  typeof BigInt !== "undefined" ? BigInt : undefined,
  typeof Boolean !== "undefined" ? Boolean : undefined,
  typeof DataView !== "undefined" ? DataView : undefined,
  typeof Date !== "undefined" ? Date : undefined,
  typeof Error !== "undefined" ? Error : undefined,
  typeof Function !== "undefined" ? Function : undefined,
  typeof Map !== "undefined" ? Map : undefined,
  typeof Number !== "undefined" ? Number : undefined,
  typeof Object !== "undefined" ? Object : undefined,
  typeof Promise !== "undefined" ? Promise : undefined,
  typeof RegExp !== "undefined" ? RegExp : undefined,
  typeof Set !== "undefined" ? Set : undefined,
  typeof String !== "undefined" ? String : undefined,
  typeof Symbol !== "undefined" ? Symbol : undefined,
  typeof WeakMap !== "undefined" ? WeakMap : undefined,
  typeof WeakSet !== "undefined" ? WeakSet : undefined,
  typeof Uint8Array !== "undefined" ? Uint8Array : undefined,
  typeof Uint8ClampedArray !== "undefined" ? Uint8ClampedArray : undefined,
  typeof Uint16Array !== "undefined" ? Uint16Array : undefined,
  typeof Uint32Array !== "undefined" ? Uint32Array : undefined,
  typeof Int8Array !== "undefined" ? Int8Array : undefined,
  typeof Int16Array !== "undefined" ? Int16Array : undefined,
  typeof Int32Array !== "undefined" ? Int32Array : undefined,
  typeof Float32Array !== "undefined" ? Float32Array : undefined,
  typeof Float64Array !== "undefined" ? Float64Array : undefined,
  typeof BigInt64Array !== "undefined" ? BigInt64Array : undefined,
  typeof BigUint64Array !== "undefined" ? BigUint64Array : undefined,
]) {
  if (typeof ctor === "function") wellKnownConstructors.add(ctor);
}
if (typeof Buffer === "function") wellKnownConstructors.add(Buffer);

function constructorEquality(a, b) {
  let ca;
  let cb;
  try {
    ca = a.constructor;
  } catch {
    ca = undefined;
  }
  try {
    cb = b.constructor;
  } catch {
    cb = undefined;
  }
  if (wellKnownConstructors.has(ca) || (ca !== undefined && !hasOwn(a, "constructor"))) {
    return ca === cb;
  }
  return Object.getPrototypeOf(a) === Object.getPrototypeOf(b);
}

function ownEnumerableSymbols(value) {
  const out = [];
  let symbols;
  try {
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    return out;
  }
  for (const symbol of symbols) {
    if (isEnumerable(value, symbol)) out.push(symbol);
  }
  return out;
}

function byteView(value) {
  if (isDataViewValue(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function bytesEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const av = byteView(a);
  const bv = byteView(b);
  for (let i = 0; i < av.length; i++) {
    if (av[i] !== bv[i]) return false;
  }
  return true;
}

function isDeepEqualInternal(a, b) {
  return deepEqual(a, b, false, []);
}

function isDeepStrictEqual(a, b) {
  return deepEqual(a, b, true, []);
}

function memoHas(memo, a, b) {
  for (let i = 0; i < memo.length; i += 2) {
    if (memo[i] === a && memo[i + 1] === b) return true;
  }
  return false;
}

function deepEqual(a, b, strict, memo) {
  if (a === b) {
    if (!strict) return true;
    return a !== 0 || Object.is(a, b);
  }
  if (strict) {
    if (typeof a === "number") {
      return typeof b === "number" && a !== a && b !== b;
    }
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
      return false;
    }
  } else {
    const ta = typeof a;
    const tb = typeof b;
    if ((a === null || ta !== "object") && (b === null || tb !== "object")) {
      // Loose primitive comparison, with NaN equal to NaN.
      return a == b || (a !== a && b !== b);
    }
    if (a === null || ta !== "object" || b === null || tb !== "object") {
      return false;
    }
  }

  if (memoHas(memo, a, b)) return true;
  memo.push(a, b);
  return deepEqualObjects(a, b, strict, memo);
}

function deepEqualObjects(a, b, strict, memo) {
  if (strict) {
    if (!constructorEquality(a, b)) return false;
    if (a[Symbol.toStringTag] !== b[Symbol.toStringTag]) return false;
  }

  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const hasA = hasOwn(a, i);
      const hasB = hasOwn(b, i);
      if (hasA !== hasB) return false;
      if (hasA && !deepEqual(a[i], b[i], strict, memo)) return false;
    }
    return compareOwnProperties(a, b, strict, memo, true);
  }

  if (isMapValue(a)) {
    if (!isMapValue(b) || a.size !== b.size) return false;
    if (!mapEquiv(a, b, strict, memo)) return false;
    return compareOwnProperties(a, b, strict, memo, false);
  }

  if (isSetValue(a)) {
    if (!isSetValue(b) || a.size !== b.size) return false;
    if (!setEquiv(a, b, strict, memo)) return false;
    return compareOwnProperties(a, b, strict, memo, false);
  }

  if (isTypedArrayValue(a) || isDataViewValue(a)) {
    if (!(isTypedArrayValue(b) || isDataViewValue(b))) return false;
    if (tagOf(a) !== tagOf(b)) return false;
    if (!bytesEqual(a, b)) return false;
    return compareOwnProperties(a, b, strict, memo, true);
  }

  if (isDateValue(a)) {
    if (!isDateValue(b)) return false;
    const ta = a.getTime();
    const tb = b.getTime();
    if (ta !== tb && !(Number.isNaN(ta) && Number.isNaN(tb))) return false;
    return compareOwnProperties(a, b, strict, memo, false);
  }

  if (isRegExpValue(a)) {
    if (!isRegExpValue(b)) return false;
    if (a.source !== b.source || a.flags !== b.flags) return false;
    if (a.lastIndex !== b.lastIndex) return false;
    return compareOwnProperties(a, b, strict, memo, false);
  }

  if (isArrayBufferValue(a)) {
    if (!isArrayBufferValue(b)) return false;
    if (isSharedArrayBufferValue(a) !== isSharedArrayBufferValue(b)) return false;
    if (!bytesEqual(a, b)) return false;
    return compareOwnProperties(a, b, strict, memo, false);
  }

  if (isErrorValue(a)) {
    if (!isErrorValue(b)) return false;
    if (!deepEqual(a.name, b.name, strict, memo)) return false;
    if (!deepEqual(a.message, b.message, strict, memo)) return false;
    const hasCauseA = hasOwn(a, "cause");
    const hasCauseB = hasOwn(b, "cause");
    if (hasCauseA !== hasCauseB) return false;
    if (hasCauseA && !deepEqual(a.cause, b.cause, strict, memo)) return false;
    const hasErrorsA = hasOwn(a, "errors");
    const hasErrorsB = hasOwn(b, "errors");
    if (hasErrorsA !== hasErrorsB) return false;
    if (hasErrorsA && !deepEqual(a.errors, b.errors, strict, memo)) return false;
    return compareOwnProperties(a, b, strict, memo, false);
  }

  if (isBoxedPrimitiveValue(a)) {
    if (!isBoxedPrimitiveValue(b) || tagOf(a) !== tagOf(b)) return false;
    const va = a.valueOf();
    const vb = b.valueOf();
    if (typeof va === "number") {
      if (!Object.is(va, vb)) return false;
    } else if (va !== vb) {
      return false;
    }
    return compareOwnProperties(a, b, strict, memo, false);
  }

  if (isPromiseValue(a) || isWeakMapValue(a) || isWeakSetValue(a)) {
    return false;
  }
  if (isPromiseValue(b) || isWeakMapValue(b) || isWeakSetValue(b)) {
    return false;
  }

  if (tagOf(a) === "URL") {
    if (tagOf(b) !== "URL" || a.href !== b.href) return false;
    return compareOwnProperties(a, b, strict, memo, false);
  }

  // Objects with a non-Object tag but the same tag (custom toStringTag, etc.)
  // still compare by their own enumerable properties.
  return compareOwnProperties(a, b, strict, memo, false);
}

function compareOwnProperties(a, b, strict, memo, skipIndices) {
  const keysA = ownComparableKeys(a, strict, skipIndices);
  const keysB = ownComparableKeys(b, strict, skipIndices);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!isEnumerable(b, key)) return false;
    if (!deepEqual(a[key], b[key], strict, memo)) return false;
  }
  return true;
}

function ownComparableKeys(value, strict, skipIndices) {
  const out = [];
  for (const key of Object.keys(value)) {
    if (skipIndices && isArrayIndex(key)) continue;
    out.push(key);
  }
  if (strict) {
    for (const symbol of ownEnumerableSymbols(value)) out.push(symbol);
  }
  return out;
}

function setEquiv(a, b, strict, memo) {
  const remaining = Array.from(b);
  const used = new Array(remaining.length).fill(false);
  for (const valueA of a) {
    let matched = false;
    for (let i = 0; i < remaining.length; i++) {
      if (used[i]) continue;
      const mark = memo.length;
      if (deepEqual(valueA, remaining[i], strict, memo)) {
        used[i] = true;
        matched = true;
        break;
      }
      memo.length = mark;
    }
    if (!matched) return false;
  }
  return true;
}

function mapEquiv(a, b, strict, memo) {
  const remaining = Array.from(b.entries());
  const used = new Array(remaining.length).fill(false);
  outer: for (const [keyA, valueA] of a) {
    for (let i = 0; i < remaining.length; i++) {
      if (used[i]) continue;
      const mark = memo.length;
      if (
        deepEqual(keyA, remaining[i][0], strict, memo) &&
        deepEqual(valueA, remaining[i][1], strict, memo)
      ) {
        used[i] = true;
        continue outer;
      }
      memo.length = mark;
    }
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// util.inherits / promisify / callbackify / deprecate / debuglog
// ---------------------------------------------------------------------------

function inherits(ctor, superCtor) {
  if (typeof ctor !== "function") {
    throw invalidArgType("ctor", "of type function", ctor);
  }
  if (typeof superCtor !== "function") {
    throw invalidArgType("superCtor", "of type function", superCtor);
  }
  if (
    typeof superCtor.prototype === "undefined" ||
    superCtor.prototype === null
  ) {
    const error = new TypeError(
      'The "superCtor.prototype" property must be of type object',
    );
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
  ctor.super_ = superCtor;
}

function promisify(original) {
  if (typeof original !== "function") {
    throw invalidArgType("original", "of type function", original);
  }

  const custom = original[customPromisifySymbol];
  if (custom) {
    if (typeof custom !== "function") {
      throw invalidArgType("util.promisify.custom", "of type function", custom);
    }
    try {
      Object.defineProperty(custom, customPromisifySymbol, {
        value: custom,
        enumerable: false,
        writable: false,
        configurable: true,
      });
    } catch {
      // Some host functions are not extensible; the custom function is still
      // usable without the self-reference.
    }
    return custom;
  }

  const argumentNames = original[customPromisifyArgsSymbol];

  function fn(...args) {
    return new Promise((resolve, reject) => {
      args.push((err, ...values) => {
        if (err) return reject(err);
        if (argumentNames !== undefined && values.length > 1) {
          const obj = {};
          for (let i = 0; i < argumentNames.length; i++) {
            obj[argumentNames[i]] = values[i];
          }
          resolve(obj);
        } else {
          // Node 26 resolves only the first success argument here.  fs.read's
          // { bytesRead, buffer } shape comes from an internal symbol, not
          // from user-visible promisify behaviour.
          resolve(values[0]);
        }
      });
      original.apply(this, args);
    });
  }

  Object.setPrototypeOf(fn, Object.getPrototypeOf(original));
  try {
    Object.defineProperty(fn, customPromisifySymbol, {
      value: fn,
      enumerable: false,
      writable: false,
      configurable: true,
    });
  } catch {
    // Ignore non-extensible originals.
  }
  try {
    // Node copies every descriptor, including name, length and prototype.
    Object.defineProperties(fn, Object.getOwnPropertyDescriptors(original));
  } catch {
    try {
      const descriptors = Object.getOwnPropertyDescriptors(original);
      delete descriptors.arguments;
      delete descriptors.caller;
      Object.defineProperties(fn, descriptors);
    } catch {
      // Best effort, matching Node's intent of preserving exported properties.
    }
  }
  return fn;
}

promisify.custom = customPromisifySymbol;

function callbackify(original) {
  if (typeof original !== "function") {
    throw invalidArgType("original", "of type function", original);
  }
  function callbackified(...args) {
    const maybeCb = args.pop();
    if (typeof maybeCb !== "function") {
      throw invalidArgType("last argument", "of type function", maybeCb);
    }
    const cb = maybeCb.bind(this);
    const ret = original.apply(this, args);
    ret.then(
      (value) => deferToTick(cb, null, value),
      (reason) => deferToTick(callbackifyOnRejected, reason, cb),
    );
  }
  try {
    Object.defineProperty(callbackified, "length", {
      value: original.length + 1,
      writable: false,
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(callbackified, "name", {
      value: (original.name || "") + "Callbackified",
      writable: false,
      enumerable: false,
      configurable: true,
    });
  } catch {
    // ignore
  }
  return callbackified;
}

function deferToTick(fn, ...args) {
  if (typeof process !== "undefined" && typeof process.nextTick === "function") {
    process.nextTick(fn, ...args);
    return;
  }
  Promise.resolve().then(() => fn(...args));
}

function callbackifyOnRejected(reason, cb) {
  if (
    !reason ||
    (typeof reason !== "object" && typeof reason !== "function") ||
    isErrorValue(reason)
  ) {
    return cb(reason);
  }
  const newReason = new Error(
    `Promise rejected with a non-error rejection reason: ${inspect(reason)}`,
    { cause: reason },
  );
  newReason.code = "ERR_INVALID_RETURN_VALUE";
  return cb(newReason);
}

function writeStderr(text) {
  if (
    typeof process !== "undefined" &&
    process &&
    process.stderr &&
    typeof process.stderr.write === "function"
  ) {
    process.stderr.write(text + "\n");
    return;
  }
  if (
    typeof globalThis !== "undefined" &&
    globalThis.__ln_host &&
    typeof globalThis.__ln_host.write === "function"
  ) {
    globalThis.__ln_host.write(text, true);
    return;
  }
  if (typeof console !== "undefined" && typeof console.error === "function") {
    console.error(text);
  }
}

function deprecate(fn, msg, code) {
  if (typeof fn !== "function") {
    throw invalidArgType("fn", "of type function", fn);
  }
  if (typeof msg !== "string") {
    throw invalidArgType("msg", "of type string", msg);
  }
  let warned = false;
  function deprecated(...args) {
    if (!warned) {
      warned = true;
      emitDeprecationWarning(msg, code);
    }
    return fn.apply(this, args);
  }
  try {
    const descriptors = Object.getOwnPropertyDescriptors(fn);
    delete descriptors.length;
    delete descriptors.name;
    delete descriptors.prototype;
    Object.defineProperties(deprecated, descriptors);
  } catch {
    // ignore
  }
  return deprecated;
}

function emitDeprecationWarning(msg, code) {
  if (typeof process !== "undefined" && typeof process.emitWarning === "function") {
    try {
      if (typeof code === "string") {
        process.emitWarning(msg, "DeprecationWarning", code);
      } else {
        process.emitWarning(msg, "DeprecationWarning");
      }
      return;
    } catch {
      // Fall through to stderr.
    }
  }
  const suffix = typeof code === "string" ? ` [${code}]` : "";
  writeStderr(`DeprecationWarning${suffix}: ${msg}`);
}

function getEnv(name) {
  if (typeof process !== "undefined" && process && process.env) {
    return process.env[name];
  }
  if (
    typeof globalThis !== "undefined" &&
    globalThis.__ln_host &&
    typeof globalThis.__ln_host.env === "function"
  ) {
    try {
      return globalThis.__ln_host.env()[name];
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function debuglog(section, callback) {
  const enabled = (() => {
    const debug = getEnv("NODE_DEBUG");
    if (!debug) return false;
    const upper = String(section).toUpperCase();
    return String(debug)
      .toUpperCase()
      .split(/[\s,]+/)
      .some((entry) => entry === upper || entry === "*");
  })();

  function debug(...args) {
    if (!enabled) return;
    let message;
    try {
      message = format(...args);
    } catch {
      message = args.map((arg) => String(arg)).join(" ");
    }
    const pid =
      typeof process !== "undefined" && typeof process.pid === "number"
        ? process.pid
        : 0;
    writeStderr(`${String(section).toUpperCase()} ${pid}: ${message}`);
  }
  debug.enabled = enabled;
  if (typeof callback === "function") {
    callback(debug);
  }
  return debug;
}

// ---------------------------------------------------------------------------
// System error names
// ---------------------------------------------------------------------------

const darwinErrnoNames = {
  1: "EPERM", 2: "ENOENT", 3: "ESRCH", 4: "EINTR", 5: "EIO", 6: "ENXIO",
  7: "E2BIG", 8: "ENOEXEC", 9: "EBADF", 12: "ENOMEM", 13: "EACCES",
  14: "EFAULT", 16: "EBUSY", 17: "EEXIST", 18: "EXDEV", 19: "ENODEV",
  20: "ENOTDIR", 21: "EISDIR", 22: "EINVAL", 23: "ENFILE", 24: "EMFILE",
  25: "ENOTTY", 26: "ETXTBSY", 27: "EFBIG", 28: "ENOSPC", 29: "ESPIPE",
  30: "EROFS", 31: "EMLINK", 32: "EPIPE", 34: "ERANGE", 35: "EAGAIN",
  37: "EALREADY", 38: "ENOTSOCK", 39: "EDESTADDRREQ", 40: "EMSGSIZE",
  41: "EPROTOTYPE", 42: "ENOPROTOOPT", 43: "EPROTONOSUPPORT",
  44: "ESOCKTNOSUPPORT", 45: "ENOTSUP", 47: "EAFNOSUPPORT",
  48: "EADDRINUSE", 49: "EADDRNOTAVAIL", 50: "ENETDOWN",
  51: "ENETUNREACH", 53: "ECONNABORTED", 54: "ECONNRESET", 55: "ENOBUFS",
  56: "EISCONN", 57: "ENOTCONN", 58: "ESHUTDOWN", 60: "ETIMEDOUT",
  61: "ECONNREFUSED", 62: "ELOOP", 63: "ENAMETOOLONG", 64: "EHOSTDOWN",
  65: "EHOSTUNREACH", 66: "ENOTEMPTY", 78: "ENOSYS", 79: "EFTYPE",
  84: "EOVERFLOW", 89: "ECANCELED", 92: "EILSEQ", 96: "ENODATA",
  100: "EPROTO",
};

const libuvErrnoNames = {
  1: "EPERM",
  2: "ENOENT",
  3: "ESRCH",
  4: "EINTR",
  5: "EIO",
  6: "ENXIO",
  7: "E2BIG",
  8: "ENOEXEC",
  9: "EBADF",
  10: "ECHILD",
  11: "EAGAIN",
  12: "ENOMEM",
  13: "EACCES",
  14: "EFAULT",
  15: "ENOTBLK",
  16: "EBUSY",
  17: "EEXIST",
  18: "EXDEV",
  19: "ENODEV",
  20: "ENOTDIR",
  21: "EISDIR",
  22: "EINVAL",
  23: "ENFILE",
  24: "EMFILE",
  25: "ENOTTY",
  26: "ETXTBSY",
  27: "EFBIG",
  28: "ENOSPC",
  29: "ESPIPE",
  30: "EROFS",
  31: "EMLINK",
  32: "EPIPE",
  33: "EDOM",
  34: "ERANGE",
  35: "EDEADLK",
  36: "ENAMETOOLONG",
  37: "ENOLCK",
  38: "ENOSYS",
  39: "ENOTEMPTY",
  40: "ELOOP",
  42: "ENOMSG",
  43: "EIDRM",
  60: "ENOSTR",
  61: "ENODATA",
  62: "ETIME",
  63: "ENOSR",
  64: "ENONET",
  65: "ENOPKG",
  66: "EREMOTE",
  67: "ENOLINK",
  68: "EADV",
  69: "ESRMNT",
  70: "ECOMM",
  71: "EPROTO",
  72: "EMULTIHOP",
  73: "EDOTDOT",
  74: "EBADMSG",
  75: "EOVERFLOW",
  76: "ENOTUNIQ",
  77: "EBADFD",
  78: "EREMCHG",
  79: "ELIBACC",
  80: "ELIBBAD",
  81: "ELIBSCN",
  82: "ELIBMAX",
  83: "ELIBEXEC",
  84: "EILSEQ",
  85: "ERESTART",
  86: "ESTRPIPE",
  87: "EUSERS",
  88: "ENOTSOCK",
  89: "EDESTADDRREQ",
  90: "EMSGSIZE",
  91: "EPROTOTYPE",
  92: "ENOPROTOOPT",
  93: "EPROTONOSUPPORT",
  94: "ESOCKTNOSUPPORT",
  95: "EOPNOTSUPP",
  96: "EPFNOSUPPORT",
  97: "EAFNOSUPPORT",
  98: "EADDRINUSE",
  99: "EADDRNOTAVAIL",
  100: "ENETDOWN",
  101: "ENETUNREACH",
  102: "ENETRESET",
  103: "ECONNABORTED",
  104: "ECONNRESET",
  105: "ENOBUFS",
  106: "EISCONN",
  107: "ENOTCONN",
  108: "ESHUTDOWN",
  109: "ETOOMANYREFS",
  110: "ETIMEDOUT",
  111: "ECONNREFUSED",
  112: "EHOSTDOWN",
  113: "EHOSTUNREACH",
  114: "EALREADY",
  115: "EINPROGRESS",
  116: "ESTALE",
  117: "EUCLEAN",
  118: "ENOTNAM",
  119: "ENAVAIL",
  120: "EISNAM",
  121: "EREMOTEIO",
  122: "EDQUOT",
  123: "ENOMEDIUM",
  124: "EMEDIUMTYPE",
  125: "ECANCELED",
  126: "ENOKEY",
  127: "EKEYEXPIRED",
  128: "EKEYREVOKED",
  129: "EKEYREJECTED",
  130: "EOWNERDEAD",
  131: "ENOTRECOVERABLE",
  132: "ERFKILL",
  133: "EHWPOISON",
};

function hostPlatform() {
  if (typeof process !== "undefined" && process && typeof process.platform === "string") {
    return process.platform;
  }
  if (
    typeof globalThis !== "undefined" &&
    globalThis.__ln_host &&
    typeof globalThis.__ln_host.platform === "string"
  ) {
    return globalThis.__ln_host.platform;
  }
  return "linux";
}

function getSystemErrorName(err) {
  if (typeof err !== "number") {
    throw invalidArgType("err", "of type number", err);
  }
  if (!Number.isInteger(err) || err >= 0) {
    const range = new RangeError(
      `The value of "err" is out of range. It must be a negative integer. Received ${err}`,
    );
    range.code = "ERR_OUT_OF_RANGE";
    throw range;
  }
  const platform = hostPlatform();
  const table = platform === "darwin" ? darwinErrnoNames : libuvErrnoNames;
  const name = table[-err];
  return name === undefined ? `Unknown system error ${err}` : name;
}

// ---------------------------------------------------------------------------
// Misc string helpers
// ---------------------------------------------------------------------------

function stripVTControlCharacters(str) {
  if (typeof str !== "string") {
    throw invalidArgType("str", "of type string", str);
  }
  if (str.indexOf("\u001B") === -1 && str.indexOf("\u009B") === -1) return str;
  return str.replace(ansiRegex, "");
}

function toUSVString(str) {
  const input = String(str);
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 < input.length) {
        const next = input.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          out += input[i] + input[i + 1];
          i++;
          continue;
        }
      }
      out += "\uFFFD";
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += "\uFFFD";
      continue;
    }
    out += input[i];
  }
  return out;
}

// ---------------------------------------------------------------------------
// util.types
// ---------------------------------------------------------------------------

const types = {
  isAnyArrayBuffer(value) {
    return isArrayBufferValue(value);
  },
  isArrayBuffer(value) {
    return isObjectLike(value) && tagOf(value) === "ArrayBuffer";
  },
  isSharedArrayBuffer(value) {
    return isSharedArrayBufferValue(value);
  },
  isArrayBufferView(value) {
    return isArrayBufferViewValue(value);
  },
  isTypedArray(value) {
    return isTypedArrayValue(value);
  },
  isUint8Array(value) {
    return isTypedArrayValue(value) && tagOf(value) === "Uint8Array";
  },
  isUint8ClampedArray(value) {
    return isTypedArrayValue(value) && tagOf(value) === "Uint8ClampedArray";
  },
  isInt8Array(value) {
    return isTypedArrayValue(value) && tagOf(value) === "Int8Array";
  },
  isUint16Array(value) {
    return isTypedArrayValue(value) && tagOf(value) === "Uint16Array";
  },
  isInt16Array(value) {
    return isTypedArrayValue(value) && tagOf(value) === "Int16Array";
  },
  isUint32Array(value) {
    return isTypedArrayValue(value) && tagOf(value) === "Uint32Array";
  },
  isInt32Array(value) {
    return isTypedArrayValue(value) && tagOf(value) === "Int32Array";
  },
  isFloat32Array(value) {
    return isTypedArrayValue(value) && tagOf(value) === "Float32Array";
  },
  isFloat64Array(value) {
    return isTypedArrayValue(value) && tagOf(value) === "Float64Array";
  },
  isBigInt64Array(value) {
    return isTypedArrayValue(value) && tagOf(value) === "BigInt64Array";
  },
  isBigUint64Array(value) {
    return isTypedArrayValue(value) && tagOf(value) === "BigUint64Array";
  },
  isDataView(value) {
    return isDataViewValue(value);
  },
  isPromise(value) {
    return isPromiseValue(value);
  },
  isDate(value) {
    return isDateValue(value);
  },
  isRegExp(value) {
    return isRegExpValue(value);
  },
  isMap(value) {
    return isMapValue(value);
  },
  isSet(value) {
    return isSetValue(value);
  },
  isWeakMap(value) {
    return isWeakMapValue(value);
  },
  isWeakSet(value) {
    return isWeakSetValue(value);
  },
  isAsyncFunction(value) {
    if (typeof value !== "function") return false;
    const tag = tagOf(value);
    return tag === "AsyncFunction" || tag === "AsyncGeneratorFunction";
  },
  isGeneratorFunction(value) {
    if (typeof value !== "function") return false;
    const tag = tagOf(value);
    return tag === "GeneratorFunction" || tag === "AsyncGeneratorFunction";
  },
  isGeneratorObject(value) {
    return isObjectLike(value) && tagOf(value) === "Generator";
  },
  isBoxedPrimitive(value) {
    return isBoxedPrimitiveValue(value);
  },
  isNumberObject(value) {
    return isObjectLike(value) && tagOf(value) === "Number";
  },
  isStringObject(value) {
    return isObjectLike(value) && tagOf(value) === "String";
  },
  isBooleanObject(value) {
    return isObjectLike(value) && tagOf(value) === "Boolean";
  },
  isSymbolObject(value) {
    return isObjectLike(value) && tagOf(value) === "Symbol";
  },
  isBigIntObject(value) {
    return isObjectLike(value) && tagOf(value) === "BigInt";
  },
  isNativeError(value) {
    return isErrorValue(value);
  },
  isSymbol(value) {
    return typeof value === "symbol";
  },
  isBigInt(value) {
    return typeof value === "bigint";
  },
  isNumber(value) {
    return typeof value === "number";
  },
  isString(value) {
    return typeof value === "string";
  },
  isBoolean(value) {
    return typeof value === "boolean";
  },
  isNull(value) {
    return value === null;
  },
  isUndefined(value) {
    return value === undefined;
  },
  isFunction(value) {
    return typeof value === "function";
  },
  isObject(value) {
    return (
      value !== null &&
      (typeof value === "object" || typeof value === "function")
    );
  },
  isPrimitive(value) {
    return !types.isObject(value);
  },
  isArgumentsObject(value) {
    return isObjectLike(value) && tagOf(value) === "Arguments";
  },
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

inspect.custom = customInspectSymbol;
inspect.defaultOptions = inspectDefaultOptions;

const util = {
  format,
  formatWithOptions,
  inspect,
  inherits,
  promisify,
  callbackify,
  deprecate,
  debuglog,
  getSystemErrorName,
  stripVTControlCharacters,
  toUSVString,
  isDeepStrictEqual,
  types,
  inspectDefaultOptions,
};

// Used by assert.js for the loose `deepEqual` family.  Not part of Node's
// public util surface, so keep it non-enumerable.
Object.defineProperty(util, "_isDeepEqual", {
  value: isDeepEqualInternal,
  enumerable: false,
  writable: true,
  configurable: true,
});

// TextEncoder/TextDecoder and Buffer are re-exported lazily to avoid load-time
// cycles (buffer.js itself may require util.js).
Object.defineProperty(util, "TextEncoder", {
  enumerable: true,
  configurable: true,
  get() {
    return typeof globalThis !== "undefined" ? globalThis.TextEncoder : undefined;
  },
});

Object.defineProperty(util, "TextDecoder", {
  enumerable: true,
  configurable: true,
  get() {
    return typeof globalThis !== "undefined" ? globalThis.TextDecoder : undefined;
  },
});

let bufferModule;
Object.defineProperty(util, "Buffer", {
  enumerable: true,
  configurable: true,
  get() {
    if (bufferModule === undefined) {
      try {
        bufferModule = require("buffer");
      } catch {
        bufferModule = null;
      }
    }
    return bufferModule ? bufferModule.Buffer : undefined;
  },
});

module.exports = util;
