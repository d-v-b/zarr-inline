# zarr-json (Rust)

Store a Zarr v3 hierarchy as a single JSON object. `ZarrJsonStore` is a
read-write store implementing `zarrs`'s storage traits
(`ReadableStorageTraits` + `WritableStorageTraits` + `ListableStorageTraits`,
and therefore `ReadableWritableListableStorageTraits`) whose entire contents
live in one JSON document — metadata keys (`zarr.json` or `*/zarr.json`) hold
inline JSON metadata; all other keys hold base64-encoded bytes or, for arrays
using the `json` codec, inline JSON arrays of decoded values.

See the spec: `../docs/superpowers/specs/2026-05-14-zarr-json-design.md`.

## Build

```bash
cd rust && cargo build
```

## Usage

```rust
use std::sync::Arc;
use zarrs::array::{data_type, ArrayBuilder};
use zarrs::group::GroupBuilder;
use zarrs::storage::ReadableWritableListableStorage;
use zarr_json::ZarrJsonStore;

// Build a hierarchy into an in-memory JSON object.
let store = Arc::new(ZarrJsonStore::new());
let storage: ReadableWritableListableStorage = store.clone();

GroupBuilder::new().build(storage.clone(), "/")?.store_metadata()?;
let array = ArrayBuilder::new(vec![8], vec![4], data_type::uint8(), 0u8)
    .build(storage.clone(), "/data")?;
array.store_metadata()?;
array.store_chunk(&[0], vec![0u8, 1, 2, 3])?;

// `store.document()` is the JSON document — share it as one file.
let document = store.document();
let text = store.to_json_string();

// Reload from a document (strict validation on construction).
let store2 = Arc::new(ZarrJsonStore::from_document(document)?);
```

## Legible chunks: the `json` codec

By default chunk bytes are opaque (base64). Arrays created with the `json`
array->bytes codec store their chunks as real JSON arrays in the document,
using the Zarr v3 `fill_value` scalar serialization elementwise (NaN becomes
`"NaN"`, complex becomes `[re, im]`, and so on):

```rust
use zarr_json::JsonCodec;

let array = ArrayBuilder::new(vec![4], vec![4], data_type::float64(), 0.0f64)
    .array_to_bytes_codec(Arc::new(JsonCodec::new()))
    .build(storage.clone(), "/legible")?;
array.store_metadata()?;
array.store_chunk(&[0], vec![1.5f64, f64::NAN, f64::INFINITY, -0.0])?;
// document now contains:  "legible/c/0": [1.5, "NaN", "Infinity", -0.0]
```

The codec registers itself with `zarrs`'s codec plugin registry under the
name `json`, so arrays whose metadata names the codec can be opened without
further setup. Unlike zarr-python, `zarrs` does not append a default
compressor after an explicit array->bytes codec, so no extra flag is needed
to keep chunks legible.

## Validation

```rust
use zarr_json::{validate, validator::validate_strict};

let issues = validate(&document);      // lenient: returns a Vec of issues
validate_strict(&document)?;           // strict: errors on any issue
```

`validate` checks the two validity rules: **R1** well-formed keys and **R2**
per-value type (metadata keys map to objects; byte keys map to base64 strings
or inline JSON arrays). `ZarrJsonStore::from_document` validates strictly;
`from_document_lenient` returns the issues as diagnostics instead.

## Conformance harness

`cargo build` produces `target/debug/conformance`, the CLI described in
`../docs/superpowers/specs/2026-08-20-conformance-protocol.md`: it reads a
zarr-json document on stdin and writes a report (validator issues, decoded
bytes as base64, re-encoded values) on stdout. The harness uses only the
codec and validator modules, which have no zarrs dependency; if zarrs ever
fails to build, `cargo build --no-default-features` still produces the
harness.

## Tests

```bash
cd rust && cargo test
```

This runs the unit tests, every shared fixture in `../examples` (via
`MANIFEST.json`), and integration tests that drive `zarrs` itself through
`ZarrJsonStore`.
