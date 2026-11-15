/**
 * A tar reader for npm tarballs, which are POSIX ustar produced by `npm pack` (`portable: true`).
 *
 * Filled in by the tarball workstream; see `docs/tuckbox.md` §4. Pure: no `fs`.
 */

import type { TarEntry } from "../types";

/** Every tar record starts on one of these. */
const BLOCK_SIZE = 512;

/** Thrown for an archive tuckbox refuses to write to disk. `code` is stable for tests. */
export class TarError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TarError";
    this.code = code;
  }
}

/** The `TarEntry` variants this reader can emit. */
type EntryType = TarEntry["type"];

/**
 * Pax values waiting to be applied. Pax (`x`/`g`) and GNU long-name (`L`/`K`) headers are
 * metadata for the *next* real entry, not entries themselves, so they are staged here.
 */
interface Overrides {
  path?: string;
  linkname?: string;
  size?: number;
}

/** Round a payload length up to whole blocks; padding is zero bytes the archive still owns. */
function paddedSize(size: number): number {
  return Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
}

/** Read a NUL-terminated (or full-width) tar string field as UTF-8. */
function fieldString(block: Buffer, start: number, end: number): string {
  let stop = start;
  while (stop < end && block.readUInt8(stop) !== 0) stop += 1;
  return block.toString("utf8", start, stop);
}

/**
 * Parse an octal field, or a base-256 field when the high bit of the first byte is set.
 *
 * Base-256 is how GNU tar stores values that do not fit the octal width (a size above 8 GiB, for
 * example); the marker bit is masked off and the remaining bits are a big-endian integer.
 */
function parseNumber(block: Buffer, start: number, end: number, what: string): number {
  const first = block.readUInt8(start);
  if ((first & 0x80) !== 0) {
    let value = first & 0x7f;
    for (let i = start + 1; i < end; i += 1) {
      value = value * 256 + block.readUInt8(i);
      if (!Number.isSafeInteger(value)) {
        throw new TarError("ETARBALL", `tar ${what} exceeds the safe integer range`);
      }
    }
    if (value < 0) throw new TarError("ETARBALL", `tar ${what} is negative`);
    return value;
  }

  // Octal fields are historically space-padded on the left and NUL/space-padded on the right.
  const text = block
    .toString("ascii", start, end)
    .replace(/^ +/, "")
    .replace(/[\0 ]+$/, "");
  if (text.length === 0) return 0;
  if (!/^[0-7]+$/.test(text)) {
    throw new TarError("ETARBALL", `tar ${what} is not octal: ${JSON.stringify(text)}`);
  }
  const value = parseInt(text, 8);
  if (!Number.isSafeInteger(value)) {
    throw new TarError("ETARBALL", `tar ${what} exceeds the safe integer range`);
  }
  return value;
}

/** Read one entry payload, rejecting both a short data area and a short padding area. */
function readPayload(tar: Buffer, offset: number, size: number, what: string): Buffer {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new TarError("ETARBALL", `tar ${what} has an invalid size`);
  }
  if (size > tar.length - offset) {
    throw new TarError("ETRUNCATED", `tar ends inside the ${what} (need ${size} bytes)`);
  }
  // The archive owns padding up to the next block boundary; missing it means the byte stream was
  // cut, even though every content byte happened to be present.
  if (paddedSize(size) > tar.length - offset) {
    throw new TarError("ETRUNCATED", `tar ends inside the padding after the ${what}`);
  }
  return tar.subarray(offset, offset + size);
}

/** Whether this is the all-zero block that starts the end-of-archive marker. */
function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < BLOCK_SIZE; i += 1) {
    if (block.readUInt8(i) !== 0) return false;
  }
  return true;
}

/** Parse `LEN key=value\n` pax records and stage the values this reader understands. */
function parsePax(payload: Buffer, overrides: Overrides): void {
  let offset = 0;
  while (offset < payload.length) {
    // Pax payloads are sized exactly, but tolerate NUL padding on the tail.
    if (payload.readUInt8(offset) === 0) break;

    let space = offset;
    while (space < payload.length && payload.readUInt8(space) !== 0x20) {
      const byte = payload.readUInt8(space);
      if (byte < 0x30 || byte > 0x39) {
        throw new TarError("ETARBALL", "malformed pax record: length is not decimal");
      }
      space += 1;
    }
    if (space >= payload.length) {
      throw new TarError("ETARBALL", "malformed pax record: no length separator");
    }

    const length = parseInt(payload.toString("ascii", offset, space), 10);
    if (
      !Number.isSafeInteger(length) ||
      length <= space - offset ||
      offset + length > payload.length
    ) {
      throw new TarError("ETARBALL", "malformed pax record: bad length");
    }

    // LEN includes the length digits, the space and the trailing newline.
    let record = payload.toString("utf8", space + 1, offset + length);
    if (record.endsWith("\n")) record = record.slice(0, -1);
    const equals = record.indexOf("=");
    if (equals <= 0) {
      throw new TarError("ETARBALL", "malformed pax record: expected key=value");
    }
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1);
    if (key === "path") {
      overrides.path = value;
    } else if (key === "linkpath") {
      overrides.linkname = value;
    } else if (key === "size") {
      if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new TarError("ETARBALL", "malformed pax record: bad size");
      }
      overrides.size = Number(value);
    }
    // Other pax keys (mtime, uid, ...) do not affect what tuckbox writes.

    offset += length;
  }
}

