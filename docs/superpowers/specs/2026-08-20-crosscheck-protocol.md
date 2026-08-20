# Cross-Language Array Crosscheck Protocol

**Date:** 2026-08-20
**Status:** Adopted

The conformance harness tests the *container* layer. The crosscheck harness
tests the *array* layer across host libraries: every implementation can
write a hierarchy of json-codec arrays as a zarr-json document, and every
implementation can read back the values from a document written by any
other. The pytest orchestrator (`python/tests/test_crosscheck.py`) runs the
full writer x reader matrix (zarr-python, zarrita, zarrs — 9 combinations)
against a fixed payload and requires the values read to equal the values
written.

## Payload

A JSON object:

```json
{
  "arrays": [
    {
      "path": "myarray",
      "dtype": "<Zarr v3 data_type name>",
      "shape": [2, 4],
      "chunks": [2, 4],
      "data": <nested JSON, C order, fill_value scalar conventions>
    }
  ]
}
```

- `dtype` is a Zarr v3 data type name. The portable set every
  implementation must support: `uint8`, `int32`, `int64`, `float32`,
  `float64`, `bool`.
- `data` uses the Zarr v3 `fill_value` scalar serialization elementwise
  (`"NaN"` / `"Infinity"` / `"-Infinity"` strings for non-finite floats),
  nested by `shape` in C order.
- Constraints on portable payloads (the documented cross-language limits):
  no `-0.0` (its sign is not preserved by RFC 8785 canonical numbers);
  floats exactly representable in the target dtype. int64/uint64 values
  are portable across their full ranges.

## Harness modes

- **write**: read a payload on stdin; create a root group and, for each
  entry, an array at `path` with the `json` array->bytes codec and no
  compressors, through the host Zarr library; write `data`; output the
  resulting zarr-json document on stdout.
- **read**: read a zarr-json document on stdin; discover arrays (keys
  `<path>/zarr.json` whose value has `"node_type": "array"`), sorted by
  path; open each through the host Zarr library; output a payload on
  stdout with `dtype`, `shape`, `chunks` (from metadata) and `data`
  (values converted elementwise with the fill_value serialization).

Errors: message on stderr, exit code 1.

## Invocations

| Impl | Write | Read |
|---|---|---|
| Python | `uv run python -m zarr_json.crosscheck write` | `... read` |
| TypeScript | `node typescript/dist/crosscheck.js write` | `... read` |
| Rust | `rust/target/debug/crosscheck write` | `... read` |

Agreement: for every (writer, reader) pair, parse the reader's payload and
compare structurally with the input payload (Python-side comparison, so
`1` and `1.0` compare equal — the known float-text divergence does not
apply at this layer; `"NaN"` strings keep non-finite comparisons exact).
