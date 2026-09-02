"""Export a zarr-inline document as a kerchunk reference set.

kerchunk's reference format (as read by fsspec's ``ReferenceFileSystem``)
is the same shape as a zarr-inline document — store keys mapping to
values — with a different value encoding: inline text is a plain string
and inline bytes are a ``base64:``-prefixed string. The mapping is
mechanical, so any fsspec-based reader can open a zarr-inline document
without the store.
"""

from __future__ import annotations

from zarr_inline.backing import Document
from zarr_inline.document import decode_value


def to_kerchunk(document: Document) -> dict:
    """Return ``{"version": 1, "refs": {...}}`` for ``document``.

    Metadata objects and inline arrays/objects become their canonical JSON
    text; base64 byte values become ``"base64:<payload>"``. Every key's
    decoded bytes are identical to what a zarr-inline store would serve.
    """
    refs: dict[str, str] = {}
    for key, value in document.items():
        if isinstance(value, str):
            refs[key] = f"base64:{value}"
        else:
            refs[key] = decode_value(key, value).decode("utf-8")
    return {"version": 1, "refs": refs}
