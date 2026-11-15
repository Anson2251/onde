/**
 * The registry client: packuments and tarballs over `http`/`https`, nothing else.
 *
 * See `docs/tuckbox.md` §3 and §4. No `fs` beyond the optional cache directory; no dependency on
 * the resolver.
 *
 * The same promise-based request helper serves both protocols and both document types. It has no
 * connection pooling of its own (the runtime's default agent is used), no streaming decompression,
 * and no timeout: a registry that accepts a connection and then goes silent is the caller's
 * problem to bound. What it does guarantee is that every transport failure rejects the promise
 * instead of leaving it pending.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, join } from "node:path";

import type { Packument } from "../types";

export interface RegistryOptions {
  /** Defaults to `https://registry.npmjs.org`. */
  registry?: string;
  /** Long-lived cache for tarballs and packuments, or `undefined` for no cache. */
  cacheDir?: string;
  /** Sent as `user-agent`; registries use it for rate-limit policy. */
  userAgent?: string;
  /** Emit request lines. */
  verbose?: boolean;
}

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const DEFAULT_USER_AGENT = "tuckbox/0.1.0 (onde)";
const ACCEPT_PACKUMENT = "application/vnd.npm.install-v1+json";
const MAX_REDIRECTS = 5;
/** A cached packument older than this is refetched; npm's abbreviated documents move slowly. */
const PACKUMENT_TTL_MS = 5 * 60 * 1000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The error shape callers act on: a Node-style `code`, with `status` on HTTP failures. */
interface RegistryError extends Error {
  code: string;
  status?: number;
}

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

function fail(code: string, message: string, status?: number): RegistryError {
  const error = new Error(message) as RegistryError;
  error.code = code;
  if (status !== undefined) error.status = status;
  return error;
}

/**
 * One GET, collected into a single `Buffer`. `http` and `https` share the shape of `request`, so
 * the only branch is which module supplies it.
 */
function requestOnce(
  url: URL,
  headers: Record<string, string>,
  verbose: boolean | undefined,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      action();
    };

    const secure = url.protocol === "https:";
    if (!secure && url.protocol !== "http:") {
      reject(fail("EHTTP", `unsupported registry protocol ${url.protocol} in ${url.href}`));
      return;
    }

    if (verbose) process.stderr.write(`tuckbox: GET ${url.href}\n`);

    const hostname =
      url.hostname.startsWith("[") && url.hostname.endsWith("]")
        ? url.hostname.slice(1, -1)
        : url.hostname;
    const request = secure ? httpsRequest : httpRequest;
    let sawResponse = false;

    const req = request(
      {
        protocol: url.protocol,
        hostname,
        port: url.port === "" ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers,
      },
      (res) => {
        sawResponse = true;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer | string) => {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        });
        res.on("end", () => {
          settle(() =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
            }),
          );
        });
        // A connection reset mid-body emits `aborted`/`error` rather than `end`; without this the
        // promise would wait forever.
        res.on("aborted", () => {
          settle(() => reject(fail("EHTTP", `response aborted while reading ${url.href}`)));
        });
        res.on("error", (error: Error) => settle(() => reject(error)));
      },
    );

    // Covers ECONNREFUSED, DNS failures, TLS failures, and sockets that die before a response.
    // Once headers have arrived, `res` owns the failure handling (see `aborted`/`error` above).
    req.on("error", (error: Error) => settle(() => reject(error)));
    req.on("close", () => {
      if (sawResponse) return;
      settle(() => reject(fail("EHTTP", `connection closed before a response from ${url.href}`)));
    });
    req.end();
  });
}

/**
 * GET `start`, following up to five redirects. Relative `location` values resolve against the
 * URL that produced them, which is what both npm and its CDNs emit.
 */
async function fetchFollowingRedirects(
  start: URL,
  headers: Record<string, string>,
  verbose: boolean | undefined,
): Promise<RawResponse> {
  let url = start;
  let redirects = 0;

  for (;;) {
    const response = await requestOnce(url, headers, verbose);
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.location;
    if (location === undefined || location === "") {
      throw fail("EREDIRECT", `redirect without a location from ${url.href} (HTTP ${response.status})`, response.status);
    }
    if (redirects >= MAX_REDIRECTS) {
      throw fail(
        "EREDIRECT",
        `more than ${MAX_REDIRECTS} redirects fetching ${start.href} (last was ${url.href})`,
        response.status,
      );
    }
    redirects += 1;
    try {
      url = new URL(location, url);
    } catch {
      throw fail("EREDIRECT", `invalid redirect location ${JSON.stringify(location)} from ${url.href}`, response.status);
    }
  }
}

/** A parsed JSON value that has the one field every abbreviated packument must have. */
function isPackument(value: unknown): value is Packument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const versions = (value as { versions?: unknown }).versions;
  return typeof versions === "object" && versions !== null && !Array.isArray(versions);
}

