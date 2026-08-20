import json

import pytest

from zarr_json.codec import decode_value, encode_value, is_metadata_key


def test_root_zarr_json_is_metadata_key():
    assert is_metadata_key("zarr.json") is True


def test_nested_zarr_json_is_metadata_key():
    assert is_metadata_key("myarray/zarr.json") is True


def test_chunk_key_is_not_metadata_key():
    assert is_metadata_key("myarray/c/0/0") is False


def test_key_containing_but_not_ending_zarr_json_is_not_metadata():
    assert is_metadata_key("zarr.json/c/0") is False


def test_decode_metadata_value_serializes_object_to_json_bytes():
    out = decode_value("zarr.json", {"zarr_format": 3, "node_type": "group"})
    assert isinstance(out, bytes)
    assert json.loads(out) == {"zarr_format": 3, "node_type": "group"}


def test_decode_byte_value_base64_decodes_string():
    # base64 of bytes 00 01 02 03 04 05 06 07
    assert decode_value("a/c/0", "AAECAwQFBgc=") == bytes(range(8))


def test_encode_metadata_value_parses_json_bytes_to_object():
    raw = b'{"zarr_format": 3, "node_type": "array"}'
    assert encode_value("zarr.json", raw) == {"zarr_format": 3, "node_type": "array"}


def test_encode_byte_value_base64_encodes_bytes():
    assert encode_value("a/c/0", bytes(range(8))) == "AAECAwQFBgc="


def test_encode_metadata_value_rejects_non_object_json():
    with pytest.raises(ValueError, match="JSON object"):
        encode_value("zarr.json", b"[1, 2, 3]")


def test_round_trip_metadata():
    obj = {"zarr_format": 3, "node_type": "group", "attributes": {}}
    assert encode_value("zarr.json", decode_value("zarr.json", obj)) == obj


def test_round_trip_bytes():
    data = bytes([9, 8, 7, 0, 255, 1])
    assert decode_value("a/c/0", encode_value("a/c/0", data)) == data


def test_public_api_is_importable_from_package_root():
    import zarr_json

    assert hasattr(zarr_json, "ZarrJsonStore")
    assert hasattr(zarr_json, "MemoryBacking")
    assert hasattr(zarr_json, "FileBacking")
    assert hasattr(zarr_json, "StringBacking")
    assert hasattr(zarr_json, "validate")
    assert hasattr(zarr_json, "Strictness")
    assert hasattr(zarr_json, "ValidationError")


def test_key_ending_in_zarr_json_without_separator_is_not_metadata():
    assert is_metadata_key("xyzarr.json") is False
    assert is_metadata_key("a/notzarr.json") is False


def test_encode_byte_value_inlines_canonical_json_array():
    data = b'[[0,1,2,3],[4,5,6,7]]'
    assert encode_value("a/c/0/0", data) == [[0, 1, 2, 3], [4, 5, 6, 7]]


def test_encode_byte_value_keeps_non_canonical_json_array_as_base64():
    # Valid JSON array, but not in canonical form (whitespace) — inlining
    # would not round-trip byte-exactly, so it must stay base64.
    data = b"[1, 2, 3]"
    out = encode_value("a/c/0", data)
    assert isinstance(out, str)
    assert decode_value("a/c/0", out) == data


def test_encode_byte_value_keeps_nan_token_array_as_base64():
    # json.loads accepts bare NaN tokens, but they are not JSON; canonical
    # re-serialization refuses them, so the bytes must stay base64.
    data = b"[NaN]"
    out = encode_value("a/c/0", data)
    assert isinstance(out, str)
    assert decode_value("a/c/0", out) == data


def test_decode_byte_value_serializes_inline_array_canonically():
    # RFC 8785 numbers: -0.0 -> "0", 2.0 -> "2", exponents unpadded.
    assert decode_value("a/c/0", [1.5, "NaN", -0.0, 2.0, 1e-7]) == (
        b'[1.5,"NaN",0,2,1e-7]'
    )


def test_round_trip_inline_array():
    value = [[0, 1], [2, 3]]
    assert encode_value("a/c/0/0", decode_value("a/c/0/0", value)) == value


def test_strict_loads_rejects_bare_nan_token():
    from zarr_json.codec import strict_loads

    with pytest.raises(ValueError, match="not a JSON token"):
        strict_loads('{"a/c/0": [NaN]}')


def test_strict_loads_rejects_float_overflow_literal():
    from zarr_json.codec import strict_loads

    with pytest.raises(ValueError, match="overflows float64"):
        strict_loads('{"a/c/0": [1e999]}')
