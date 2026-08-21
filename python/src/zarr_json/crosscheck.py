"""Cross-language array crosscheck harness (zarr-python side).

See DESIGN.md section 6.2. `write` turns
a payload of arrays into a zarr-json document by driving zarr-python with
the json codec; `read` opens every array in a document and reports its
values using the fill_value scalar serialization, so payloads compare
exactly across languages (non-finite floats are the strings "NaN" etc.).
`trace` executes the operation-trace protocol from DESIGN.md section 6.3.
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


def _json_scalars(data: Any, shape: tuple[int, ...], zdtype: Any) -> Any:
    """Convert a shape-matching payload from fill-value JSON scalars."""
    import numpy as np

    flat = _flatten_payload(data, shape)
    scalars = [zdtype.from_json_scalar(v, zarr_format=3) for v in flat]
    return np.asarray(scalars, dtype=zdtype.to_native_dtype()).reshape(shape)


def _selection(origin: tuple[int, ...], shape: tuple[int, ...]) -> Any:
    if not shape:
        return (...)
    return tuple(slice(start, start + size) for start, size in zip(origin, shape))


def trace(payload: dict[str, Any]) -> dict[str, Any]:
    """Execute portable create/write/read operations and return the store.

    The optional initial ``document`` permits a document emitted by any
    implementation to be used as the starting store for another.
    """
    initial = payload.get("document", {})
    if not isinstance(initial, dict):
        raise ValueError("trace document must be an object")
    backing = MemoryBacking(initial)
    store = ZarrJsonStore(backing)
    reads: list[dict[str, Any]] = []

    for index, operation in enumerate(payload.get("operations", [])):
        op = operation.get("op")
        path = operation.get("path")
        if not isinstance(path, str) or not path:
            raise ValueError(f"operation {index}: path must be a non-empty string")
        if op == "create_array":
            root = zarr.open_group(store=store, mode="a")
            root.create_array(
                path,
                shape=tuple(operation["shape"]),
                chunks=tuple(operation["chunks"]),
                dtype=operation["dtype"],
                serializer=JsonSerializer(),
                compressors=None,
            )
        elif op in ("write_region", "read_region"):
            arr = zarr.open_array(
                store=store,
                path=path,
                mode="r+" if op == "write_region" else "r",
            )
            origin = tuple(operation["origin"])
            region_shape = tuple(operation["shape"])
            if len(origin) != len(region_shape) or len(origin) != len(arr.shape):
                raise ValueError(f"operation {index}: region dimensionality mismatch")
            selection = _selection(origin, region_shape)
            if op == "write_region":
                arr[selection] = _json_scalars(
                    operation["data"], region_shape, arr.metadata.data_type
                )
            else:
                data = arr[selection]
                zdtype = arr.metadata.data_type
                flat = [zdtype.to_json_scalar(v, zarr_format=3) for v in data.ravel()]
                reads.append({"operation": index, "data": _nest(flat, region_shape)})
        else:
            raise ValueError(f"operation {index}: unknown op {op!r}")

    return {"document": backing.load(), "reads": reads}


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
    if len(sys.argv) != 2 or sys.argv[1] not in ("write", "read", "trace"):
        print("usage: python -m zarr_json.crosscheck write|read|trace", file=sys.stderr)
        return 1
    try:
        payload = strict_loads(sys.stdin.buffer.read())
        result = (
            write(payload)
            if sys.argv[1] == "write"
            else read(payload)
            if sys.argv[1] == "read"
            else trace(payload)
        )
    except Exception as exc:  # noqa: BLE001 - harness boundary
        print(f"crosscheck {sys.argv[1]} failed: {exc}", file=sys.stderr)
        return 1
    json.dump(result, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
