"""zarr-inline: store a Zarr v3 hierarchy as a single JSON object."""

from zarr_inline.backing import Backing, FileBacking, MemoryBacking, StringBacking
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
    "FileBacking",
    "JsonSerializer",
    "MemoryBacking",
    "StringBacking",
    "Strictness",
    "ValidationError",
    "ValidationIssue",
    "ZarrInlineStore",
    "validate",
]
