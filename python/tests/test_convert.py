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
    verify_document,
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


def test_nested_group_members_traverse_through_the_document(hierarchy):
    # End-to-end form of the list_dir regression: members() on a nested
    # group of a reloaded document must see its children.
    import zarr as _zarr

    from zarr_inline import open_document

    root = open_document(from_zarr(hierarchy))
    assert [name for name, _ in root["qc"].members()] == ["flags"]
    assert sorted(name for name, _ in root.members(max_depth=None)) == [
        "qc",
        "qc/flags",
        "temp",
    ]


def test_open_document_reads_files_and_dicts(hierarchy, tmp_path):
    from zarr_inline import open_document

    out = tmp_path / "doc.json"
    write_document(hierarchy, out)
    for source in (out, json.loads(out.read_text())):
        root = open_document(source)
        assert root["temp"].shape == (4, 4)
    with pytest.raises(Exception):
        open_document(json.loads(out.read_text()))["temp"][0, 0] = 5.0  # read-only


def test_verify_document_passes_and_names_the_mismatch(hierarchy):
    from zarr_inline import DocumentMismatchError, verify_document

    document = from_zarr(hierarchy)
    verify_document(document, hierarchy)
    broken = json.loads(json.dumps(document))
    broken["qc/flags/c/0"] = [9, 9, 9, 9]
    # A real exception type (not AssertionError): it must survive python -O.
    with pytest.raises(DocumentMismatchError, match="qc/flags: values differ"):
        verify_document(broken, hierarchy)


def test_from_zarr_names_the_array_that_cannot_be_inlined(tmp_path):
    import zarr as _zarr

    path = tmp_path / "hostile.zarr"
    root = _zarr.open_group(str(path), mode="w")
    arr = root.create_array("names", shape=(2,), chunks=(2,), dtype=str)
    arr[:] = ["a", "b"]
    with pytest.raises(ValueError, match="'names'.*inline_data=False"):
        from_zarr(path)
    # The suggested fallbacks work.
    assert validate(from_zarr(path, inline_data=False)) == []
    assert validate(from_zarr(path, inline_data="auto")) == []


def test_from_zarr_auto_inlines_supported_arrays_and_byte_copies_the_rest(tmp_path):
    import zarr as _zarr

    path = tmp_path / "mixed.zarr"
    root = _zarr.open_group(str(path), mode="w")
    plain = root.create_array("plain", shape=(4,), chunks=(4,), dtype="uint8")
    plain[:] = [1, 2, 3, 4]
    names = root.create_array("names", shape=(2,), chunks=(2,), dtype=str)
    names[:] = ["a", "b"]

    document = from_zarr(path, inline_data="auto")
    assert validate(document) == []
    # The supported array is legible; the vlen-string one stays base64.
    assert isinstance(document["plain/c/0"], list)
    assert isinstance(document["names/c/0"], str)
    verify_document(document, path)


def test_from_zarr_rejects_unknown_inline_data_value(tmp_path):
    import zarr as _zarr

    path = tmp_path / "h.zarr"
    _zarr.open_group(str(path), mode="w")
    with pytest.raises(ValueError, match="inline_data must be"):
        from_zarr(path, inline_data="always")
