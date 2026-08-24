import json

import numpy as np
import zarr

from zarr_inline import MemoryBacking, StringBacking, ZarrInlineStore
from zarr_inline.document import is_metadata_key


async def test_create_group_and_array_write_read_through_zarr_python():
    backing = MemoryBacking({})
    store = ZarrInlineStore(backing)

    root = zarr.open_group(store=store, mode="w")
    arr = root.create_array("data", shape=(8,), chunks=(4,), dtype="uint8")
    arr[:] = np.arange(8, dtype="uint8")

    # Read back through a fresh store over the same document.
    store2 = ZarrInlineStore(MemoryBacking(backing.load()))
    root2 = zarr.open_group(store=store2, mode="r")
    arr2 = root2["data"]
    np.testing.assert_array_equal(arr2[:], np.arange(8, dtype="uint8"))


async def test_document_shape_metadata_objects_and_base64_chunks():
    backing = MemoryBacking({})
    store = ZarrInlineStore(backing)
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
    store = ZarrInlineStore(backing)
    root = zarr.open_group(store=store, mode="w")
    arr = root.create_array("data", shape=(4,), chunks=(2,), dtype="int32")
    arr[:] = np.array([10, 20, 30, 40], dtype="int32")

    # Serialize the whole hierarchy to a JSON string, then reload it.
    text = json.dumps(backing.load())
    store2 = ZarrInlineStore(StringBacking(text))
    root2 = zarr.open_group(store=store2, mode="r")
    np.testing.assert_array_equal(
        root2["data"][:], np.array([10, 20, 30, 40], dtype="int32")
    )


async def test_ome_zarr_example_reads_through_zarr_python():
    """The shipped OME-Zarr 0.5 example is a real, readable hierarchy."""
    import pathlib

    example = (
        pathlib.Path(__file__).resolve().parents[2]
        / "examples"
        / "valid"
        / "ome_zarr_0.5_image.json"
    )
    document = json.loads(example.read_text())
    store = ZarrInlineStore(MemoryBacking(document), read_only=True)
    root = zarr.open_group(store=store, mode="r")

    ome = root.attrs["ome"]
    assert ome["version"] == "0.5"
    datasets = ome["multiscales"][0]["datasets"]
    assert [d["path"] for d in datasets] == ["0", "1"]

    level0 = root["0"][:]
    level1 = root["1"][:]
    np.testing.assert_array_equal(
        level0, np.arange(64, dtype="uint8").reshape(8, 8)
    )
    np.testing.assert_array_equal(level1, level0[::2, ::2])

    # The chunks are legible: every chunk key holds an inline JSON array.
    for key, value in document.items():
        if "/c/" in key:
            assert isinstance(value, list), f"{key} should be inline JSON"
