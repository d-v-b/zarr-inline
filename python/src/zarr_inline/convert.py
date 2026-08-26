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
chunk payloads appear as base64 strings. ``inline_data="auto"`` inlines
every array the codec supports and falls back to the byte-for-byte copy
per array for the rest.
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


class DocumentMismatchError(ValueError):
    """Raised by :func:`verify_document` when a document does not round-trip
    its source hierarchy. The message names the first mismatching path."""



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


def _copy_inline(
    src_root: zarr.Group, dst_root: zarr.Group, document: Document, *, fallback: bool
) -> None:
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
            try:
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
            except (TypeError, ValueError) as exc:
                if not fallback:
                    reason = str(exc).rstrip(".")
                    raise ValueError(
                        f"array {path!r} (dtype {node.dtype}) cannot be "
                        f"inlined with the json codec: {reason}. Convert "
                        'with inline_data="auto" to keep this array '
                        "byte-faithful (base64) while inlining the rest, or "
                        "inline_data=False for a fully byte-faithful "
                        "document."
                    ) from exc
                # Purge anything a partly-failed create/write left behind,
                # then keep this array's original keys verbatim.
                for key in [
                    k
                    for k in document
                    if k == path or k.startswith(path + "/")
                ]:
                    del document[key]
                _copy_bytes(src_root, document, subpath=path)


def _copy_bytes(src_root: zarr.Group, document: Document, subpath: str = "") -> None:
    store = src_root.store_path.store
    prefix = src_root.store_path.path
    if prefix:
        prefix = prefix.rstrip("/") + "/"
    scope = prefix + (subpath + "/" if subpath else "")
    prototype = default_buffer_prototype()
    keys = sorted(sync(_collect(store.list_prefix(scope))))
    for key in keys:
        buffer = sync(store.get(key, prototype))
        if buffer is None:  # pragma: no cover - listed keys should exist
            continue
        relative = key[len(prefix) :]
        document[relative] = encode_value(relative, buffer.to_bytes())


async def _collect(iterator: Any) -> list[str]:
    return [key async for key in iterator]


def from_zarr(source: Any, *, inline_data: "bool | str" = True) -> Document:
    """Convert an existing Zarr v3 hierarchy into a zarr-inline document.

    ``source`` is a filesystem path, a zarr ``Store``, or an open ``Group``.
    With ``inline_data=True`` every array is re-encoded with the ``json``
    codec (chunks become human-readable JSON arrays; the original codec
    chain is replaced). An array whose dtype the codec cannot represent
    raises a ``ValueError`` naming the array. ``inline_data="auto"`` inlines
    every array the codec supports and copies the rest byte-for-byte, so
    one stubborn dtype does not cost the whole document its legibility.
    ``inline_data=False`` copies every store key byte-for-byte (original
    codecs kept; chunks appear as base64).

    Each array is read fully into memory during conversion: like the format
    itself, this is intended for *small* hierarchies. Nothing guards
    against pointing it at a hierarchy larger than available memory.
    """
    if inline_data not in (True, False, "auto"):
        raise ValueError(
            f'inline_data must be True, False, or "auto"; got {inline_data!r}'
        )
    src_root = _open_group(source)
    document: Document = {}
    if inline_data:
        from zarr_inline.backing import MemoryBacking

        backing = MemoryBacking(document)
        dst_root = zarr.open_group(store=ZarrInlineStore(backing), mode="w")
        _copy_inline(src_root, dst_root, document, fallback=inline_data == "auto")
        return backing.load()
    _copy_bytes(src_root, document)
    return document


def write_document(
    source: Any, path: "str | Path", *, inline_data: "bool | str" = True
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
    """Check that ``document`` round-trips ``source``: same nodes, same
    attributes, same array data (compared as *values*, NaN-aware — not
    bytes; the legible form deliberately re-encodes). Raises
    :class:`DocumentMismatchError` naming the first mismatching path;
    returns ``None`` when everything matches.
    """
    import numpy as np

    def check(condition: bool, message: str) -> None:
        if not condition:
            raise DocumentMismatchError(message)

    src_root = _open_group(source)
    doc_root = open_document(document)
    check(dict(doc_root.attrs) == dict(src_root.attrs), "root attributes differ")
    src_members = dict(src_root.members(max_depth=None))
    doc_members = dict(doc_root.members(max_depth=None))
    check(
        src_members.keys() == doc_members.keys(),
        "member sets differ: only in source "
        f"{sorted(src_members.keys() - doc_members.keys())}, only in document "
        f"{sorted(doc_members.keys() - src_members.keys())}",
    )
    for path, node in src_members.items():
        other = doc_members[path]
        check(dict(other.attrs) == dict(node.attrs), f"{path}: attributes differ")
        if isinstance(node, zarr.Array):
            check(node.shape == other.shape, f"{path}: shapes differ")
            check(node.dtype == other.dtype, f"{path}: dtypes differ")
            equal_nan = node.dtype.kind in "fc"
            check(
                bool(np.array_equal(node[...], other[...], equal_nan=equal_nan)),
                f"{path}: values differ",
            )
