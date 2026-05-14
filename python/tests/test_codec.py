from zarr_json.codec import is_metadata_key


def test_root_zarr_json_is_metadata_key():
    assert is_metadata_key("zarr.json") is True


def test_nested_zarr_json_is_metadata_key():
    assert is_metadata_key("myarray/zarr.json") is True


def test_chunk_key_is_not_metadata_key():
    assert is_metadata_key("myarray/c/0/0") is False


def test_key_containing_but_not_ending_zarr_json_is_not_metadata():
    assert is_metadata_key("zarr.json/c/0") is False
