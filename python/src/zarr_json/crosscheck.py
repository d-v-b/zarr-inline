"""Cross-language array crosscheck harness (zarr-python side).

See DESIGN.md section 6.2 (write/read) and 6.3 (trace). All conversions
between payload JSON and native arrays go through the json codec itself
(serializer.encode_chunk / decode_chunk), so what this harness accepts is
definitionally what the codec accepts: strict scalar sorts, finite ranges,
exact nesting. Harness-level rules (in-bounds regions, valid initial
documents, group-only parents, explicit zero fill) follow the trace input
contract in DESIGN.md section 6.3.
"""

from __future__ import annotations

import json
import sys
from typing import Any

import zarr

from zarr_json.backing import MemoryBacking
from zarr_json.codec import is_metadata_key, strict_loads
from zarr_json.serializer import JsonSerializer, decode_chunk, encode_chunk
from zarr_json.store import ZarrJsonStore
from zarr_json.validator import Strictness


def _to_native(data: Any, shape: tuple[int, ...], zdtype: Any) -> Any:
    """Payload JSON -> native array, via the codec's decoder.

    The payload is re-serialized SORT-PRESERVING (json.dumps keeps 1.0 as a
    float token), not canonically: canonicalization would turn the float
    token 1.0 into the integer token 1 and launder a value the codec must
    reject for integer dtypes (SPEC 9.2).
    """
    text = json.dumps(data, ensure_ascii=False, allow_nan=False)
    return decode_chunk(text.encode("utf-8"), shape, zdtype)


def _to_json(nd: Any, zdtype: Any) -> Any:
    """Native array -> payload JSON, via the codec's encoder."""
    return strict_loads(encode_chunk(nd, zdtype))


def _dtype_name(arr: Any) -> str:
    meta = arr.metadata.data_type.to_json(zarr_format=3)
    return meta["name"] if isinstance(meta, dict) else meta


def _create_array(
    store: ZarrJsonStore, path: str, dtype: str, shape: tuple[int, ...], chunks: tuple[int, ...]
) -> Any:
    root = zarr.open_group(store=store, mode="a")
    # zarr-python refuses to create a node under an array and to overwrite an
    # existing node; explicit zero fill for every dtype.
    return root.create_array(
        path,
        shape=shape,
        chunks=chunks,
        dtype=dtype,
        serializer=JsonSerializer(),
        compressors=None,
    )


def write(payload: dict[str, Any]) -> dict[str, Any]:
    backing = MemoryBacking({})
    store = ZarrJsonStore(backing)
    for spec in payload["arrays"]:
        shape = tuple(spec["shape"])
        arr = _create_array(store, spec["path"], spec["dtype"], shape, tuple(spec["chunks"]))
        arr[...] = _to_native(spec["data"], shape, arr.metadata.data_type)
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
        arrays.append(
            {
                "path": path,
                "dtype": _dtype_name(arr),
                "shape": list(arr.shape),
                "chunks": list(arr.chunks),
                "data": _to_json(arr[...], arr.metadata.data_type),
            }
        )
    return {"arrays": arrays}


def _int_list(value: Any, what: str, *, min_value: int) -> tuple[int, ...]:
    if not isinstance(value, list) or not all(
        isinstance(v, int) and not isinstance(v, bool) and v >= min_value for v in value
    ):
        raise ValueError(f"{what} must be a list of integers >= {min_value}")
    return tuple(value)


def _region(operation: dict[str, Any], arr: Any, index: int) -> tuple[tuple[int, ...], Any]:
    """Validate a region against the array (DESIGN 6.3): same rank, every
    extent >= 1, and origin + shape within the array shape."""
    origin = _int_list(operation.get("origin"), f"operation {index}: origin", min_value=0)
    shape = _int_list(operation.get("shape"), f"operation {index}: shape", min_value=1)
    if len(origin) != len(arr.shape) or len(shape) != len(arr.shape):
        raise ValueError(f"operation {index}: region dimensionality mismatch")
    for axis, (start, size, extent) in enumerate(zip(origin, shape, arr.shape)):
        if start + size > extent:
            raise ValueError(
                f"operation {index}: region [{start}, {start + size}) exceeds "
                f"array extent {extent} on axis {axis}"
            )
    if not shape:
        return shape, (...)
    return shape, tuple(slice(start, start + size) for start, size in zip(origin, shape))


def trace(payload: dict[str, Any]) -> dict[str, Any]:
    """Execute portable create/write/read operations and return the store.

    The optional initial ``document`` (which MUST be a valid zarr-json
    document) permits a document emitted by any implementation to be used
    as the starting store for another.
    """
    initial = payload.get("document", {})
    if not isinstance(initial, dict):
        raise ValueError("trace document must be an object")
    operations = payload.get("operations")
    if not isinstance(operations, list):
        raise ValueError("trace payload needs an operations array")
    backing = MemoryBacking(initial)
    try:
        store = ZarrJsonStore(backing, strictness=Strictness.STRICT)
    except Exception as exc:  # noqa: BLE001 - harness boundary
        raise ValueError(f"invalid initial document: {exc}") from exc
    reads: list[dict[str, Any]] = []

    for index, operation in enumerate(operations):
        op = operation.get("op")
        path = operation.get("path")
        if not isinstance(path, str) or not path:
            raise ValueError(f"operation {index}: path must be a non-empty string")
        if op == "create_array":
            dtype = operation.get("dtype")
            if not isinstance(dtype, str):
                raise ValueError(f"operation {index}: create_array needs dtype")
            shape = _int_list(operation.get("shape"), f"operation {index}: shape", min_value=0)
            chunks = _int_list(
                operation.get("chunks"), f"operation {index}: chunks", min_value=1
            )
            _create_array(store, path, dtype, shape, chunks)
        elif op in ("write_region", "read_region"):
            arr = zarr.open_array(
                store=store, path=path, mode="r+" if op == "write_region" else "r"
            )
            region_shape, selection = _region(operation, arr, index)
            if op == "write_region":
                if "data" not in operation:
                    raise ValueError(f"operation {index}: write_region needs data")
                arr[selection] = _to_native(
                    operation["data"], region_shape, arr.metadata.data_type
                )
            else:
                reads.append(
                    {
                        "operation": index,
                        "data": _to_json(arr[selection], arr.metadata.data_type),
                    }
                )
        else:
            raise ValueError(f"operation {index}: unknown op {op!r}")

    return {"document": backing.load(), "reads": reads}


MODES = {"write": write, "read": read, "trace": trace}


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in MODES:
        print(f"usage: python -m zarr_json.crosscheck {'|'.join(MODES)}", file=sys.stderr)
        return 1
    try:
        payload = strict_loads(sys.stdin.buffer.read())
        result = MODES[sys.argv[1]](payload)
    except Exception as exc:  # noqa: BLE001 - harness boundary
        print(f"crosscheck {sys.argv[1]} failed: {exc}", file=sys.stderr)
        return 1
    json.dump(result, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
