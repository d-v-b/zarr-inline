"""Convert between existing Zarr hierarchies and zarr-inline documents.

These helpers exist because the conversion is easy to get subtly wrong by
hand: recreating arrays means remembering every metadata field
(``fill_value``, ``dimension_names``, ``chunk_key_encoding``, attributes)
and the legible path requires the exact codec configuration
(``serializer=JsonSerializer(), compressors=None, filters=None`` — zarr
otherwise appends a default compressor and chunks silently become base64).

- :func:`from_zarr` — any readable hierarchy -> a zarr-inline document.
- :func:`write_document` — the same, saved to a pretty-printed ``.json`` file.
- :func:`to_zarr` — a document materialized back onto a normal store.
- :func:`open_document` — a document (or ``.json`` file) opened directly as
  a zarr ``Group``.
- :func:`verify_document` — assert a document round-trips a hierarchy.

``inline_data=True`` (the default) re-encodes every array with the ``json``
codec so chunks appear as human-readable JSON arrays; the original codec
chain (e.g. compression) is deliberately replaced. ``inline_data=False``
copies every store key byte-for-byte instead: original codecs are kept and
chunk payloads appear as base64 strings.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import zarr
from zarr.abc.store import Store
from zarr.core.buffer import default_buffer_prototype
from zarr.core.sync import sync

from zarr_inline.backing import Document
from zarr_inline.document import decode_value, encode_value
from zarr_inline.serializer import JsonSerializer
from zarr_inline.store import ZarrInlineStore

Source = "str | Path | Store | zarr.Group"


def _open_group(source: Any) -> zarr.Group:
    if isinstance(source, zarr.Group):
        return source
    if isinstance(source, Store):
        return zarr.open_group(store=source, mode="r")
    if isinstance(source, (str, Path)):
        return zarr.open_group(str(source), mode="r")
    raise TypeError(
        "source must be a path, a zarr Store, or a zarr Group; got "
        f"{type(source).__name__}"
    )


def _copy_inline(src_root: zarr.Group, dst_root: zarr.Group) -> None:
    dst_root.attrs.update(dict(src_root.attrs))
    # Parents before children: members() order is not guaranteed.
    members = sorted(
        src_root.members(max_depth=None), key=lambda item: item[0].count("/")
    )
    for path, node in members:
        if isinstance(node, zarr.Group):
            group = dst_root.create_group(path)
            group.attrs.update(dict(node.attrs))
        else:
            arr = dst_root.create_array(
                path,
                shape=node.shape,
                chunks=node.chunks,
                dtype=node.metadata.data_type,
                fill_value=node.metadata.fill_value,
                dimension_names=node.metadata.dimension_names,
                chunk_key_encoding=node.metadata.chunk_key_encoding,
                attributes=dict(node.attrs),
                # The legible configuration, exactly: the json codec alone.
                serializer=JsonSerializer(),
                compressors=None,
                filters=None,
            )
            arr[...] = node[...]


def _copy_bytes(src_root: zarr.Group, document: Document) -> None:
    store = src_root.store_path.store
    prefix = src_root.store_path.path
    if prefix:
        prefix = prefix.rstrip("/") + "/"
    prototype = default_buffer_prototype()
    keys = sorted(sync(_collect(store.list_prefix(prefix))))
    for key in keys:
        buffer = sync(store.get(key, prototype))
        if buffer is None:  # pragma: no cover - listed keys should exist
            continue
        relative = key[len(prefix) :]
        document[relative] = encode_value(relative, buffer.to_bytes())


async def _collect(iterator: Any) -> list[str]:
    return [key async for key in iterator]


def from_zarr(source: Any, *, inline_data: bool = True) -> Document:
    """Convert an existing Zarr v3 hierarchy into a zarr-inline document.

    ``source`` is a filesystem path, a zarr ``Store``, or an open ``Group``.
    With ``inline_data=True`` every array is re-encoded with the ``json``
    codec (chunks become human-readable JSON arrays; the original codec
    chain is replaced — an array whose dtype the codec cannot represent
    raises). With ``inline_data=False`` every store key is copied
    byte-for-byte (original codecs kept; chunks appear as base64).
    """
    src_root = _open_group(source)
    document: Document = {}
    if inline_data:
        from zarr_inline.backing import MemoryBacking

        backing = MemoryBacking(document)
        dst_root = zarr.open_group(store=ZarrInlineStore(backing), mode="w")
        _copy_inline(src_root, dst_root)
        return backing.load()
    _copy_bytes(src_root, document)
    return document


def write_document(
    source: Any, path: "str | Path", *, inline_data: bool = True
) -> Document:
    """:func:`from_zarr`, saved to ``path`` as pretty-printed JSON."""
    document = from_zarr(source, inline_data=inline_data)
    Path(path).write_text(
        json.dumps(document, indent=2, ensure_ascii=False, allow_nan=False) + "\n"
    )
    return document


def to_zarr(document: "Document | str | Path", dest: Any) -> None:
    """Materialize a zarr-inline document onto a normal Zarr store.

    ``document`` is a parsed document or a path to a ``.json`` file;
    ``dest`` is a filesystem path or a writable zarr ``Store``. Every key is
    written byte-for-byte (the exact bytes a Zarr library would read), so
    the result is an ordinary hierarchy any Zarr implementation can open.
    """
    if isinstance(document, (str, Path)):
        from zarr_inline.document import strict_loads

        parsed = strict_loads(Path(document).read_text())
        if not isinstance(parsed, dict):
            raise ValueError("document file must hold a JSON object")
        document = parsed
    if isinstance(dest, (str, Path)):
        dest = zarr.storage.LocalStore(str(dest))
    if not isinstance(dest, Store):
        raise TypeError(
            f"dest must be a path or a zarr Store; got {type(dest).__name__}"
        )
    prototype = default_buffer_prototype()
    for key in sorted(document):
        data = decode_value(key, document[key])
        sync(dest.set(key, prototype.buffer.from_bytes(data)))


def _load_document(document: "Document | str | Path") -> Document:
    if isinstance(document, (str, Path)):
        from zarr_inline.document import strict_loads

        parsed = strict_loads(Path(document).read_text())
        if not isinstance(parsed, dict):
            raise ValueError("document file must hold a JSON object")
        return parsed
    return document


def open_document(document: "Document | str | Path", *, mode: str = "r") -> zarr.Group:
    """Open a zarr-inline document (parsed, or a ``.json`` file path) as a
    zarr ``Group`` in one call.

    ``mode="r"`` (the default) opens read-only over the parsed document;
    other modes open writable — for a file path, mutations persist back to
    the file automatically.
    """
    from zarr_inline.backing import FileBacking, MemoryBacking

    read_only = mode == "r"
    if isinstance(document, (str, Path)) and not read_only:
        backing: Any = FileBacking(document)
    else:
        backing = MemoryBacking(_load_document(document))
    store = ZarrInlineStore(backing, read_only=read_only)
    return zarr.open_group(store=store, mode=mode)


def verify_document(document: "Document | str | Path", source: Any) -> None:
    """Assert that ``document`` round-trips ``source``: same nodes, same
    attributes, same array data (NaN-aware). Raises ``AssertionError``
    naming the first mismatching path.
    """
    import numpy as np

    src_root = _open_group(source)
    doc_root = open_document(document)
    assert dict(doc_root.attrs) == dict(src_root.attrs), "root attributes differ"
    src_members = dict(src_root.members(max_depth=None))
    doc_members = dict(doc_root.members(max_depth=None))
    assert src_members.keys() == doc_members.keys(), (
        f"member sets differ: only in source {sorted(src_members.keys() - doc_members.keys())}, "
        f"only in document {sorted(doc_members.keys() - src_members.keys())}"
    )
    for path, node in src_members.items():
        other = doc_members[path]
        assert dict(other.attrs) == dict(node.attrs), f"{path}: attributes differ"
        if isinstance(node, zarr.Array):
            assert node.shape == other.shape, f"{path}: shapes differ"
            assert node.dtype == other.dtype, f"{path}: dtypes differ"
            equal_nan = node.dtype.kind in "fc"
            assert np.array_equal(node[...], other[...], equal_nan=equal_nan), (
                f"{path}: values differ"
            )
