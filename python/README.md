# zarr-json (Python)

Store a Zarr v3 hierarchy as a single JSON object. `ZarrJsonStore` is a
read-write `zarr.abc.store.Store` whose entire contents live in one JSON
document — metadata keys (`zarr.json` or `*/zarr.json`) hold inline JSON
metadata; all other keys hold base64-encoded bytes or, for arrays using the
`json` codec, inline JSON arrays of decoded values.

See [SPEC.md](../SPEC.md) and [DESIGN.md](../DESIGN.md).

## Install

```bash
cd python && uv sync
```

## Usage

```python
import zarr
from zarr_json import ZarrJsonStore, MemoryBacking, StringBacking

# Build a hierarchy into an in-memory JSON object.
backing = MemoryBacking({})
store = ZarrJsonStore(backing)
root = zarr.open_group(store=store, mode="w")
arr = root.create_array("data", shape=(8,), chunks=(4,), dtype="uint8")
arr[:] = range(8)

# `backing.load()` is the JSON document — share it as one file.
document = backing.load()

# Reload from a JSON string.
import json
store2 = ZarrJsonStore(StringBacking(json.dumps(document)))
root2 = zarr.open_group(store=store2, mode="r")
```

## Legible chunks: the `json` codec

By default chunk bytes are opaque (base64). Arrays created with the `json`
array->bytes codec store their chunks as real JSON arrays in the document,
using the Zarr v3 `fill_value` scalar serialization elementwise (NaN becomes
`"NaN"`, complex becomes `[re, im]`, and so on):

```python
import math
from zarr_json import JsonSerializer

arr = root.create_array(
    "legible", shape=(4,), chunks=(4,), dtype="float64",
    serializer=JsonSerializer(), compressors=None,
)
arr[:] = [1.5, math.nan, math.inf, -0.0]
# document now contains:  "legible/c/0": [1.5, "NaN", "Infinity", -0.0]
```

`compressors=None` matters: zarr-python otherwise appends a default
compressor after the serializer, making chunks opaque again.

## Backings

- `MemoryBacking(document)` — the in-memory object is the source of truth.
- `FileBacking(path)` — reads from / writes to a `.json` file.
- `StringBacking(text)` — parses from a string; `dumps()` returns the current string.

## Validation

```python
from zarr_json import validate, Strictness

issues = validate(document)                       # lenient: returns a list
validate(document, strictness=Strictness.STRICT)   # strict: raises ValidationError
```

`validate` checks the two validity rules: **R1** well-formed keys and **R2**
per-value type (metadata keys map to objects; byte keys map to base64 strings
or inline JSON arrays).

## Tests

```bash
cd python && uv run pytest -q
```
