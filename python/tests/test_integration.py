import json

import numpy as np
import zarr

from zarr_json import MemoryBacking, StringBacking, ZarrJsonStore
from zarr_json.codec import is_metadata_key


async def test_create_group_and_array_write_read_through_zarr_python():
    backing = MemoryBacking({})
    store = ZarrJsonStore(backing)

    root = zarr.open_group(store=store, mode="w")
    arr = root.create_array("data", shape=(8,), chunks=(4,), dtype="uint8")
    arr[:] = np.arange(8, dtype="uint8")

    # Read back through a fresh store over the same document.
    store2 = ZarrJsonStore(MemoryBacking(backing.load()))
    root2 = zarr.open_group(store=store2, mode="r")
    arr2 = root2["data"]
    np.testing.assert_array_equal(arr2[:], np.arange(8, dtype="uint8"))


async def test_document_shape_metadata_objects_and_base64_chunks():
    backing = MemoryBacking({})
    store = ZarrJsonStore(backing)
    root = zarr.open_group(store=store, mode="w")
    arr = root.create_array("data", shape=(4,), chunks=(4,), dtype="uint8")
    arr[:] = np.arange(4, dtype="uint8")

    doc = backing.load()
    for key, value in doc.items():
        if is_metadata_key(key):
            assert isinstance(value, dict), f"{key} should be a JSON object"
        else:
            assert isinstance(value, str), f"{key} should be a base64 string"

    assert "zarr.json" in doc
    assert "data/zarr.json" in doc


async def test_round_trip_through_string_backing():
    backing = MemoryBacking({})
    store = ZarrJsonStore(backing)
    root = zarr.open_group(store=store, mode="w")
    arr = root.create_array("data", shape=(4,), chunks=(2,), dtype="int32")
    arr[:] = np.array([10, 20, 30, 40], dtype="int32")

    # Serialize the whole hierarchy to a JSON string, then reload it.
    text = json.dumps(backing.load())
    store2 = ZarrJsonStore(StringBacking(text))
    root2 = zarr.open_group(store=store2, mode="r")
    np.testing.assert_array_equal(
        root2["data"][:], np.array([10, 20, 30, 40], dtype="int32")
    )