/**
 * Normalize an archive path into the shape tuckbox stores, and reject anything that could escape
 * the destination directory.
 *
 * `npm pack` puts every entry under `package/`; a single leading component is stripped so the
 * store directory itself is the package root.
 */
function normalizePath(raw: string): string {
  if (raw.startsWith("/")) {
    throw new TarError("ETARUNSAFE", `absolute path in tar: ${JSON.stringify(raw)}`);
  }

  let path = raw.replace(/\/+/g, "/");
  // `./package/x` and `././x` both appear in the wild; a leading `./` means "this directory".
  while (path.startsWith("./")) path = path.slice(2);

  if (path === "package") {
    path = "";
  } else if (path.startsWith("package/")) {
    path = path.slice("package/".length);
  }

  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      throw new TarError("ETARUNSAFE", `parent path segment in tar: ${JSON.stringify(raw)}`);
    }
    segments.push(segment);
  }

  // `""` means the archive root itself. The caller decides whether that is legal for its type.
  return segments.join("/");
}

/** Map a typeflag to the entry shape, rejecting everything that is not a plain file/dir/link. */
function entryType(typeflag: number): EntryType {
  switch (typeflag) {
    case 0x00: // NUL, the original tar spelling of a regular file
    case 0x30: // "0"
      return "file";
    case 0x35: // "5"
      return "dir";
    case 0x32: // "2"
      return "symlink";
    case 0x31: // "1"
      return "hardlink";
    default: {
      const shown = typeflag >= 0x20 && typeflag < 0x7f
        ? JSON.stringify(String.fromCharCode(typeflag))
        : `0x${typeflag.toString(16)}`;
      throw new TarError(
        "ETARUNSAFE",
        `unsupported tar typeflag ${shown} (expected a regular file, directory, symlink or hardlink)`,
      );
    }
  }
}

/**
 * Read every entry out of an uncompressed tar buffer.
 *
 * Must handle: the `prefix` field for paths over 100 bytes, pax extended headers (`x`/`g`) for
 * long paths and link targets, GNU long name/link (`L`/`K`), and base-256 sizes. Must strip a
 * leading `package/` component, normalize `./` and repeated slashes, and throw `TarError` with
 * code `ETARUNSAFE` for absolute paths, `..` segments, and unsupported typeflags.
 */
export function list(tar: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  // Metadata staged by pax / GNU long-name headers for the next real entry.
  let overrides: Overrides = {};
  let longName: string | null = null;
  let longLink: string | null = null;

  while (offset < tar.length) {
    if (tar.length - offset < BLOCK_SIZE) {
      // The archive may stop exactly on a block boundary, but a partial header/padding block is
      // a truncated stream rather than a clean end.
      throw new TarError(
        "ETRUNCATED",
        `tar ends with a partial block (${tar.length - offset} bytes) at offset ${offset}`,
      );
    }

    const header = tar.subarray(offset, offset + BLOCK_SIZE);
    offset += BLOCK_SIZE;

    // A zero block is the end-of-archive marker. A single one is accepted: the tail may have
    // been truncated after the marker's first block.
    if (isZeroBlock(header)) break;

    const rawName = fieldString(header, 0, 100);
    const prefix = fieldString(header, 345, 500);
    const headerName = prefix.length > 0 ? `${prefix}/${rawName}` : rawName;
    const headerSize = parseNumber(header, 124, 136, "size");
    const mode = parseNumber(header, 100, 108, "mode") & 0o7777;
    const typeflag = header.readUInt8(156);
    const headerLinkname = fieldString(header, 157, 257);

    if (typeflag === 0x78 || typeflag === 0x67) {
      // "x" applies to the next entry; "g" is defined as global, but the fields tuckbox consumes
      // are per-entry metadata and are staged the same way.
      const payload = readPayload(tar, offset, headerSize, "pax header");
      parsePax(payload, overrides);
      offset += paddedSize(headerSize);
      continue;
    }

    if (typeflag === 0x4c || typeflag === 0x4b) {
      // GNU long name/link: this header's payload is the string for the *next* header, which is
      // the real entry. The header itself is never emitted.
      const payload = readPayload(tar, offset, headerSize, "GNU long name");
      const value = payload.toString("utf8").replace(/\0+$/, "");
      if (typeflag === 0x4c) {
        longName = value;
      } else {
        longLink = value;
      }
      offset += paddedSize(headerSize);
      continue;
    }

    // A pax `size` wins over the header field, which is why it is read before the payload.
    const size = overrides.size ?? headerSize;
    const payload = readPayload(tar, offset, size, "entry data");
    offset += paddedSize(size);

    const type = entryType(typeflag);
    const rawPath = overrides.path ?? longName ?? headerName;
    // `linkname` is meaningful only for the two link types; the field is padding for the rest.
    const linkname =
      type === "symlink" || type === "hardlink"
        ? overrides.linkname ?? longLink ?? headerLinkname
        : "";

    const path = normalizePath(rawPath);
    if (path === "") {
      // `package/` as an explicit directory entry. `npm pack` does not emit one, but other
      // packers do, and it describes the root tuckbox is already writing into - so it is
      // skipped. Anything else that normalizes to nothing is a nameless entry, which is unsafe.
      if (type === "dir") {
        overrides = {};
        longName = null;
        longLink = null;
        continue;
      }
      throw new TarError("ETARUNSAFE", `empty path after normalization: ${JSON.stringify(rawPath)}`);
    }

    entries.push({
      path,
      type,
      mode,
      data: type === "file" ? payload : null,
      linkname,
    });

    overrides = {};
    longName = null;
    longLink = null;
  }

  return entries;
}
