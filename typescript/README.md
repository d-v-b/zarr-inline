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
cannot round-trip integers beyond 2^53 either).

## Backings

- `new MemoryBacking(document)` — the in-memory object is the source of truth.
- `new StringBacking(text)` — parses from a string; `dumps()` returns the
  current string.

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

Reads a document on stdin, writes `{"issues", "decoded", "reencoded"}` on
stdout per `../docs/superpowers/specs/2026-08-20-conformance-protocol.md`.

Known cross-language caveats (documented in the protocol): JavaScript
number formatting differs from Python for integral-valued floats
(`1.0`/`-0.0` serialize as `1`/`0`), and JavaScript objects reorder
integer-like member names. The cross-implementation property test avoids
these values. This implementation's strict base64 check also verifies a
decode/re-encode round-trip, so base64 strings with non-zero padding bits
(e.g. `"AB=="`) are rejected, where Python's `validate=True` accepts them.

## Tests

```bash
cd typescript && npm test
```
