set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

# List available project commands.
default:
    @just --list

# Install the locked Python environment.
setup-python:
    cd python && uv sync

# Install the documentation environment.
setup-docs:
    cd python && uv sync --group docs

# Build the project documentation with warnings treated as errors.
docs-check: setup-docs
    cd python && uv run --group docs mkdocs build --strict --clean --config-file ../mkdocs.yml

# Serve the project documentation locally.
docs-serve: setup-docs
    cd python && uv run --group docs mkdocs serve --config-file ../mkdocs.yml

# Install the locked TypeScript environment.
setup-typescript:
    cd typescript && npm ci

# Run Python's implementation-specific tests.
test-python: setup-python
    cd python && uv run pytest -q --ignore=tests/test_conformance_property.py

# Run TypeScript's implementation-specific tests.
test-typescript: setup-typescript
    cd typescript && npm test

# Run Rust's implementation-specific tests.
test-rust:
    cd rust && cargo test

# Require warning-free Rust code.
lint-rust:
    cd rust && cargo clippy --all-targets -- -D warnings

# Ensure the container conformance CLI builds without the zarrs feature.
build-rust-conformance-minimal:
    cd rust && cargo build --no-default-features --bin zarr-inline-conformance

# Build every cross-implementation test harness.
build-harnesses: setup-python setup-typescript
    cd typescript && npm run build
    cd rust && cargo build --bins
    cd crosscheck/python && uv sync
    cd crosscheck/typescript && npm install --no-audit --no-fund && npm run build
    cd crosscheck/rust && cargo build

# Compare validation, decoding, and encoding across implementations.
cross-conformance: build-harnesses
    cd python && ZARR_INLINE_REQUIRE_HARNESSES=1 uv run pytest -q tests/test_conformance_property.py

# Run the whole-array writer x reader matrix and OME fixture (every
# crosscheck test that is not a trace test, so new tests are never skipped).
cross-arrays: build-harnesses
    cd crosscheck/python && ZARR_INLINE_REQUIRE_HARNESSES=1 uv run pytest -q \
      tests/test_crosscheck.py -k "not trace"

# Run fixed, generated, and must-reject serialized operation traces.
cross-traces: build-harnesses
    cd crosscheck/python && ZARR_INLINE_REQUIRE_HARNESSES=1 uv run pytest -q --hypothesis-show-statistics \
      tests/test_crosscheck.py -k "trace"

# Run all cross-implementation conformance phases.
cross: cross-conformance cross-arrays cross-traces

# Build and verify each standalone release artifact.
check-release-artifacts: setup-python setup-typescript
    python_dist_dir="$(mktemp -d /tmp/zarr-inline-python-dist.XXXXXX)" && cd python && uv build --out-dir "$python_dist_dir" && uv run --isolated --no-project --with "$python_dist_dir"/*.whl python -c "import zarr_inline"
    cd typescript && npm publish --dry-run
    package_smoke_dir="$(mktemp -d /tmp/zarr-inline-npm-smoke.XXXXXX)" && cd typescript && npm pack --pack-destination "$package_smoke_dir" && npm install --prefix "$package_smoke_dir/consumer" "$package_smoke_dir"/*.tgz && cd "$package_smoke_dir/consumer" && node --input-type=module -e 'import("zarr-inline").then((module) => { if (typeof module.ZarrInlineStore !== "function") process.exit(1) })'
    cd rust && cargo package --allow-dirty
    cd rust && crate_version="$(cargo metadata --no-deps --format-version=1 | python3 -c 'import json, sys; print(json.load(sys.stdin)["packages"][0]["version"])')" && cargo test --manifest-path "target/package/zarr-inline-$crate_version/Cargo.toml"

# Run every local, cross-implementation, and release-artifact check.
check: docs-check test-python test-typescript test-rust lint-rust build-rust-conformance-minimal cross check-release-artifacts
