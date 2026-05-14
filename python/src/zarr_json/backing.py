"""Pluggable backings: where the zarr-json object lives and how it persists.

A Backing has two operations: load() returns the document object, persist()
writes a document object. The store logic is identical regardless of backing.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

Document = dict[str, Any]


@runtime_checkable
class Backing(Protocol):
    def load(self) -> Document: ...
    def persist(self, document: Document) -> None: ...


class MemoryBacking:
    """Holds the document in memory; the in-memory object is the source of truth."""

    def __init__(self, document: Document | None = None) -> None:
        self._document: Document = document if document is not None else {}

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
        return json.loads(self._text)

    def persist(self, document: Document) -> None:
        self._text = json.dumps(document)

    def dumps(self) -> str:
        return self._text


class FileBacking:
    """Reads from / writes to a .json file on disk."""

    def __init__(self, path: str | Path) -> None:
        self._path = Path(path)

    def load(self) -> Document:
        if not self._path.exists():
            return {}
        return json.loads(self._path.read_text())

    def persist(self, document: Document) -> None:
        self._path.write_text(json.dumps(document))
