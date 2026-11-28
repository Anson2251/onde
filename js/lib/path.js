"use strict";

// Node-compatible `path` module.
//
// Both implementations (posix and win32) are complete and independently usable;
// the default export is chosen from `process.platform` at load time. The
// algorithms deliberately follow Node.js lib/path.js (MIT, Node contributors)
// so that edge cases (empty strings, repeated separators, device roots, UNC
// roots, dotfiles, extensions, namespaced paths, ...) match Node exactly.

const CHAR_UPPERCASE_A = 65;
const CHAR_LOWERCASE_A = 97;
const CHAR_UPPERCASE_Z = 90;
const CHAR_LOWERCASE_Z = 122;
const CHAR_DOT = 46;
const CHAR_FORWARD_SLASH = 47;
const CHAR_BACKWARD_SLASH = 92;
const CHAR_COLON = 58;
const CHAR_QUESTION_MARK = 63;

// Windows reserved device names (Node rejects/normalizes these relative paths).
const WINDOWS_RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
  "COM\u00b9", "COM\u00b2", "COM\u00b3",
  "LPT\u00b9", "LPT\u00b2", "LPT\u00b3",
]);

const platform =
  typeof process !== "undefined" && process && typeof process.platform === "string"
    ? process.platform
    : "";
const isWindows = platform === "win32";

const { invalidArgType } = require("./internal/errors.js");

function isPathSeparator(code) {
  return code === CHAR_FORWARD_SLASH || code === CHAR_BACKWARD_SLASH;
}

function isPosixPathSeparator(code) {
  return code === CHAR_FORWARD_SLASH;
}

function isWindowsDeviceRoot(code) {
  return (
    (code >= CHAR_UPPERCASE_A && code <= CHAR_UPPERCASE_Z) ||
    (code >= CHAR_LOWERCASE_A && code <= CHAR_LOWERCASE_Z)
  );
}

function isWindowsReservedName(path, colonIndex) {
  const devicePart = path.slice(0, colonIndex).toUpperCase();
  return WINDOWS_RESERVED_NAMES.has(devicePart);
}

// ---------------------------------------------------------------------------
// Argument validation (Node's ERR_INVALID_ARG_TYPE shape)
// ---------------------------------------------------------------------------

function validateString(value, name) {
  if (typeof value !== "string") throw invalidArgType(name, "string", value);
}

function validateObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidArgType(name, "object", value);
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Resolves "." and ".." segments. `isPathSeparator` decides which characters
// separate segments and `separator` is used to re-join them.
function normalizeString(path, allowAboveRoot, separator, isPathSeparatorFn) {
  let res = "";
  let lastSegmentLength = 0;
  let lastSlash = -1;
  let dots = 0;
  let code = 0;

  for (let i = 0; i <= path.length; ++i) {
    if (i < path.length) code = path.charCodeAt(i);
    else if (isPathSeparatorFn(code)) break;
    else code = CHAR_FORWARD_SLASH;

    if (isPathSeparatorFn(code)) {
      if (lastSlash === i - 1 || dots === 1) {
        // Empty segment or ".": skip it.
      } else if (dots === 2) {
        if (
          res.length < 2 ||
          lastSegmentLength !== 2 ||
          res.charCodeAt(res.length - 1) !== CHAR_DOT ||
          res.charCodeAt(res.length - 2) !== CHAR_DOT
        ) {
          if (res.length > 2) {
            const lastSlashIndex = res.length - lastSegmentLength - 1;
            if (lastSlashIndex === -1) {
              res = "";
              lastSegmentLength = 0;
            } else {
              res = res.slice(0, lastSlashIndex);
              lastSegmentLength = res.length - 1 - res.lastIndexOf(separator);
            }
            lastSlash = i;
            dots = 0;
            continue;
          } else if (res.length !== 0) {
            res = "";
            lastSegmentLength = 0;
            lastSlash = i;
            dots = 0;
            continue;
          }
        }
        if (allowAboveRoot) {
          res += res.length > 0 ? `${separator}..` : "..";
          lastSegmentLength = 2;
        }
      } else {
        if (res.length > 0) res += `${separator}${path.slice(lastSlash + 1, i)}`;
        else res = path.slice(lastSlash + 1, i);
        lastSegmentLength = i - lastSlash - 1;
      }
      lastSlash = i;
      dots = 0;
    } else if (code === CHAR_DOT && dots !== -1) {
      ++dots;
    } else {
      dots = -1;
    }
  }
  return res;
}

function formatExt(ext) {
  return ext ? `${ext[0] === "." ? "" : "."}${ext}` : "";
}

