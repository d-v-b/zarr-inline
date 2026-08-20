# zarr-json (TypeScript)

Store a Zarr v3 hierarchy as a single JSON object. `ZarrJsonStore` is a
read-write [zarrita](https://github.com/manzt/zarrita.js) store (the
`AsyncMutable` interface from `@zarrita/storage`, including `getRange`
partial reads) whose entire contents live in one JSON document — metadata
keys (`zarr.json` or `*/zarr.json`) hold inline JSON metadata; all other
keys hold base64-encoded bytes or, for arrays using the `json` codec,
inline JSON arrays of decoded values.

See the spec: `../docs/superpowers/specs/2026-05-14-zarr-json-design.md`.

## Requirements

Node >= 21: the implementation parses integer literals losslessly (integers
beyond 2^53 become `BigInt`) via `JSON.parse` reviver source-text access, so
int64/uint64 data and big metadata integers survive exactly, matching the
Python and Rust implementations. `strictParse` throws a clear error on older
Node versions.

## Install / build

```bash
cd typescript && npm install && npm run build
```

## Usage

```ts
import * as zarr from "zarrita";
import { ZarrJsonStore, MemoryBacking, StringBacking } from "zarr-json";

// Build a hierarchy into an in-memory JSON object.
const backing = new MemoryBacking({});
const store = new ZarrJsonStore(backing);
const root = zarr.root(store);
await zarr.create(root);
const arr = await zarr.create(root.resolve("data"), {
  shape: [8],
  chunkShape: [4],
  dtype: "uint8",
});
await zarr.set(arr, null, {
  data: Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]),
  shape: [8],
  stride: [1],
});

// `backing.load()` is the JSON document — share it as one file.
const document = backing.load();

// Reload from a JSON string.
const store2 = new ZarrJsonStore(new StringBacking(JSON.stringify(document)));
const arr2 = await zarr.open(zarr.root(store2).resolve("data"), { kind: "array" });
```

## Legible chunks: the `json` codec

By default chunk bytes are opaque (base64). Arrays created with the `json`
array->bytes codec store their chunks as real JSON arrays in the document,
using the Zarr v3 `fill_value` scalar serialization elementwise (NaN becomes
`"NaN"`, Infinity becomes `"Infinity"`, and so on). Register it once with
zarrita's codec registry, then name it in the array's codec chain:

```ts
import { registerJsonCodec } from "zarr-json";

registerJsonCodec(); // registry.set("json", ...) on zarrita's global registry

const legible = await zarr.create(root.resolve("legible"), {
  shape: [4],
  chunkShape: [4],
  dtype: "float64",
  codecs: [{ name: "json", configuration: {} }],
});
await zarr.set(legible, null, {
  data: Float64Array.from([1.5, NaN, Infinity, -Infinity]),
  shape: [4],
  stride: [1],
});
// document now contains:  "legible/c/0": [1.5, "NaN", "Infinity", "-Infinity"]
```

Supported dtypes: int8/16/32, uint8/16/32, float32/64, bool, and
int64/uint64 (as BigInt) across their full ranges — values beyond 2^53
serialize as exact integer digits and parse back losslessly via
`strictParse` (Node >= 21). Decoding is strict, like zarr-python's
`from_json_scalar`: out-of-range or non-integer values for int dtypes,
dtype-range violations for int64/uint64, and non-boolean bool values all
throw; floats accept numbers plus the `"NaN"`/`"Infinity"`/`"-Infinity"`
strings.

The codec walks chunk elements via `chunk.stride` in C order of
`chunk.shape`, so the emitted JSON always nests the logical values.
Combining the `json` codec with a `transpose` codec is not currently
cross-compatible, though: zarr-python and zarrs nest transpose+json chunk
JSON by the *transposed* chunk shape (their array->bytes codecs see the
resolved shape), which zarrita does not expose to the codec. Both sides
fail loudly on the shape mismatch; use the `json` codec without
array->array codecs for portable documents.

## Backings

- `new MemoryBacking(document)` — the in-memory object is the source of truth.
- `new StringBacking(text)` — parses from a string; `dumps()` returns the
  current string.

Documents are re-keyed onto null-prototype objects on load, so keys like
`"__proto__"`, `"constructor"`, or `"toString"` are ordinary own
properties (on a plain object, assigning `"__proto__"` would hit the
inherited setter and silently drop the write). `StringBacking.load` also
rejects number literals that overflow float64 (`1e400`), which Python and
Rust refuse to parse.

## Validation

```ts
import { validate } from "zarr-json";

const issues = validate(document);          // lenient: returns a list
validate(document, { strict: true });       // strict: throws ValidationError
```

`validate` checks the two validity rules: **R1** well-formed keys and **R2**
per-value type (metadata keys map to objects; byte keys map to base64
strings or inline JSON arrays).

## Conformance harness

```bash
echo '{"zarr.json": {"a": 1}}' | node dist/conformance.js
```

Reads a document on stdin, writes `{"issues", "decoded", "reencoded",
"errors"}` on stdout per
`../docs/superpowers/specs/2026-08-20-conformance-protocol.md`. Keys that
pass validation but fail to decode (e.g. a byte key whose string is not
valid base64) land in `"errors"`; documents containing number literals
that overflow float64 (like `1e400`) are rejected outright, matching
Python and Rust.

The canonical serializer is hand-rolled rather than `JSON.stringify`:
numbers follow RFC 8785 (ES `Number::toString`, so negative zero prints
`0`), bigint values print as exact digits, and it throws on non-finite
numbers and on lone surrogates (which have no UTF-8 encoding) — cases the
conformance protocol's document constraints declare non-portable.

Known cross-language caveats (documented in the protocol): JavaScript
objects reorder integer-like member names; the cross-implementation
property test avoids such keys. Numbers carry no caveats — integers of
any size and the full float64 range are portable.

## Crosscheck harness

```bash
node dist/crosscheck.js write < payload.json   # payload -> document
node dist/crosscheck.js read < document.json   # document -> payload
```

The array-layer harness from
`../docs/superpowers/specs/2026-08-20-crosscheck-protocol.md`: `write`
drives zarrita over a `ZarrJsonStore` to build a hierarchy of json-codec
arrays from a payload, `read` opens every array in a document and reports
its values using the `fill_value` scalar serialization. The Python test
orchestrator (`python/tests/test_crosscheck.py`) runs the full
writer × reader matrix across zarr-python, zarrita, and zarrs.

## Tests

```bash
cd typescript && npm test
```
