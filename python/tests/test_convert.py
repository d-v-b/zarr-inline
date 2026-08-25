"""Tests for the hierarchy <-> document converters."""

import json

import numpy as np
import pytest
import zarr

from zarr_inline import (
    MemoryBacking,
    ZarrInlineStore,
    from_zarr,
    to_zarr,
    validate,
    write_document,
)


@pytest.fixture
def hierarchy(tmp_path):
    """A small on-disk hierarchy exercising the fields conversion must carry:
    root and nested-group attributes, array attributes, fill_value,
    dimension_names, a NaN, and a compressed float array."""
    path = tmp_path / "input.zarr"
    root = zarr.open_group(str(path), mode="w")
    root.attrs["title"] = "survey"
    temp = root.create_array(
        "temp",
        shape=(4, 4),
        chunks=(2, 2),
        dtype="float64",
        fill_value=-1.0,
        dimension_names=["y", "x"],
    )
    temp[:] = np.arange(16, dtype="float64").reshape(4, 4) / 3
    temp[0, 0] = float("nan")
    temp.attrs["long_name"] = "temperature"
    flags = root.create_array("qc/flags", shape=(6,), chunks=(4,), dtype="uint8")
    flags[:] = [0, 1, 0, 2, 0, 1]
    root["qc"].attrs["stage"] = 2
    return path


def _assert_round_trips(document, src_root):
    root = zarr.open_group(
        store=ZarrInlineStore(MemoryBacking(document), read_only=True), mode="r"
    )
    assert dict(root.attrs) == dict(src_root.attrs)
    assert dict(root["qc"].attrs) == dict(src_root["qc"].attrs)
    assert dict(root["temp"].attrs) == dict(src_root["temp"].attrs)
    assert root["temp"].metadata.dimension_names == ("y", "x")
    assert root["temp"].metadata.fill_value == -1.0
    np.testing.assert_array_equal(root["temp"][...], src_root["temp"][...])
    np.testing.assert_array_equal(root["qc/flags"][...], src_root["qc/flags"][...])


def test_converters_round_trip_both_modes(hierarchy, tmp_path):
    src_root = zarr.open_group(str(hierarchy), mode="r")

    # Legible mode: valid document, every chunk an inline JSON array, data
    # and every metadata field carried.
    inline = from_zarr(hierarchy)
    assert validate(inline) == []
    chunk_keys = [k for k in inline if "/c/" in k]
    assert chunk_keys and all(isinstance(inline[k], list) for k in chunk_keys)
    _assert_round_trips(inline, src_root)

    # Byte-faithful mode: original codecs kept, chunks base64, and the
    # decoded bytes equal the source files exactly.
    faithful = from_zarr(hierarchy, inline_data=False)
    assert validate(faithful) == []
    assert faithful["temp/zarr.json"]["codecs"][0]["name"] == "bytes"
    assert all(isinstance(faithful[k], str) for k in faithful if "/c/" in k)
    from zarr_inline.document import decode_value

    assert decode_value("temp/c/0/0", faithful["temp/c/0/0"]) == (
        hierarchy / "temp" / "c" / "0" / "0"
    ).read_bytes()
    _assert_round_trips(faithful, src_root)

    # A zarr Group and a Store are accepted as sources too.
    assert from_zarr(src_root, inline_data=False) == faithful

    # write_document: pretty JSON on disk that parses back to the document.
    out = tmp_path / "out.json"
    written = write_document(hierarchy, out)
    assert json.loads(out.read_text()) == written == inline

    # to_zarr: materialize back to a directory; zarr reads it directly.
    dest = tmp_path / "restored.zarr"
    to_zarr(faithful, dest)
    restored = zarr.open_group(str(dest), mode="r")
    np.testing.assert_array_equal(restored["temp"][...], src_root["temp"][...])
    assert dict(restored.attrs) == dict(src_root.attrs)
    # to_zarr also accepts the document as a file path.
    write_document(hierarchy, tmp_path / "again.json", inline_data=False)
    to_zarr(tmp_path / "again.json", tmp_path / "restored2.zarr")
    assert zarr.open_group(str(tmp_path / "restored2.zarr"), mode="r")


def test_from_zarr_rejects_unsupported_source_type():
    with pytest.raises(TypeError, match="source must be"):
        from_zarr(12345)


def test_from_zarr_rejects_missing_path(tmp_path):
    with pytest.raises(FileNotFoundError):
        from_zarr(tmp_path / "does-not-exist.zarr")


def test_to_zarr_rejects_unsupported_dest_type(hierarchy):
    document = from_zarr(hierarchy, inline_data=False)
    with pytest.raises(TypeError, match="dest must be"):
        to_zarr(document, 12345)
