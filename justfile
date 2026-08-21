set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

# List available project commands.
default:
    @just --list

# Install the locked Python environment.
setup-python:
    cd python && uv sync

# Install the locked TypeScript environment.
setup-typescript:
    cd typescript && npm ci

# Run Python's implementation-specific tests.
test-python: setup-python
    cd python && uv run pytest -q --ignore=tests/test_conformance_property.py --ignore=tests/test_crosscheck.py

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
    cd rust && cargo build --no-default-features --bin conformance

# Build every cross-implementation test harness.
build-harnesses: setup-python setup-typescript
    cd typescript && npm run build
    cd rust && cargo build --bins

# Compare validation, decoding, and encoding across implementations.
cross-conformance: build-harnesses
    cd python && ZARR_JSON_REQUIRE_HARNESSES=1 uv run pytest -q tests/test_conformance_property.py

# Run the whole-array writer x reader matrix and OME fixture.
cross-arrays: build-harnesses
    cd python && ZARR_JSON_REQUIRE_HARNESSES=1 uv run pytest -q \
      tests/test_crosscheck.py::test_writer_reader_matrix \
      tests/test_crosscheck.py::test_all_implementations_read_the_ome_zarr_example

# Run fixed and generated serialized operation traces.
cross-traces: build-harnesses
    cd python && ZARR_JSON_REQUIRE_HARNESSES=1 uv run pytest -q --hypothesis-show-statistics \
      tests/test_crosscheck.py::test_operation_trace_writer_reader_matrix \
      tests/test_crosscheck.py::test_generated_operation_traces

# Run all cross-implementation conformance phases.
cross: cross-conformance cross-arrays cross-traces

# Run every local and cross-implementation check.
check: test-python test-typescript test-rust lint-rust build-rust-conformance-minimal cross
