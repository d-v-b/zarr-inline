"""Pluggable backings: where the zarr-inline object lives and how it persists.

A Backing has two operations: load() returns the document object, persist()
writes a document object. The store logic is identical regardless of backing.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from zarr_inline.document import strict_loads

Document = dict[str, Any]


def require_document(value: Any) -> Document:
    """A document's top-level value must be a JSON object (SPEC 6)."""
    if not isinstance(value, dict):
        raise ValueError(
            "document error: top-level value must be a JSON object, "
            f"got {type(value).__name__}"
        )
    return value


@runtime_checkable
class Backing(Protocol):
    """Where a zarr-inline document lives and how it persists.

    The store calls ``load()`` exactly once to obtain the document, mutates
    that document in place, then calls ``persist()`` after each mutation.
    """

    def load(self) -> Document: ...
    def persist(self, document: Document) -> None: ...


class MemoryBacking:
    """Holds the document in memory; the in-memory object is the source of truth."""

    def __init__(self, document: Document | None = None) -> None:
        self._document: Document = (
            require_document(document) if document is not None else {}
        )

    def load(self) -> Document:
        return self._document

    def persist(self, document: Document) -> None:
        # The store mutates the same object it loaded; persist just records it.
        self._document = document


class StringBacking:
    """Parses the document from a string; persist updates the dumped string."""

    def __init__(self, text: str = "{}") -> None:
        self._text = text

    def load(self) -> Document:
        """Parse and return the document. Call once; see the Backing contract."""
        return require_document(strict_loads(self._text))

    def persist(self, document: Document) -> None:
        self._text = json.dumps(document, ensure_ascii=False, allow_nan=False)

    def dumps(self) -> str:
        return self._text


class FileBacking:
    """Reads from / writes to a .json file on disk.

    ``path`` is required. A path that does not yet exist represents a new,
    empty document; ``None`` is not a path and is not accepted.
    """

    def __init__(self, path: str | Path) -> None:
        self._path = Path(path)

    def load(self) -> Document:
        """Read and return the document; a missing file yields a new empty
        document (detached — the store must call persist() to write it)."""
        if not self._path.exists():
            return {}
        return require_document(strict_loads(self._path.read_text()))

    def persist(self, document: Document) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(
            json.dumps(document, ensure_ascii=False, allow_nan=False, indent=2)
        )