function formatWith(sep, pathObject) {
  validateObject(pathObject, "pathObject");
  const dir = pathObject.dir || pathObject.root;
  const base = pathObject.base || `${pathObject.name || ""}${formatExt(pathObject.ext)}`;
  if (!dir) return base;
  return dir === pathObject.root ? `${dir}${base}` : `${dir}${sep}${base}`;
}

function posixCwd() {
  if (isWindows) {
    // Convert Windows separators and drop the drive indicator.
    const cwd = process.cwd().replace(/\\/g, "/");
    return cwd.slice(cwd.indexOf("/"));
  }
  return process.cwd();
}

// ---------------------------------------------------------------------------
// posix
// ---------------------------------------------------------------------------

const posix = {
  resolve(...args) {
    if (args.length === 0 || (args.length === 1 && (args[0] === "" || args[0] === "."))) {
      const cwd = posixCwd();
      if (cwd.charCodeAt(0) === CHAR_FORWARD_SLASH) return cwd;
    }

    let resolvedPath = "";
    let resolvedAbsolute = false;

    for (let i = args.length - 1; i >= 0 && !resolvedAbsolute; i--) {
      const path = args[i];
      validateString(path, `paths[${i}]`);

      if (path.length === 0) continue;

      resolvedPath = `${path}/${resolvedPath}`;
      resolvedAbsolute = path[0] === "/";
    }

    if (!resolvedAbsolute) {
      const cwd = posixCwd();
      resolvedPath = `${cwd}/${resolvedPath}`;
      resolvedAbsolute = cwd.charCodeAt(0) === CHAR_FORWARD_SLASH;
    }

    resolvedPath = normalizeString(resolvedPath, !resolvedAbsolute, "/", isPosixPathSeparator);

    if (resolvedAbsolute) return `/${resolvedPath}`;
    return resolvedPath.length > 0 ? resolvedPath : ".";
  },

  normalize(path) {
    validateString(path, "path");

    if (path.length === 0) return ".";

    const isAbsolute = path[0] === "/";
    const trailingSeparator = path[path.length - 1] === "/";

    path = normalizeString(path, !isAbsolute, "/", isPosixPathSeparator);

    if (path.length === 0) {
      if (isAbsolute) return "/";
      return trailingSeparator ? "./" : ".";
    }
    if (trailingSeparator) path += "/";

    return isAbsolute ? `/${path}` : path;
  },

  isAbsolute(path) {
    validateString(path, "path");
    return path.length > 0 && path.charCodeAt(0) === CHAR_FORWARD_SLASH;
  },

  join(...args) {
    if (args.length === 0) return ".";

    const path = [];
    for (let i = 0; i < args.length; ++i) {
      const arg = args[i];
      validateString(arg, "path");
      if (arg.length > 0) path.push(arg);
    }

    if (path.length === 0) return ".";

    return posix.normalize(path.join("/"));
  },

  relative(from, to) {
    validateString(from, "from");
    validateString(to, "to");

    if (from === to) return "";

    from = posix.resolve(from);
    to = posix.resolve(to);

    if (from === to) return "";

    const fromStart = 1;
    const fromEnd = from.length;
    const fromLen = fromEnd - fromStart;
    const toStart = 1;
    const toLen = to.length - toStart;

    const length = fromLen < toLen ? fromLen : toLen;
    let lastCommonSep = -1;
    let i = 0;
    for (; i < length; i++) {
      const fromCode = from.charCodeAt(fromStart + i);
      if (fromCode !== to.charCodeAt(toStart + i)) break;
      else if (fromCode === CHAR_FORWARD_SLASH) lastCommonSep = i;
    }

    if (i === length) {
      if (toLen > length) {
        if (to.charCodeAt(toStart + i) === CHAR_FORWARD_SLASH) {
          // `from` is the exact base path for `to`.
          return to.slice(toStart + i + 1);
        }
        if (i === 0) {
          // `from` is the root.
          return to.slice(toStart + i);
        }
      } else if (fromLen > length) {
        if (from.charCodeAt(fromStart + i) === CHAR_FORWARD_SLASH) {
          // `to` is the exact base path for `from`.
          lastCommonSep = i;
        } else if (i === 0) {
          // `to` is the root.
          lastCommonSep = 0;
        }
      }
    }

    let out = "";
    for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) {
      if (i === fromEnd || from.charCodeAt(i) === CHAR_FORWARD_SLASH) {
        out += out.length === 0 ? ".." : "/..";
      }
    }

    return `${out}${to.slice(toStart + lastCommonSep)}`;
  },

  toNamespacedPath(path) {
    // Non-op on posix systems.
    return path;
  },

  dirname(path) {
    validateString(path, "path");
    if (path.length === 0) return ".";

    const hasRoot = path.charCodeAt(0) === CHAR_FORWARD_SLASH;
    let end = -1;
    let matchedSlash = true;
    for (let i = path.length - 1; i >= 1; --i) {
      if (path.charCodeAt(i) === CHAR_FORWARD_SLASH) {
        if (!matchedSlash) {
          end = i;
          break;
        }
      } else {
        matchedSlash = false;
      }
    }

    if (end === -1) return hasRoot ? "/" : ".";
    if (hasRoot && end === 1) return "//";
    return path.slice(0, end);
  },

  basename(path, suffix) {
    if (suffix !== undefined) validateString(suffix, "suffix");
    validateString(path, "path");

    let start = 0;
    let end = -1;
    let matchedSlash = true;

    if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
      if (suffix === path) return "";

      let extIdx = suffix.length - 1;
      let firstNonSlashEnd = -1;
      for (let i = path.length - 1; i >= 0; --i) {
        const code = path.charCodeAt(i);
        if (code === CHAR_FORWARD_SLASH) {
          if (!matchedSlash) {
            start = i + 1;
            break;
          }
        } else {
          if (firstNonSlashEnd === -1) {
            matchedSlash = false;
            firstNonSlashEnd = i + 1;
          }
          if (extIdx >= 0) {
            if (code === suffix.charCodeAt(extIdx)) {
              if (--extIdx === -1) end = i;
            } else {
              extIdx = -1;
              end = firstNonSlashEnd;
            }
          }
        }
      }

      if (start === end) end = firstNonSlashEnd;
      else if (end === -1) end = path.length;
      return path.slice(start, end);
    }

    for (let i = path.length - 1; i >= 0; --i) {
      if (path.charCodeAt(i) === CHAR_FORWARD_SLASH) {
        if (!matchedSlash) {
          start = i + 1;
          break;
        }
      } else if (end === -1) {
        matchedSlash = false;
        end = i + 1;
      }
    }

    if (end === -1) return "";
    return path.slice(start, end);
  },

  extname(path) {
    validateString(path, "path");

    let startDot = -1;
    let startPart = 0;
    let end = -1;
    let matchedSlash = true;
    let preDotState = 0;

    for (let i = path.length - 1; i >= 0; --i) {
      const char = path[i];
      if (char === "/") {
        if (!matchedSlash) {
          startPart = i + 1;
          break;
        }
        continue;
      }
      if (end === -1) {
        matchedSlash = false;
        end = i + 1;
      }
      if (char === ".") {
        if (startDot === -1) startDot = i;
        else if (preDotState !== 1) preDotState = 1;
      } else if (startDot !== -1) {
        preDotState = -1;
      }
    }

    if (
      startDot === -1 ||
      end === -1 ||
      preDotState === 0 ||
      (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
    ) {
      return "";
    }
    return path.slice(startDot, end);
  },

  format(pathObject) {
    return formatWith("/", pathObject);
  },

  parse(path) {
    validateString(path, "path");

    const ret = { root: "", dir: "", base: "", ext: "", name: "" };
    if (path.length === 0) return ret;

    const isAbsolute = path.charCodeAt(0) === CHAR_FORWARD_SLASH;
    let start;
    if (isAbsolute) {
      ret.root = "/";
      start = 1;
    } else {
      start = 0;
    }

    let startDot = -1;
    let startPart = 0;
    let end = -1;
    let matchedSlash = true;
    let i = path.length - 1;
    let preDotState = 0;

    for (; i >= start; --i) {
      const char = path[i];
      if (char === "/") {
        if (!matchedSlash) {
          startPart = i + 1;
          break;
        }
        continue;
      }
      if (end === -1) {
        matchedSlash = false;
        end = i + 1;
      }
      if (char === ".") {
        if (startDot === -1) startDot = i;
        else if (preDotState !== 1) preDotState = 1;
      } else if (startDot !== -1) {
        preDotState = -1;
      }
    }

    if (end !== -1) {
      const baseStart = startPart === 0 && isAbsolute ? 1 : startPart;
      if (
        startDot === -1 ||
        preDotState === 0 ||
        (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
      ) {
        ret.base = ret.name = path.slice(baseStart, end);
      } else {
        ret.name = path.slice(baseStart, startDot);
        ret.base = path.slice(baseStart, end);
        ret.ext = path.slice(startDot, end);
      }
    }

    if (startPart > 0) ret.dir = path.slice(0, startPart - 1);
    else if (isAbsolute) ret.dir = "/";

    return ret;
  },

  sep: "/",
  delimiter: ":",
  win32: null,
  posix: null,
};

// ---------------------------------------------------------------------------
// win32
// ---------------------------------------------------------------------------

const win32 = {
  resolve(...args) {
    let resolvedDevice = "";
    let resolvedTail = "";
    let resolvedAbsolute = false;

    for (let i = args.length - 1; i >= -1; i--) {
      let path;
      if (i >= 0) {
        path = args[i];
        validateString(path, `paths[${i}]`);
        if (path.length === 0) continue;
      } else if (resolvedDevice.length === 0) {
        path = process.cwd();
        // Fast path for the current directory.
        if (
          args.length === 0 ||
          (args.length === 1 &&
            (args[0] === "" || args[0] === ".") &&
            isPathSeparator(path.charCodeAt(0)))
        ) {
          if (!isWindows) path = path.replace(/\//g, "\\");
          return path;
        }
      } else {
        // Windows keeps per-drive working directories in the environment.
        path = process.env[`=${resolvedDevice}`] || process.cwd();

        // Fall back to the drive root if the cwd does not belong to the drive.
        if (
          path === undefined ||
          (path.slice(0, 2).toLowerCase() !== resolvedDevice.toLowerCase() &&
            path.charCodeAt(2) === CHAR_BACKWARD_SLASH)
        ) {
          path = `${resolvedDevice}\\`;
        }
      }

      const len = path.length;
      let rootEnd = 0;
      let device = "";
      let isAbsolute = false;
      const code = path.charCodeAt(0);

      // Try to match a root.
      if (len === 1) {
        if (isPathSeparator(code)) {
          rootEnd = 1;
          isAbsolute = true;
        }
      } else if (isPathSeparator(code)) {
        // Possible UNC root.
        isAbsolute = true;

        if (isPathSeparator(path.charCodeAt(1))) {
          // Matched double path separator at beginning.
          let j = 2;
          let last = j;
          while (j < len && !isPathSeparator(path.charCodeAt(j))) j++;
          if (j < len && j !== last) {
            const firstPart = path.slice(last, j);
            last = j;
            while (j < len && isPathSeparator(path.charCodeAt(j))) j++;
            if (j < len && j !== last) {
              last = j;
              while (j < len && !isPathSeparator(path.charCodeAt(j))) j++;
              if (j === len || j !== last) {
                if (firstPart !== "." && firstPart !== "?") {
                  // We matched a UNC root.
                  device = `\\\\${firstPart}\\${path.slice(last, j)}`;
                  rootEnd = j;
                } else {
                  // We matched a device root (e.g. \\\\.\\PHYSICALDRIVE0).
                  device = `\\\\${firstPart}`;
                  rootEnd = 4;
                }
              }
            }
          }
        } else {
          rootEnd = 1;
        }
      } else if (
        isWindowsDeviceRoot(code) &&
        path.charCodeAt(1) === CHAR_COLON
      ) {
        // Possible device root.
        device = path.slice(0, 2);
        rootEnd = 2;
        if (len > 2 && isPathSeparator(path.charCodeAt(2))) {
          // A separator after the drive name means an absolute path.
          isAbsolute = true;
          rootEnd = 3;
        }
      }

      if (device.length > 0) {
        if (resolvedDevice.length > 0) {
          if (device.toLowerCase() !== resolvedDevice.toLowerCase()) {
            // This path points to another device so it is not applicable.
            continue;
          }
        } else {
          resolvedDevice = device;
        }
      }

      if (resolvedAbsolute) {
        if (resolvedDevice.length > 0) break;
      } else {
        resolvedTail = `${path.slice(rootEnd)}\\${resolvedTail}`;
        resolvedAbsolute = isAbsolute;
        if (isAbsolute && resolvedDevice.length > 0) break;
      }
    }

    resolvedTail = normalizeString(resolvedTail, !resolvedAbsolute, "\\", isPathSeparator);

    return resolvedAbsolute
      ? `${resolvedDevice}\\${resolvedTail}`
      : `${resolvedDevice}${resolvedTail}` || ".";
  },

  normalize(path) {
    validateString(path, "path");
    const len = path.length;
    if (len === 0) return ".";

    let rootEnd = 0;
    let device;
    let isAbsolute = false;
    const code = path.charCodeAt(0);

    // Try to match a root.
    if (len === 1) {
      return isPosixPathSeparator(code) ? "\\" : path;
    }
    if (isPathSeparator(code)) {
      // Possible UNC root.
      isAbsolute = true;

      if (isPathSeparator(path.charCodeAt(1))) {
        // Matched double path separator at beginning.
        let j = 2;
        let last = j;
        while (j < len && !isPathSeparator(path.charCodeAt(j))) j++;
        if (j < len && j !== last) {
          const firstPart = path.slice(last, j);
          last = j;
          while (j < len && isPathSeparator(path.charCodeAt(j))) j++;
          if (j < len && j !== last) {
            last = j;
            while (j < len && !isPathSeparator(path.charCodeAt(j))) j++;
            if (j === len || j !== last) {
              if (firstPart === "." || firstPart === "?") {
                // Device root (e.g. \\\\.\\PHYSICALDRIVE0).
                device = `\\\\${firstPart}`;
                rootEnd = 4;
                const colonIndex = path.indexOf(":");
                const possibleDevice = path.slice(4, colonIndex + 1);
                if (isWindowsReservedName(possibleDevice, possibleDevice.length - 1)) {
                  device = `\\\\?\\${possibleDevice}`;
                  rootEnd = 4 + possibleDevice.length;
                }
              } else if (j === len) {
                // UNC root only: return the normalized root.
                return `\\\\${firstPart}\\${path.slice(last)}\\`;
              } else {
                // UNC root with leftovers.
                device = `\\\\${firstPart}\\${path.slice(last, j)}`;
                rootEnd = j;
              }
            }
          }
        }
      } else {
        rootEnd = 1;
      }
    } else {
      const colonIndex = path.indexOf(":");
      if (colonIndex > 0) {
        if (isWindowsDeviceRoot(code) && colonIndex === 1) {
          device = path.slice(0, 2);
          rootEnd = 2;
          if (len > 2 && isPathSeparator(path.charCodeAt(2))) {
            isAbsolute = true;
            rootEnd = 3;
          }
        } else if (isWindowsReservedName(path, colonIndex)) {
          device = path.slice(0, colonIndex + 1);
          rootEnd = colonIndex + 1;
        }
      }
    }

    let tail =
      rootEnd < len
        ? normalizeString(path.slice(rootEnd), !isAbsolute, "\\", isPathSeparator)
        : "";
    if (tail.length === 0 && !isAbsolute) tail = ".";
    if (tail.length > 0 && isPathSeparator(path.charCodeAt(len - 1))) tail += "\\";

    if (!isAbsolute && device === undefined && path.includes(":")) {
      // Guard against a relative path becoming something Windows interprets as
      // absolute (CVE-2024-36139).
      if (
        tail.length >= 2 &&
        isWindowsDeviceRoot(tail.charCodeAt(0)) &&
        tail.charCodeAt(1) === CHAR_COLON
      ) {
        return `.\\${tail}`;
      }
      let index = path.indexOf(":");
      do {
        if (index === len - 1 || isPathSeparator(path.charCodeAt(index + 1))) {
          return `.\\${tail}`;
        }
      } while ((index = path.indexOf(":", index + 1)) !== -1);
    }

    const colonIndex = path.indexOf(":");
    if (isWindowsReservedName(path, colonIndex)) {
      return `.\\${device ?? ""}${tail}`;
    }

    if (device === undefined) {
      return isAbsolute ? `\\${tail}` : tail;
    }
    return isAbsolute ? `${device}\\${tail}` : `${device}${tail}`;
  },

  isAbsolute(path) {
    validateString(path, "path");
    const len = path.length;
    if (len === 0) return false;

    const code = path.charCodeAt(0);
    return (
      isPathSeparator(code) ||
      (len > 2 &&
        isWindowsDeviceRoot(code) &&
        path.charCodeAt(1) === CHAR_COLON &&
        isPathSeparator(path.charCodeAt(2)))
    );
  },

  join(...args) {
    if (args.length === 0) return ".";

    const path = [];
    for (let i = 0; i < args.length; ++i) {
      const arg = args[i];
      validateString(arg, "path");
      if (arg.length > 0) path.push(arg);
    }

    if (path.length === 0) return ".";

    const firstPart = path[0];
    let joined = path.join("\\");

    // Don't accidentally create a UNC path when joining ordinary paths. A
    // genuine UNC path is one that starts with exactly two slashes followed by
    // a non-slash character.
    let needsReplace = true;
    let slashCount = 0;
    if (isPathSeparator(firstPart.charCodeAt(0))) {
      ++slashCount;
      const firstLen = firstPart.length;
      if (firstLen > 1 && isPathSeparator(firstPart.charCodeAt(1))) {
        ++slashCount;
        if (firstLen > 2) {
          if (isPathSeparator(firstPart.charCodeAt(2))) ++slashCount;
          else needsReplace = false;
        }
      }
    }
    if (needsReplace) {
      while (slashCount < joined.length && isPathSeparator(joined.charCodeAt(slashCount))) {
        slashCount++;
      }
      if (slashCount >= 2) joined = `\\${joined.slice(slashCount)}`;
    }

    // Reserved device names must not be normalized (it would corrupt them).
    const parts = [];
    let part = "";
    for (let i = 0; i < joined.length; i++) {
      if (joined[i] === "\\") {
        if (part) parts.push(part);
        part = "";
        while (i + 1 < joined.length && joined[i + 1] === "\\") i++;
      } else {
        part += joined[i];
      }
    }
    if (part) parts.push(part);

    if (
      parts.some((p) => {
        const colonIndex = p.indexOf(":");
        return colonIndex !== -1 && isWindowsReservedName(p, colonIndex);
      })
    ) {
      let result = "";
      for (let i = 0; i < joined.length; i++) {
        result += joined[i] === "/" ? "\\" : joined[i];
      }
      return result;
    }

    return win32.normalize(joined);
  },

  relative(from, to) {
    validateString(from, "from");
    validateString(to, "to");

    if (from === to) return "";

    const fromOrig = win32.resolve(from);
    const toOrig = win32.resolve(to);

    if (fromOrig === toOrig) return "";

    from = fromOrig.toLowerCase();
    to = toOrig.toLowerCase();

    if (from === to) return "";

    if (fromOrig.length !== from.length || toOrig.length !== to.length) {
      // Lowercasing changed the length of one of the paths; compare per
      // segment instead of by character offset.
      const fromSplit = fromOrig.split("\\");
      const toSplit = toOrig.split("\\");
      if (fromSplit[fromSplit.length - 1] === "") fromSplit.pop();
      if (toSplit[toSplit.length - 1] === "") toSplit.pop();

      const fromLen = fromSplit.length;
      const toLen = toSplit.length;
      const length = fromLen < toLen ? fromLen : toLen;

      let i;
      for (i = 0; i < length; i++) {
        if (fromSplit[i].toLowerCase() !== toSplit[i].toLowerCase()) break;
      }

      if (i === 0) {
        return toOrig;
      } else if (i === length) {
        if (toLen > length) {
          return toSplit.slice(i).join("\\");
        }
        if (fromLen > length) {
          return "..\\".repeat(fromLen - 1 - i) + "..";
        }
        return "";
      }

      return "..\\".repeat(fromLen - i) + toSplit.slice(i).join("\\");
    }

    // Trim any leading backslashes.
    let fromStart = 0;
    while (fromStart < from.length && from.charCodeAt(fromStart) === CHAR_BACKWARD_SLASH) {
      fromStart++;
    }
    // Trim trailing backslashes (applicable to UNC paths only).
    let fromEnd = from.length;
    while (fromEnd - 1 > fromStart && from.charCodeAt(fromEnd - 1) === CHAR_BACKWARD_SLASH) {
      fromEnd--;
    }
    const fromLen = fromEnd - fromStart;

    // Trim any leading backslashes.
    let toStart = 0;
    while (toStart < to.length && to.charCodeAt(toStart) === CHAR_BACKWARD_SLASH) {
      toStart++;
    }
    // Trim trailing backslashes (applicable to UNC paths only).
    let toEnd = to.length;
    while (toEnd - 1 > toStart && to.charCodeAt(toEnd - 1) === CHAR_BACKWARD_SLASH) {
      toEnd--;
    }
    const toLen = toEnd - toStart;

    const length = fromLen < toLen ? fromLen : toLen;
    let lastCommonSep = -1;
    let i = 0;
    for (; i < length; i++) {
      const fromCode = from.charCodeAt(fromStart + i);
      if (fromCode !== to.charCodeAt(toStart + i)) break;
      else if (fromCode === CHAR_BACKWARD_SLASH) lastCommonSep = i;
    }

    if (i !== length) {
      // Mismatch before the first common separator: return `to` unchanged.
      if (lastCommonSep === -1) return toOrig;
    } else {
      if (toLen > length) {
        if (to.charCodeAt(toStart + i) === CHAR_BACKWARD_SLASH) {
          // `from` is the exact base path for `to`.
          return toOrig.slice(toStart + i + 1);
        }
        if (i === 2) {
          // `from` is the device root.
          return toOrig.slice(toStart + i);
        }
      }
      if (fromLen > length) {
        if (from.charCodeAt(fromStart + i) === CHAR_BACKWARD_SLASH) {
          // `to` is the exact base path for `from`.
          lastCommonSep = i;
        } else if (i === 2) {
          // `to` is the device root.
          lastCommonSep = 3;
        }
      }
      if (lastCommonSep === -1) lastCommonSep = 0;
    }

    let out = "";
    for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) {
      if (i === fromEnd || from.charCodeAt(i) === CHAR_BACKWARD_SLASH) {
        out += out.length === 0 ? ".." : "\\..";
      }
    }

    toStart += lastCommonSep;

    if (out.length > 0) return `${out}${toOrig.slice(toStart, toEnd)}`;

    if (toOrig.charCodeAt(toStart) === CHAR_BACKWARD_SLASH) ++toStart;
    return toOrig.slice(toStart, toEnd);
  },

  toNamespacedPath(path) {
    // Note: unlike the other methods this one does not validate its argument;
    // Node returns non-strings unchanged.
    if (typeof path !== "string" || path.length === 0) return path;

    const resolvedPath = win32.resolve(path);

    if (resolvedPath.length <= 2) return path;

    if (resolvedPath.charCodeAt(0) === CHAR_BACKWARD_SLASH) {
      // Possible UNC root.
      if (resolvedPath.charCodeAt(1) === CHAR_BACKWARD_SLASH) {
        const code = resolvedPath.charCodeAt(2);
        if (code !== CHAR_QUESTION_MARK && code !== CHAR_DOT) {
          // Convert a non-long UNC path to a long UNC path.
          return `\\\\?\\UNC\\${resolvedPath.slice(2)}`;
        }
      }
    } else if (
      isWindowsDeviceRoot(resolvedPath.charCodeAt(0)) &&
      resolvedPath.charCodeAt(1) === CHAR_COLON &&
      resolvedPath.charCodeAt(2) === CHAR_BACKWARD_SLASH
    ) {
      // Convert a device path to a long UNC path.
      return `\\\\?\\${resolvedPath}`;
    }

    return resolvedPath;
  },

  dirname(path) {
    validateString(path, "path");
    const len = path.length;
    if (len === 0) return ".";
    let rootEnd = -1;
    let offset = 0;
    const code = path.charCodeAt(0);

    if (len === 1) {
      return isPathSeparator(code) ? path : ".";
    }

    // Try to match a root.
    if (isPathSeparator(code)) {
      // Possible UNC root.
      rootEnd = offset = 1;

      if (isPathSeparator(path.charCodeAt(1))) {
        // Matched double path separator at beginning.
        let j = 2;
        let last = j;
        while (j < len && !isPathSeparator(path.charCodeAt(j))) j++;
        if (j < len && j !== last) {
          last = j;
          while (j < len && isPathSeparator(path.charCodeAt(j))) j++;
          if (j < len && j !== last) {
            last = j;
            while (j < len && !isPathSeparator(path.charCodeAt(j))) j++;
            if (j === len) {
              // We matched a UNC root only.
              return path;
            }
            if (j !== last) {
              // Matched a UNC root with leftovers.
              rootEnd = offset = j + 1;
            }
          }
        }
      }
    } else if (isWindowsDeviceRoot(code) && path.charCodeAt(1) === CHAR_COLON) {
      // Possible device root.
      rootEnd = len > 2 && isPathSeparator(path.charCodeAt(2)) ? 3 : 2;
      offset = rootEnd;
    }

    let end = -1;
    let matchedSlash = true;
    for (let i = len - 1; i >= offset; --i) {
      if (isPathSeparator(path.charCodeAt(i))) {
        if (!matchedSlash) {
          end = i;
          break;
        }
      } else {
        matchedSlash = false;
      }
    }

    if (end === -1) {
      if (rootEnd === -1) return ".";
      end = rootEnd;
    }
    return path.slice(0, end);
  },

  basename(path, suffix) {
    if (suffix !== undefined) validateString(suffix, "suffix");
    validateString(path, "path");

    let start = 0;
    let end = -1;
    let matchedSlash = true;

    // Skip a drive letter so its separator is not treated as a trailing one.
    if (
      path.length >= 2 &&
      isWindowsDeviceRoot(path.charCodeAt(0)) &&
      path.charCodeAt(1) === CHAR_COLON
    ) {
      start = 2;
    }

    if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
      if (suffix === path) return "";

      let extIdx = suffix.length - 1;
      let firstNonSlashEnd = -1;
      for (let i = path.length - 1; i >= start; --i) {
        const code = path.charCodeAt(i);
        if (isPathSeparator(code)) {
          if (!matchedSlash) {
            start = i + 1;
            break;
          }
        } else {
          if (firstNonSlashEnd === -1) {
            matchedSlash = false;
            firstNonSlashEnd = i + 1;
          }
          if (extIdx >= 0) {
            if (code === suffix.charCodeAt(extIdx)) {
              if (--extIdx === -1) end = i;
            } else {
              extIdx = -1;
              end = firstNonSlashEnd;
            }
          }
        }
      }

      if (start === end) end = firstNonSlashEnd;
      else if (end === -1) end = path.length;
      return path.slice(start, end);
    }

    for (let i = path.length - 1; i >= start; --i) {
      if (isPathSeparator(path.charCodeAt(i))) {
        if (!matchedSlash) {
          start = i + 1;
          break;
        }
      } else if (end === -1) {
        matchedSlash = false;
        end = i + 1;
      }
    }

    if (end === -1) return "";
    return path.slice(start, end);
  },

  extname(path) {
    validateString(path, "path");

    let start = 0;
    let startDot = -1;
    let startPart = 0;
    let end = -1;
    let matchedSlash = true;
    let preDotState = 0;

    // Skip a drive letter so its separator is not treated as a trailing one.
    if (
      path.length >= 2 &&
      path.charCodeAt(1) === CHAR_COLON &&
      isWindowsDeviceRoot(path.charCodeAt(0))
    ) {
      start = startPart = 2;
    }

    for (let i = path.length - 1; i >= start; --i) {
      const code = path.charCodeAt(i);
      if (isPathSeparator(code)) {
        if (!matchedSlash) {
          startPart = i + 1;
          break;
        }
        continue;
      }
      if (end === -1) {
        matchedSlash = false;
        end = i + 1;
      }
      if (code === CHAR_DOT) {
        if (startDot === -1) startDot = i;
        else if (preDotState !== 1) preDotState = 1;
      } else if (startDot !== -1) {
        preDotState = -1;
      }
    }

    if (
      startDot === -1 ||
      end === -1 ||
      preDotState === 0 ||
      (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
    ) {
      return "";
    }
    return path.slice(startDot, end);
  },

  format(pathObject) {
    return formatWith("\\", pathObject);
  },

  parse(path) {
    validateString(path, "path");

    const ret = { root: "", dir: "", base: "", ext: "", name: "" };
    if (path.length === 0) return ret;

    const len = path.length;
    let rootEnd = 0;
    let code = path.charCodeAt(0);

    if (len === 1) {
      if (isPathSeparator(code)) {
        ret.root = ret.dir = path;
        return ret;
      }
      ret.base = ret.name = path;
      return ret;
    }

    // Try to match a root.
    if (isPathSeparator(code)) {
      // Possible UNC root.
      rootEnd = 1;
      if (isPathSeparator(path.charCodeAt(1))) {
        // Matched double path separator at beginning.
        let j = 2;
        let last = j;
        while (j < len && !isPathSeparator(path.charCodeAt(j))) j++;
        if (j < len && j !== last) {
          last = j;
          while (j < len && isPathSeparator(path.charCodeAt(j))) j++;
          if (j < len && j !== last) {
            last = j;
            while (j < len && !isPathSeparator(path.charCodeAt(j))) j++;
            if (j === len) {
              // We matched a UNC root only.
              rootEnd = j;
            } else if (j !== last) {
              // We matched a UNC root with leftovers.
              rootEnd = j + 1;
            }
          }
        }
      }
    } else if (isWindowsDeviceRoot(code) && path.charCodeAt(1) === CHAR_COLON) {
      // Possible device root.
      if (len <= 2) {
        ret.root = ret.dir = path;
        return ret;
      }
      rootEnd = 2;
      if (isPathSeparator(path.charCodeAt(2))) {
        if (len === 3) {
          ret.root = ret.dir = path;
          return ret;
        }
        rootEnd = 3;
      }
    }

    if (rootEnd > 0) ret.root = path.slice(0, rootEnd);

    let startDot = -1;
    let startPart = rootEnd;
    let end = -1;
    let matchedSlash = true;
    let i = path.length - 1;
    let preDotState = 0;

    for (; i >= rootEnd; --i) {
      code = path.charCodeAt(i);
      if (isPathSeparator(code)) {
        if (!matchedSlash) {
          startPart = i + 1;
          break;
        }
        continue;
      }
      if (end === -1) {
        matchedSlash = false;
        end = i + 1;
      }
      if (code === CHAR_DOT) {
        if (startDot === -1) startDot = i;
        else if (preDotState !== 1) preDotState = 1;
      } else if (startDot !== -1) {
        preDotState = -1;
      }
    }

    if (end !== -1) {
      if (
        startDot === -1 ||
        preDotState === 0 ||
        (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
      ) {
        ret.base = ret.name = path.slice(startPart, end);
      } else {
        ret.name = path.slice(startPart, startDot);
        ret.base = path.slice(startPart, end);
        ret.ext = path.slice(startDot, end);
      }
    }

    // For roots, `dir` includes the trailing separator; otherwise strip it.
    if (startPart > 0 && startPart !== rootEnd) ret.dir = path.slice(0, startPart - 1);
    else ret.dir = ret.root;

    return ret;
  },

  sep: "\\",
  delimiter: ";",
  win32: null,
  posix: null,
};

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

posix.win32 = win32.win32 = win32;
posix.posix = win32.posix = posix;

// Legacy internal API (DEP0080), kept for parity with Node.
posix._makeLong = posix.toNamespacedPath;
win32._makeLong = win32.toNamespacedPath;

module.exports = isWindows ? win32 : posix;
