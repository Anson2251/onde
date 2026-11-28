# Developer entry points. The suites and the Rust workspace stay the source of truth; these
# targets are the discoverable, CI-shaped commands.
SHELL := /bin/bash
.DEFAULT_GOAL := help

OXLINT_VERSION ?= 1.95.0
OXFMT_VERSION ?= 0.80.0
# Prefer pnpx locally; GitHub runners have npx but not pnpm.
RUN_PKG ?= $(shell if command -v pnpx >/dev/null 2>&1; then echo pnpx; else echo npx --yes; fi)
OXLINT ?= $(RUN_PKG)
OXFMT ?= $(RUN_PKG)

SKIP ?=
VERSION := $(shell sed -n 's/^version = "\(.*\)"/\1/p' crates/ondec/Cargo.toml | head -1)
# Evaluated only by the targets that use it, after `release` has built ondec.
TUPLE = $(shell target/release/ondec sdk path | xargs basename)

.PHONY: help build release test test-all lint fmt fix check sdk sdk-stage sdk-verify clean distclean

help: ## print this list
	@echo onde $(VERSION)
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  %-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

build: ## debug build
	cargo build

release: ## release binaries for this host (onde, ondec, libonde.a)
	cargo build --release -p ln-cli -p ondec -p ln-embed

test: ## default suites; SKIP=ffi,proc skips names
	./test/run.sh $(if $(SKIP),--skip=$(SKIP),)

test-all: ## default suites plus net, standalone, stress, soak
	./test/run.sh --all

lint: ## rustfmt check, clippy, oxlint, oxfmt (same commands as CI)
	cargo fmt --all -- --check
	cargo clippy --all-targets -- -D warnings
	$(OXLINT) oxlint@$(OXLINT_VERSION) --deny-warnings js test
	$(OXFMT) oxfmt@$(OXFMT_VERSION) --check js test

fmt: ## apply rustfmt and oxfmt
	cargo fmt --all
	$(OXFMT) oxfmt@$(OXFMT_VERSION) js test

fix: fmt ## apply rustfmt, oxfmt and safe oxlint fixes
	$(OXLINT) oxlint@$(OXLINT_VERSION) --fix js test

check: lint test ## lint plus the default suites

sdk: release ## SDK for this host cell (onde.h + libonde-<tuple>.a + SHA256SUMS)
	./scripts/build-sdk.sh

# Each run writes one checksum fragment; the release job merges every cell's fragment. A rebuild
# replaces this cell's fragment instead of appending a second hash for the same file.
sdk-stage: sdk ## stage the host SDK as the flat assets ondec downloads
	@test -n "$(VERSION)" || { echo "make: cannot read the ondec version" >&2; exit 1; }
	@mkdir -p dist/release/v$(VERSION)
	cp "dist/sdk/$(VERSION)/$(TUPLE)/onde.h" \
	   "dist/sdk/$(VERSION)/$(TUPLE)/libonde-$(TUPLE).a" \
	   "dist/release/v$(VERSION)/"
	cd "dist/release/v$(VERSION)" && \
	  if command -v shasum >/dev/null 2>&1; then \
	    shasum -a 256 onde.h "libonde-$(TUPLE).a" > "SHA256SUMS.$(TUPLE)"; \
	  else \
	    sha256sum onde.h "libonde-$(TUPLE).a" > "SHA256SUMS.$(TUPLE)"; \
	  fi
	@cat dist/release/v$(VERSION)/SHA256SUMS.* | sort -u > "dist/release/v$(VERSION)/SHA256SUMS"

sdk-verify: sdk ## verify the host SDK's checksums and ABI stamp
	target/release/ondec sdk verify --sdk "dist/sdk/$(VERSION)/$(TUPLE)"

clean: ## remove cargo build output
	cargo clean

distclean: clean ## also remove dist/ (SDK and release staging)
	rm -rf dist
