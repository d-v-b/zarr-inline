# zarr-inline (Python)

> **Unstable**: the zarr-inline format and this API may change incompatibly; see the repository README.

Store a Zarr v3 hierarchy as a single JSON object. `ZarrInlineStore` is a
read-write `zarr.abc.store.Store` whose entire contents live in one JSON
document — metadata keys (`zarr.json` or `*/zarr.json`) hold inline JSON
metadata; all other keys hold base64-encoded bytes or byte-stable inline JSON
arrays or objects. For arrays using the `json` codec, chunks are inline arrays
of decoded values.

See the project [specification](https://github.com/d-v-b/zarr-inline/blob/main/docs/specification.md)
and [design guide](https://github.com/d-v-b/zarr-inline/blob/main/docs/how-it-works.md).

## Install

```bash
python -m pip install zarr-inline
```

## Usage

```python
import zarr
from zarr_inline import ZarrInlineStore, MemoryBacking, StringBacking

# Build a hierarchy into an in-memory JSON object.
backing = MemoryBacking({})
store = ZarrInlineStore(backing)
root = zarr.open_group(store=store, mode="w")
arr = root.create_array("data", shape=(8,), chunks=(4,), dtype="uint8")
arr[:] = range(8)

# `backing.load()` is the JSON document — share it as one file.
document = backing.load()

# Reload from a JSON string.
import json
store2 = ZarrInlineStore(StringBacking(json.dumps(document)))
root2 = zarr.open_group(store=store2, mode="r")
```

## Converting an existing hierarchy

`from_zarr` turns any readable Zarr v3 hierarchy — a path, a `Store`, or an
open `Group` — into a zarr-inline document in one call, carrying every
metadata field (attributes, `fill_value`, `dimension_names`,
`chunk_key_encoding`) so nothing is silently lost:

```python
from zarr_inline import from_zarr, to_zarr, write_document

document = from_zarr("data.zarr")                    # chunks as JSON arrays
document = from_zarr("data.zarr", inline_data=False) # byte-faithful: original
                                                     # codecs kept, chunks base64
write_document("data.zarr", "data.json")             # straight to a pretty file
to_zarr(document, "restored.zarr")                   # back to a directory store
```

`inline_data=True` (the default) re-encodes every array with the `json`
codec — the legible form; the original codec chain (e.g. compression) is
deliberately replaced, and an array whose dtype the codec cannot represent
raises. `inline_data=False` copies every store key byte-for-byte instead.
See `examples/convert_hierarchy.py` at the repository root.

## Legible chunks: the `json` codec

By default chunk bytes are opaque (base64). Arrays created with the `json`
array->bytes codec store their chunks as real JSON arrays in the document,
using the Zarr v3 `fill_value` scalar serialization elementwise (NaN becomes
`"NaN"`, complex becomes `[re, im]`, and so on):

```python
import math
from zarr_inline import JsonSerializer

arr = root.create_array(
    "legible", shape=(4,), chunks=(4,), dtype="float64",
    serializer=JsonSerializer(), compressors=None,
)
arr[:] = [1.5, math.nan, math.inf, -0.0]
# document now contains:  "legible/c/0": [1.5, "NaN", "Infinity", 0]
```

`compressors=None` matters: zarr-python otherwise appends a default
compressor after the serializer, making chunks opaque again.

## Backings

- `MemoryBacking(document)` — the in-memory object is the source of truth.
- `FileBacking(path)` — reads from / writes to a `.json` file. A missing
  file starts as an empty document; every store mutation persists
  automatically (there is no flush call), pretty-printed at `indent=2`.
- `StringBacking(text)` — parses from a string; `dumps()` returns the current string.

## Validation

```python
from zarr_inline import validate, Strictness

issues = validate(document)                       # lenient: returns a list
validate(document, strictness=Strictness.STRICT)   # strict: raises ValidationError
```

`validate` checks the two validity rules: **R1** well-formed keys and **R2**
per-value type (metadata keys map to objects; byte keys map to base64 strings
or inline JSON arrays or objects).

## Tests

```bash
cd python && uv run pytest -q
```
