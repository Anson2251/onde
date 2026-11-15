#!/usr/bin/env bash
# Regenerate the test-only TLS material in this directory.
#
#   ./generate.sh
#
# The CA and the server certificate are committed so Rust and JavaScript tests can run without
# shelling out to openssl. They are valid for 100 years, which keeps the corpus stable, and they
# are test-only: never trust `ca-cert.pem` anywhere. See README.md.
set -euo pipefail
cd "$(dirname "$0")"

# --- the test CA ------------------------------------------------------------------------------
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 36500 \
  -keyout ca-key.pem -out ca-cert.pem \
  -subj "/CN=onde test CA/O=onde test" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"

# --- the server certificate (localhost + loopback, so name checking is testable) --------------
openssl req -newkey rsa:2048 -sha256 -nodes \
  -keyout server-key.pem -out server.csr \
  -subj "/CN=localhost/O=onde test"

cat > server.ext <<'EXT'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1
EXT

openssl x509 -req -in server.csr -CA ca-cert.pem -CAkey ca-key.pem -CAcreateserial \
  -days 36500 -sha256 -extfile server.ext -out server-cert.pem

# --- an unrelated CA, used to test that a bad `ca` option fails verification -------------------
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 36500 \
  -keyout other-ca-key.pem -out other-ca-cert.pem \
  -subj "/CN=onde unrelated test CA/O=onde test" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"

rm -f server.csr server.ext ca-cert.srl other-ca-cert.srl
