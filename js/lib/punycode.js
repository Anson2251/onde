"use strict";

// Punycode (RFC 3492) — Node's deprecated `punycode` module.
//
// Behaviour (including the weird parts: ASCII passthrough, separators in
// domain names, error messages and the absence of an error `code`) follows
// the implementation Node ships in `lib/punycode.js` (punycode.js 2.1.0).
// That module is the behavioural oracle for this file.

/** Highest positive signed 32-bit float value. */
const maxInt = 2147483647; // 0x7FFFFFFF

/** Bootstring parameters. */
const base = 36;
const tMin = 1;
const tMax = 26;
const skew = 38;
const damp = 700;
const initialBias = 72;
const initialN = 128; // 0x80
const delimiter = "-";

/** Regular expressions. */
const regexPunycode = /^xn--/;
const regexNonASCII = /[^\0-\x7F]/;
const regexSeparators = /[\x2E\u3002\uFF0E\uFF61]/g; // RFC 3490 separators

/** Error messages. */
const errors = {
  overflow: "Overflow: input needs wider integers to process",
  "not-basic": "Illegal input >= 0x80 (not a basic code point)",
  "invalid-input": "Invalid input",
};

const baseMinusTMin = base - tMin;
const floor = Math.floor;

function error(type) {
  throw new RangeError(errors[type]);
}

function map(array, callback) {
  const result = [];
  let length = array.length;
  while (length--) {
    result[length] = callback(array[length]);
  }
  return result;
}

function mapDomain(domain, callback) {
  const parts = domain.split("@");
  let result = "";
  if (parts.length > 1) {
    // In email addresses only the domain name is punycoded.
    result = parts[0] + "@";
    domain = parts[1];
  }
  domain = domain.replace(regexSeparators, "\x2E");
  const labels = domain.split(".");
  return result + map(labels, callback).join(".");
}

function ucs2decode(string) {
  const output = [];
  let counter = 0;
  const length = string.length;
  while (counter < length) {
    const value = string.charCodeAt(counter++);
    if (value >= 0xd800 && value <= 0xdbff && counter < length) {
      const extra = string.charCodeAt(counter++);
      if ((extra & 0xfc00) === 0xdc00) {
        output.push(((value & 0x3ff) << 10) + (extra & 0x3ff) + 0x10000);
      } else {
        output.push(value);
        counter--;
      }
    } else {
      output.push(value);
    }
  }
  return output;
}

function ucs2encode(codePoints) {
  let out = "";
  for (let i = 0; i < codePoints.length; i++) {
    out += String.fromCodePoint(codePoints[i]);
  }
  return out;
}

function basicToDigit(codePoint) {
  if (codePoint >= 0x30 && codePoint < 0x3a) {
    return 26 + (codePoint - 0x30);
  }
  if (codePoint >= 0x41 && codePoint < 0x5b) {
    return codePoint - 0x41;
  }
  if (codePoint >= 0x61 && codePoint < 0x7b) {
    return codePoint - 0x61;
  }
  return base;
}

function digitToBasic(digit, flag) {
  // 0..25 map to a..z or A..Z, 26..35 map to 0..9.
  return digit + 22 + 75 * (digit < 26) - ((flag !== 0) << 5);
}

function adapt(delta, numPoints, firstTime) {
  let k = 0;
  delta = firstTime ? floor(delta / damp) : delta >> 1;
  delta += floor(delta / numPoints);
  for (; delta > (baseMinusTMin * tMax) >> 1; k += base) {
    delta = floor(delta / baseMinusTMin);
  }
  return floor(k + ((baseMinusTMin + 1) * delta) / (delta + skew));
}

function decode(input) {
  const output = [];
  const inputLength = input.length;
  let i = 0;
  let n = initialN;
  let bias = initialBias;

  let basic = input.lastIndexOf(delimiter);
  if (basic < 0) {
    basic = 0;
  }

  for (let j = 0; j < basic; ++j) {
    if (input.charCodeAt(j) >= 0x80) {
      error("not-basic");
    }
    output.push(input.charCodeAt(j));
  }

  for (let index = basic > 0 ? basic + 1 : 0; index < inputLength; ) {
    const oldi = i;
    for (let w = 1, k = base; ; k += base) {
      if (index >= inputLength) {
        error("invalid-input");
      }

      const digit = basicToDigit(input.charCodeAt(index++));
      if (digit >= base) {
        error("invalid-input");
      }
      if (digit > floor((maxInt - i) / w)) {
        error("overflow");
      }

      i += digit * w;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (digit < t) {
        break;
      }

      const baseMinusT = base - t;
      if (w > floor(maxInt / baseMinusT)) {
        error("overflow");
      }
      w *= baseMinusT;
    }

    const out = output.length + 1;
    bias = adapt(i - oldi, out, oldi === 0);

    if (floor(i / out) > maxInt - n) {
      error("overflow");
    }

    n += floor(i / out);
    i %= out;

    output.splice(i++, 0, n);
  }

  return ucs2encode(output);
}

function encode(input) {
  const output = [];
  const codePoints = ucs2decode(input);
  const inputLength = codePoints.length;

  let n = initialN;
  let delta = 0;
  let bias = initialBias;

  for (const currentValue of codePoints) {
    if (currentValue < 0x80) {
      output.push(String.fromCharCode(currentValue));
    }
  }

  const basicLength = output.length;
  let handledCPCount = basicLength;

  if (basicLength) {
    output.push(delimiter);
  }

  while (handledCPCount < inputLength) {
    let m = maxInt;
    for (const currentValue of codePoints) {
      if (currentValue >= n && currentValue < m) {
        m = currentValue;
      }
    }

    const handledCPCountPlusOne = handledCPCount + 1;
    if (m - n > floor((maxInt - delta) / handledCPCountPlusOne)) {
      error("overflow");
    }

    delta += (m - n) * handledCPCountPlusOne;
    n = m;

    for (const currentValue of codePoints) {
      if (currentValue < n && ++delta > maxInt) {
        error("overflow");
      }
      if (currentValue === n) {
        let q = delta;
        for (let k = base; ; k += base) {
          const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
          if (q < t) {
            break;
          }
          const qMinusT = q - t;
          const baseMinusT = base - t;
          output.push(
            String.fromCharCode(
              digitToBasic(t + (qMinusT % baseMinusT), 0),
            ),
          );
          q = floor(qMinusT / baseMinusT);
        }

        output.push(String.fromCharCode(digitToBasic(q, 0)));
        bias = adapt(delta, handledCPCountPlusOne, handledCPCount === basicLength);
        delta = 0;
        ++handledCPCount;
      }
    }

    ++delta;
    ++n;
  }

  return output.join("");
}

function toUnicode(input) {
  return mapDomain(input, function (string) {
    return regexPunycode.test(string)
      ? decode(string.slice(4).toLowerCase())
      : string;
  });
}

function toASCII(input) {
  return mapDomain(input, function (string) {
    return regexNonASCII.test(string) ? "xn--" + encode(string) : string;
  });
}

const punycode = {
  version: "2.1.0",
  ucs2: {
    decode: ucs2decode,
    encode: ucs2encode,
  },
  decode,
  encode,
  toASCII,
  toUnicode,
};

module.exports = punycode;
