"""Cross-language array crosscheck harness (zarr-python side).

See docs/superpowers/specs/2026-08-20-crosscheck-protocol.md. `write` turns
a payload of arrays into a zarr-json document by driving zarr-python with
the json codec; `read` opens every array in a document and reports its
values using the fill_value scalar serialization, so payloads compare
exactly across languages (non-finite floats are the strings "NaN" etc.).
"""

from __future__ import annotations

import json
import sys
from typing import Any

import zarr

from zarr_json.backing import MemoryBacking
from zarr_json.codec import is_metadata_key, strict_loads
from zarr_json.serializer import JsonSerializer, _nest
from zarr_json.store import ZarrJsonStore


def write(payload: dict[str, Any]) -> dict[str, Any]:
    backing = MemoryBacking({})
    store = ZarrJsonStore(backing)
    root = zarr.open_group(store=store, mode="w")
    for spec in payload["arrays"]:
        arr = root.create_array(
            spec["path"],
            shape=tuple(spec["shape"]),
            chunks=tuple(spec["chunks"]),
            dtype=spec["dtype"],
            serializer=JsonSerializer(),
            compressors=None,
        )
        zdtype = arr.metadata.data_type
        flat = _flatten_payload(spec["data"], tuple(spec["shape"]))
        import numpy as np

        scalars = [zdtype.from_json_scalar(v, zarr_format=3) for v in flat]
        arr[...] = np.asarray(scalars, dtype=zdtype.to_native_dtype()).reshape(
            tuple(spec["shape"])
        )
    return backing.load()


def read(document: dict[str, Any]) -> dict[str, Any]:
    store = ZarrJsonStore(MemoryBacking(document), read_only=True)
    paths = sorted(
        key.removesuffix("/zarr.json")
        for key, value in document.items()
        if key != "zarr.json"
        and is_metadata_key(key)
        and isinstance(value, dict)
        and value.get("node_type") == "array"
    )
    arrays = []
    for path in paths:
        arr = zarr.open_array(store=store, path=path, mode="r")
        zdtype = arr.metadata.data_type
        data = arr[...]
        flat = [zdtype.to_json_scalar(v, zarr_format=3) for v in data.ravel()]
        arrays.append(
            {
                "path": path,
                "dtype": arr.metadata.data_type.to_json(zarr_format=3)["name"]
                if isinstance(arr.metadata.data_type.to_json(zarr_format=3), dict)
                else arr.metadata.data_type.to_json(zarr_format=3),
                "shape": list(arr.shape),
                "chunks": list(arr.chunks),
                "data": _nest(flat, tuple(arr.shape)),
            }
        )
    return {"arrays": arrays}


def _flatten_payload(nested: Any, shape: tuple[int, ...]) -> list[Any]:
    if len(shape) == 0:
        return [nested]
    if len(shape) == 1:
        return list(nested)
    out: list[Any] = []
    for sub in nested:
        out.extend(_flatten_payload(sub, shape[1:]))
    return out


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in ("write", "read"):
        print("usage: python -m zarr_json.crosscheck write|read", file=sys.stderr)
        return 1
    try:
        payload = strict_loads(sys.stdin.buffer.read())
        result = write(payload) if sys.argv[1] == "write" else read(payload)
    except Exception as exc:  # noqa: BLE001 - harness boundary
        print(f"crosscheck {sys.argv[1]} failed: {exc}", file=sys.stderr)
        return 1
    json.dump(result, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
