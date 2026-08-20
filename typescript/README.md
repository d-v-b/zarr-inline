# zarr-json (TypeScript)

Store a Zarr v3 hierarchy as a single JSON object. `ZarrJsonStore` is a
read-write [zarrita](https://github.com/manzt/zarrita.js) store (the
`AsyncMutable` interface from `@zarrita/storage`, including `getRange`
partial reads) whose entire contents live in one JSON document — metadata
keys (`zarr.json` or `*/zarr.json`) hold inline JSON metadata; all other
keys hold base64-encoded bytes or, for arrays using the `json` codec,
inline JSON arrays of decoded values.

See the spec: `../docs/superpowers/specs/2026-05-14-zarr-json-design.md`.

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
int64/uint64 (as BigInt). int64/uint64 values beyond
`Number.MAX_SAFE_INTEGER` throw on encode — the known int64-in-JS
limitation, inherited from the `fill_value` convention (plain `JSON.parse`
cannot round-trip integers beyond 2^53 either). Decoding is strict, like
zarr-python's `from_json_scalar`: out-of-range or non-integer values for
int dtypes, non-safe integers for int64/uint64 (a peer's
`9007199254740993` has already been rounded by `JSON.parse`, so it errors
loudly instead of silently corrupting), and non-boolean bool values all
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

The canonical serializer is hand-rolled rather than `JSON.stringify`: it
emits `-0.0` for negative zero (matching Python and Rust) and throws on
non-finite numbers, on integral values beyond ±(2^53 − 1) (their digits
are already lost to float64 rounding), and on lone surrogates (which have
no UTF-8 encoding) — all cases the conformance protocol's document
constraints declare non-portable.

Known cross-language caveats (documented in the protocol): JavaScript
number formatting differs from Python for integral-valued floats (`1.0`
serializes as `1`), and JavaScript objects reorder integer-like member
names. The cross-implementation property test avoids these values.

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
