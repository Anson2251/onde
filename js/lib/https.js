"use strict";

// `https` — the same surfaces as `http`, minus the transport.
//
// TLS lands with WP6. Until then every operation that would have to negotiate TLS throws the
// host's `ERR_FEATURE_UNAVAILABLE` synchronously: connecting in plaintext while the caller asked
// for TLS is a security bug, not a compatibility gap (m4-plan §2.5). The classes exist so shape
// checks and `instanceof` work, but `Server#listen`, `request` and `get` refuse to run.

const EMBEDDED = typeof __filename === "string" && __filename.startsWith("<lite:");

function requireInternal(name, relative) {
  if (EMBEDDED) return require(name);
  return require(relative);
}

const http = requireInternal("http", "./http.js");

function featureUnavailable(operation) {
  const error = new Error(
    `TLS is not implemented yet: https.${operation} would have to negotiate TLS, so it is ` +
      "refused instead of silently connecting in plaintext",
  );
  error.code = "ERR_FEATURE_UNAVAILABLE";
  return error;
}

class Agent extends http.Agent {}

const globalAgent = new Agent({ keepAlive: true });

class Server extends http.Server {
  constructor(options, requestListener) {
    super(options, requestListener);
    this._tlsOptions = options === undefined || options === null ? {} : options;
  }

  listen() {
    throw featureUnavailable("Server#listen");
  }
}

function createServer(options, requestListener) {
  if (typeof options === "function") {
    requestListener = options;
    options = undefined;
  }
  return new Server(options, requestListener);
}

function request() {
  throw featureUnavailable("request");
}

function get() {
  throw featureUnavailable("get");
}

module.exports = {
  STATUS_CODES: http.STATUS_CODES,
  METHODS: http.METHODS,
  maxHeaderSize: http.maxHeaderSize,
  Agent,
  globalAgent,
  Server,
  ClientRequest: http.ClientRequest,
  ServerResponse: http.ServerResponse,
  IncomingMessage: http.IncomingMessage,
  OutgoingMessage: http.OutgoingMessage,
  _connectionListener: http._connectionListener,
  createServer,
  request,
  get,
  validateHeaderName: http.validateHeaderName,
  validateHeaderValue: http.validateHeaderValue,
};
