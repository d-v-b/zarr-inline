"""zarr-inline: store a Zarr v3 hierarchy as a single JSON object."""

from zarr_inline.backing import Backing, FileBacking, MemoryBacking, StringBacking
from zarr_inline.convert import (
    DocumentMismatchError,
    from_zarr,
    open_document,
    to_zarr,
    verify_document,
    write_document,
)
from zarr_inline.kerchunk import to_kerchunk
from zarr_inline.serializer import JsonSerializer
from zarr_inline.store import ZarrInlineStore
from zarr_inline.validator import (
    Strictness,
    ValidationError,
    ValidationIssue,
    validate,
)

__all__ = [
    "Backing",
    "DocumentMismatchError",
    "FileBacking",
    "from_zarr",
    "JsonSerializer",
    "MemoryBacking",
    "open_document",
    "StringBacking",
    "to_kerchunk",
    "to_zarr",
    "Strictness",
    "ValidationError",
    "ValidationIssue",
    "ZarrInlineStore",
    "validate",
    "verify_document",
    "write_document",
]