function readPackumentCache(file: string): Packument | null {
  try {
    if (Date.now() - statSync(file).mtimeMs > PACKUMENT_TTL_MS) return null;
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isPackument(parsed) ? parsed : null;
  } catch {
    // Missing, unreadable, or corrupt: all mean "refetch", never "fail the install".
    return null;
  }
}

/** Best effort: a cache that cannot be written must not fail an otherwise good fetch. */
function writeCache(file: string, data: Buffer | string): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
  } catch {
    // Ignored on purpose; see above.
  }
}

/**
 * The cache file name for a tarball URL: its last path segment.
 *
 * The segment is already URL-encoded and cannot contain `/`, so it is safe to use as a file name.
 * An unusual URL with a trailing slash falls back to a stable name instead of an empty one.
 */
function tarballCacheName(url: URL): string {
  const name = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
  return name === "" ? "tarball" : name;
}

/**
 * Fetch the abbreviated packument for `name`.
 *
 * Sends `accept: application/vnd.npm.install-v1+json`; the full document is several times larger
 * and tuckbox reads none of the extra fields. Follows a redirect, and maps `404` to a
 * `Error` whose `code` is `ETARGET` ("no such package"), which is what a caller can act on.
 */
export async function getPackument(name: string, options: RegistryOptions = {}): Promise<Packument> {
  const encoded = encodeURIComponent(name);
  const cacheFile =
    options.cacheDir === undefined ? undefined : join(options.cacheDir, "packuments", `${encoded}.json`);

  if (cacheFile !== undefined) {
    const cached = readPackumentCache(cacheFile);
    if (cached !== null) return cached;
  }

  const registry = (options.registry ?? DEFAULT_REGISTRY).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(`${registry}/${encoded}`);
  } catch {
    throw fail("EHTTP", `invalid registry URL ${JSON.stringify(registry)}`);
  }

  const headers: Record<string, string> = {
    accept: ACCEPT_PACKUMENT,
    "user-agent": options.userAgent ?? DEFAULT_USER_AGENT,
  };

  const response = await fetchFollowingRedirects(url, headers, options.verbose);

  if (response.status === 404) {
    throw fail("ETARGET", `no such package ${name}: HTTP 404 from ${url.href}`, 404);
  }
  if (response.status < 200 || response.status > 299) {
    throw fail("EHTTP", `${name}: HTTP ${response.status} from ${url.href}`, response.status);
  }

  let packument: Packument;
  try {
    const parsed: unknown = JSON.parse(response.body.toString("utf8"));
    if (!isPackument(parsed)) throw new Error("not a packument");
    packument = parsed;
  } catch {
    throw fail("EBADPACKUMENT", `malformed packument for ${name} from ${url.href}`);
  }

  if (cacheFile !== undefined) writeCache(cacheFile, response.body);
  return packument;
}

/**
 * Download a tarball and return its bytes.
 *
 * Follows redirects; `404` becomes an `Error` whose `code` is `ETARBALL`. Honours `cacheDir` by
 * keying on the URL's file name, and re-validates a cached entry with the integrity check in the
 * store layer rather than trusting the cache.
 *
 * Memory: this returns the whole compressed tarball in one `Buffer`. Peak live memory is roughly
 * twice the tarball size while the received chunks are concatenated, plus the caller's gunzip
 * output; there is no streaming inflate yet (docs/tuckbox.md §4). The caller checks integrity
 * before anything is unpacked, so a poisoned cache is caught there, not here. Cached tarballs do
 * not expire: their bytes are content-addressed by the lockfile's integrity value.
 */
export async function getTarball(urlText: string, options: RegistryOptions = {}): Promise<Buffer> {
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw fail("EHTTP", `invalid tarball URL ${JSON.stringify(urlText)}`);
  }

  const cacheFile =
    options.cacheDir === undefined ? undefined : join(options.cacheDir, "tarballs", tarballCacheName(url));

  if (cacheFile !== undefined) {
    try {
      return readFileSync(cacheFile);
    } catch {
      // Not cached (or unreadable): fall through and fetch.
    }
  }

  const headers: Record<string, string> = {
    "user-agent": options.userAgent ?? DEFAULT_USER_AGENT,
  };
  const response = await fetchFollowingRedirects(url, headers, options.verbose);

  if (response.status === 404) {
    throw fail("ETARBALL", `tarball not found: ${url.href} (HTTP 404)`, 404);
  }
  if (response.status < 200 || response.status > 299) {
    throw fail("EHTTP", `${url.href}: HTTP ${response.status}`, response.status);
  }

  if (cacheFile !== undefined) writeCache(cacheFile, response.body);
  return response.body;
}
