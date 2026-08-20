# Cross-Implementation Conformance Protocol

**Date:** 2026-08-20
**Status:** Adopted

Each implementation (Python, TypeScript, Rust) ships a **conformance
harness**: a CLI that reads a zarr-json document on stdin and writes a
report on stdout. The Python property test
(`python/tests/test_conformance_property.py`) generates documents with
Hypothesis and requires all three reports to agree.

## Shared semantics being tested

**Canonical JSON serialization** (used for metadata and inline-array
decode, and for the inline check on encode):

- No whitespace (`,` and `:` separators).
- Non-ASCII characters are NOT escaped (output is UTF-8).
- Object member order is preserved as given (no sorting).
- No `NaN` / `Infinity` tokens — serialization of a non-finite number is an
  error (the fill_value convention uses strings like `"NaN"` instead).
- Numbers per **RFC 8785 (JCS) section 3.2.2.3**: floats are formatted
  with ECMAScript `Number::toString` semantics (integral floats print
  without a decimal point, `1.0` -> `1`; negative zero prints `0`, so the
  sign of -0.0 is NOT preserved; exponents are unpadded, `1e-7`; fixed
  notation within [1e-6, 1e21)); integers print as digits at any size
  (identical to the float form for every safe integer; the integer
  literal `-0` normalizes to `0`). Integer digits survive exactly at ANY
  size in all three implementations: Python natively, TypeScript via
  BigInt (JSON.parse reviver source access, Node >= 21), Rust via
  serde_json's arbitrary_precision raw tokens. Unlike full JCS, object
  member names are NOT sorted — insertion order is preserved. JavaScript
  gets float formatting for free; Python and Rust implement ES ToString
  explicitly.
- **JS caveat:** JavaScript objects reorder integer-like member names; the
  property test avoids integer-like object keys in metadata/attributes.

**Key classification:** `is_metadata_key(key)` iff `key == "zarr.json"` or
`key` ends with `"/zarr.json"`.

**decode_value(key, value) -> bytes:**
- metadata key: value must be a JSON object; return canonical UTF-8 bytes.
- byte key, array value: return canonical UTF-8 bytes.
- byte key, string value: strict standard base64 decode (standard
  alphabet only, padding required; non-zero trailing padding bits are
  accepted, matching Python's `b64decode(validate=True)`).
- anything else: error.

**encode_value(key, bytes) -> value:**
- metadata key: parse bytes as JSON; must be an object.
- byte key: if the bytes parse as JSON to an array whose canonical
  serialization is byte-identical to the input, store that array (lossless
  inline); otherwise store standard base64 (with padding) of the bytes.

**Validator:** R1 (well-formed key: non-empty, no leading/trailing `/`, no
empty / `.` / `..` segments) checked first; R2 (metadata key -> object;
byte key -> string or array) only for keys passing R1. At most one issue
per key.

## Harness CLI

- **Input:** stdin, one JSON object (the document). Non-object input:
  message on stderr, exit code 1.
- **Output:** stdout, one JSON object; non-ASCII unescaped:

```json
{
  "issues": [{"rule": "R1", "key": "..."}],
  "decoded": {"<key>": "<base64 of decode_value(key, value)>"},
  "reencoded": {"<key>": <encode_value(key, decoded bytes)>},
  "errors": ["<key>"]
}
```

- `issues`: all validator issues, sorted by `(key, rule)`.
- `decoded` / `reencoded`: every issue-free key that decodes, any order
  (compared structurally).
- `errors`: keys that passed validation but failed decode_value (e.g. a
  byte key whose string is not valid base64), sorted. A decode failure on
  one key must not abort the report.

## Document constraints (portable input space)

Behavior outside these bounds is implementation-defined; the property test
does not generate such documents, and portable documents must not contain:

- **Non-finite number literals**, including overflow like `1e999`
  (Python and Rust reject the document; JavaScript's JSON.parse silently
  produces Infinity).
- **Nesting deeper than 100 levels** (serde_json's recursion limit is 128;
  CPython's is higher but finite).
- **Lone surrogates** in any string (serde_json rejects the document;
  Python parses but cannot UTF-8-encode; JS TextEncoder silently replaces
  with U+FFFD).
- **A UTF-8 BOM** (Python strips it; serde_json rejects it).

## Invocations

| Impl | Build | Run |
|---|---|---|
| Python | `cd python && uv sync` | `uv run python -m zarr_json.conformance` |
| TypeScript | `cd typescript && npm install && npm run build` | `node typescript/dist/conformance.js` |
| Rust | `cd rust && cargo build` | `rust/target/debug/conformance` |

Agreement = structural equality of the three parsed reports (`decoded`
values are base64 strings, so byte-level agreement is still exact).
