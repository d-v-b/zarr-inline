"""Tests for the ``json`` array->bytes codec (fill_value-based)."""

import json

import numpy as np
import pytest
import zarr

from zarr_json import JsonSerializer, MemoryBacking, ZarrJsonStore

CASES = [
    # (dtype, values, expected chunk JSON in the document)
    ("uint8", [[0, 1, 2, 3], [4, 5, 6, 7]], [[0, 1, 2, 3], [4, 5, 6, 7]]),
    ("int64", [[2**60 + 1, -1]], [[2**60 + 1, -1]]),
    (
        "float64",
        [[1.5, float("nan"), float("inf"), -0.0]],
        [[1.5, "NaN", "Infinity", 0]],
    ),
    ("complex128", [[1 + 2j]], [[[1, 2]]]),
    ("bool", [[True, False]], [[True, False]]),
]


@pytest.mark.parametrize(("dtype", "values", "expected_json"), CASES)
async def test_chunks_round_trip_and_appear_as_inline_json(dtype, values, expected_json):
    backing = MemoryBacking({})
    store = ZarrJsonStore(backing)
    root = zarr.open_group(store=store, mode="w")

    expected = np.array(values, dtype=dtype)
    arr = root.create_array(
        "data",
        shape=expected.shape,
        chunks=expected.shape,
        dtype=dtype,
        serializer=JsonSerializer(),
        compressors=None,
    )
    arr[:] = expected

    doc = backing.load()
    chunk_key = "data/c/" + "/".join("0" for _ in expected.shape)
    assert doc[chunk_key] == expected_json
    assert doc["data/zarr.json"]["codecs"] == [{"name": "json"}]

    # Read back through a fresh store over a JSON round-trip of the document.
    store2 = ZarrJsonStore(MemoryBacking(json.loads(json.dumps(doc))))
    got = zarr.open_group(store=store2, mode="r")["data"][:]
    np.testing.assert_array_equal(got, expected)


async def test_decode_rejects_json_not_matching_chunk_shape():
    from zarr.core.array_spec import ArraySpec
    from zarr.core.buffer import default_buffer_prototype
    from zarr.core.dtype import get_data_type_from_native_dtype

    proto = default_buffer_prototype()
    spec = ArraySpec(
        shape=(2, 2),
        dtype=get_data_type_from_native_dtype(np.dtype("uint8")),
        fill_value=0,
        config={},
        prototype=proto,
    )
    bad = proto.buffer.from_bytes(b"[1,2,3]")
    with pytest.raises(ValueError, match="chunk shape"):
        await JsonSerializer()._decode_single(bad, spec)


def test_from_dict_rejects_wrong_codec_name():
    with pytest.raises(ValueError, match="expected codec name 'json'"):
        JsonSerializer.from_dict({"name": "bytes"})
