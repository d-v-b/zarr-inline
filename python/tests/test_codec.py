from zarr_json.codec import is_metadata_key


def test_root_zarr_json_is_metadata_key():
    assert is_metadata_key("zarr.json") is True


def test_nested_zarr_json_is_metadata_key():
    assert is_metadata_key("myarray/zarr.json") is True


def test_chunk_key_is_not_metadata_key():
    assert is_metadata_key("myarray/c/0/0") is False


def test_key_containing_but_not_ending_zarr_json_is_not_metadata():
    assert is_metadata_key("zarr.json/c/0") is False


import pytest

from zarr_json.codec import decode_value, encode_value


def test_decode_metadata_value_serializes_object_to_json_bytes():
    out = decode_value("zarr.json", {"zarr_format": 3, "node_type": "group"})
    assert isinstance(out, bytes)
    import json
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
