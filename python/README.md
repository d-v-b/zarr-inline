# zarr-json (Python)

Store a Zarr v3 hierarchy as a single JSON object. `ZarrJsonStore` is a
read-write `zarr.abc.store.Store` whose entire contents live in one JSON
document — keys ending in `zarr.json` hold inline JSON metadata, all other
keys hold base64-encoded bytes.

See the spec: `../docs/superpowers/specs/2026-05-14-zarr-json-design.md`.

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
per-value type (metadata keys map to objects, byte keys map to base64 strings).

## Tests

```bash
cd python && uv run pytest -q
```
