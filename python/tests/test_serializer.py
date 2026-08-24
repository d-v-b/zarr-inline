"""Tests for the ``json`` array->bytes codec (fill_value-based)."""

import json

import numpy as np
import pytest
import zarr

from zarr_inline import JsonSerializer, MemoryBacking, ZarrInlineStore
from zarr_inline.serializer import decode_chunk

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
    store = ZarrInlineStore(backing)
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
    store2 = ZarrInlineStore(MemoryBacking(json.loads(json.dumps(doc))))
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


def test_from_dict_rejects_unrecognized_configuration():
    with pytest.raises(ValueError, match="no configuration"):
        JsonSerializer.from_dict({"name": "json", "configuration": {"x": 1}})


@pytest.mark.parametrize("chunk_text", [b"[NaN]", b"[1e999]", b"[Infinity]"])
async def test_decode_strict_parses_chunk_bytes(chunk_text):
    # SPEC 9.2: chunk bytes are strict-parsed; Python's lenient json.loads
    # must not let NaN/Infinity tokens or float64 overflow through.
    from zarr.core.array_spec import ArraySpec
    from zarr.core.buffer import default_buffer_prototype
    from zarr.core.dtype import get_data_type_from_native_dtype

    proto = default_buffer_prototype()
    spec = ArraySpec(
        shape=(1,),
        dtype=get_data_type_from_native_dtype(np.dtype("float64")),
        fill_value=0.0,
        config={},
        prototype=proto,
    )
    with pytest.raises(ValueError):
        await JsonSerializer()._decode_single(proto.buffer.from_bytes(chunk_text), spec)


@pytest.mark.parametrize(
    ("dtype", "chunk_text"),
    [
        ("int32", b"[1.0]"),     # float token for an integer type
        ("int32", b"[true]"),    # boolean for an integer type
        ("int32", b'["1"]'),     # string for an integer type
        ("bool", b"[1]"),        # integer for bool
        ("float64", b'["nan"]'), # only the three exact non-finite strings
    ],
)
async def test_decode_enforces_scalar_sorts(dtype, chunk_text):
    from zarr.core.array_spec import ArraySpec
    from zarr.core.buffer import default_buffer_prototype
    from zarr.core.dtype import get_data_type_from_native_dtype

    proto = default_buffer_prototype()
    spec = ArraySpec(
        shape=(1,),
        dtype=get_data_type_from_native_dtype(np.dtype(dtype)),
        fill_value=0,
        config={},
        prototype=proto,
    )
    with pytest.raises(ValueError):
        await JsonSerializer()._decode_single(proto.buffer.from_bytes(chunk_text), spec)


async def test_decode_accepts_integer_tokens_for_float_types_as_nearest_float64():
    from zarr.core.array_spec import ArraySpec
    from zarr.core.buffer import default_buffer_prototype
    from zarr.core.dtype import get_data_type_from_native_dtype

    proto = default_buffer_prototype()
    spec = ArraySpec(
        shape=(1,),
        dtype=get_data_type_from_native_dtype(np.dtype("float64")),
        fill_value=0.0,
        config={},
        prototype=proto,
    )
    out = await JsonSerializer()._decode_single(
        proto.buffer.from_bytes(b"[9007199254740993]"), spec
    )
    assert out.as_ndarray_like().tolist() == [9007199254740992.0]


@pytest.mark.parametrize(
    ("dtype", "chunk_text"),
    [
        ("float32", b"[1e39]"),
        ("float64", b"[1" + b"0" * 400 + b"]"),
        ("float16", b"[70000]"),
        ("complex64", b"[[1e39, 0]]"),
    ],
)
async def test_decode_rejects_numbers_that_overflow_the_target_float_type(dtype, chunk_text):
    import warnings

    from zarr.core.array_spec import ArraySpec
    from zarr.core.buffer import default_buffer_prototype
    from zarr.core.dtype import get_data_type_from_native_dtype

    proto = default_buffer_prototype()
    spec = ArraySpec(
        shape=(1,),
        dtype=get_data_type_from_native_dtype(np.dtype(dtype)),
        fill_value=0,
        config={},
        prototype=proto,
    )
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")  # numpy overflow RuntimeWarning
        with pytest.raises(ValueError, match="out of range"):
            await JsonSerializer()._decode_single(proto.buffer.from_bytes(chunk_text), spec)


class _SemanticDataType:
    """Test double whose native NumPy kind deliberately contradicts v3 metadata."""

    def __init__(self, name, native, convert=lambda value: value):
        self.name = name
        self.native = np.dtype(native)
        self.convert = convert

    def to_json(self, *, zarr_format):
        assert zarr_format == 3
        return self.name

    def to_native_dtype(self):
        return self.native

    def from_json_scalar(self, value, *, zarr_format):
        assert zarr_format == 3
        return self.convert(value)


def test_decode_dispatches_scalar_sort_on_zarr_data_type_not_numpy_kind():
    bool_with_object_storage = _SemanticDataType("bool", "O")
    with pytest.raises(ValueError, match="wrong JSON number sort"):
        decode_chunk(b"[1]", (1,), bool_with_object_storage)


def test_decode_does_not_impose_numpy_integer_rules_on_extension_data_types():
    extension_with_integer_storage = _SemanticDataType(
        "example.extension", "int32", convert=lambda value: len(value)
    )
    result = decode_chunk(b'["abc"]', (1,), extension_with_integer_storage)
    assert result.tolist() == [3]
