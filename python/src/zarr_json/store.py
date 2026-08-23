"""ZarrJsonStore: a read-write zarr.abc.store.Store backed by a JSON object."""

from __future__ import annotations

import asyncio
import warnings
from collections.abc import AsyncIterator, Iterable
from typing import Any

from zarr.abc.store import (
    ByteRequest,
    OffsetByteRequest,
    RangeByteRequest,
    Store,
    SuffixByteRequest,
)
from zarr.core.buffer import Buffer, BufferPrototype

from zarr_json.backing import Backing
from zarr_json.codec import canonical_dumps, decode_value, encode_value, is_metadata_key
from zarr_json.validator import Strictness, check_key, validate


def _apply_byte_range(data: bytes, byte_range: ByteRequest | None) -> bytes:
    if byte_range is None:
        return data
    if isinstance(byte_range, RangeByteRequest):
        return data[byte_range.start : byte_range.end]
    if isinstance(byte_range, OffsetByteRequest):
        return data[byte_range.offset :]
    if isinstance(byte_range, SuffixByteRequest):
        # Index arithmetic, not negative slicing: data[-0:] would wrongly
        # return the whole object instead of empty bytes.
        return data[max(0, len(data) - byte_range.suffix) :]
    raise ValueError(f"unsupported byte range: {byte_range!r}")


class ZarrJsonStore(Store):
    """A Zarr v3 store whose entire contents live in one JSON object.

    Construct from a Backing (memory / file / string). All operations are
    serialized by an asyncio.Lock. The lock serializes operations within a
    single event loop; a store is not safe to share across threads. Mutating
    operations call backing.persist().
    """

    def __init__(
        self,
        backing: Backing,
        *,
        read_only: bool = False,
        strictness: Strictness = Strictness.LENIENT,
    ) -> None:
        super().__init__(read_only=read_only)
        self._backing = backing
        self._document = backing.load()
        # Lenient mode: keys with validation issues behave as absent (SPEC
        # 8.1) while staying in the document text, so values this version
        # does not understand are never destroyed by a re-persist. A
        # successful set or delete clears the key's skip.
        self._skipped: set[str] = set()
        if strictness is Strictness.STRICT:
            validate(self._document, strictness=Strictness.STRICT)
        else:
            for issue in validate(self._document):
                self._skipped.add(issue.key)
                warnings.warn(
                    f"zarr-json validation [{issue.rule}] {issue.key}: {issue.message}",
                    stacklevel=2,
                )
        self._lock = asyncio.Lock()

    def with_read_only(self, read_only: bool = False) -> "ZarrJsonStore":
        """Return a new ZarrJsonStore over the same backing with the given read_only flag."""
        new_store = ZarrJsonStore(self._backing, read_only=read_only)
        # Reassign to the caller's live document rather than the freshly-loaded
        # copy produced by __init__.  This keeps both stores sharing the exact
        # same dict object by identity (required by __eq__ / __hash__) and
        # ensures that any in-memory mutations made since the last persist() are
        # immediately visible on the new store without an extra backing.load().
        new_store._document = self._document
        new_store._skipped = self._skipped
        return new_store

    @property
    def supports_writes(self) -> bool:
        return True

    @property
    def supports_deletes(self) -> bool:
        return True

    @property
    def supports_listing(self) -> bool:
        return True

    @property
    def supports_partial_writes(self) -> bool:
        return False

    def __eq__(self, other: object) -> bool:
        return isinstance(other, ZarrJsonStore) and other._document is self._document

    def __hash__(self) -> int:
        return id(self._document)

    async def get(
        self,
        key: str,
        prototype: BufferPrototype,
        byte_range: ByteRequest | None = None,
    ) -> Buffer | None:
        async with self._lock:
            if not self._present(key):
                return None
            data = decode_value(key, self._document[key])
        return prototype.buffer.from_bytes(_apply_byte_range(data, byte_range))

    async def get_partial_values(
        self,
        prototype: BufferPrototype,
        key_ranges: Iterable[tuple[str, ByteRequest | None]],
    ) -> list[Buffer | None]:
        results: list[Buffer | None] = []
        for key, byte_range in key_ranges:
            results.append(await self.get(key, prototype, byte_range))
        return results

    async def set(self, key: str, value: Buffer) -> None:
        await self._set_bytes(key, value.to_bytes())

    async def set_json(self, key: str, value: Any) -> None:
        """Store a JSON value at ``key``, canonicalized first.

        Equivalent to ``set(key, canonical_dumps(value).encode())`` — the
        value is guaranteed to land in the document as its inline JSON
        representation (the canonical bytes always pass the lossless-inlining
        check), so callers need not produce canonical text themselves. The
        value must fit the key's representation (R2): a JSON object at a
        metadata key, a JSON array or object at a byte key.
        """
        if is_metadata_key(key):
            if not isinstance(value, dict):
                raise ValueError(
                    f"set_json: metadata key {key!r} takes a JSON object"
                )
        elif not isinstance(value, (list, dict)):
            raise ValueError(
                f"set_json: byte key {key!r} takes a JSON array or object"
            )
        await self._set_bytes(key, canonical_dumps(value).encode("utf-8"))

    async def _set_bytes(self, key: str, data: bytes) -> None:
        self._check_writable()
        # The Zarr v3 spec defines well-formed store keys; rejecting the rest
        # here keeps every document this store produces valid (R1).
        issue = check_key(key)
        if issue is not None:
            raise ValueError(f"invalid store key {key!r}: {issue.message}")
        encoded = encode_value(key, data)
        async with self._lock:
            # A failed set MUST leave the document unchanged (SPEC 8.2): if
            # persist raises, restore the previous entry before re-raising.
            missing = object()
            previous = self._document.get(key, missing)
            self._document[key] = encoded
            try:
                self._backing.persist(self._document)
            except BaseException:
                if previous is missing:
                    del self._document[key]
                else:
                    self._document[key] = previous
                raise
            self._skipped.discard(key)

    async def delete(self, key: str) -> None:
        self._check_writable()
        async with self._lock:
            missing = object()
            previous = self._document.pop(key, missing)
            try:
                self._backing.persist(self._document)
            except BaseException:
                if previous is not missing:
                    self._document[key] = previous
                raise
            self._skipped.discard(key)

    def _present(self, key: str) -> bool:
        return key in self._document and key not in self._skipped

    def _keys(self) -> list[str]:
        return [k for k in self._document if k not in self._skipped]

    async def exists(self, key: str) -> bool:
        async with self._lock:
            return self._present(key)

    async def list(self) -> AsyncIterator[str]:
        async with self._lock:
            keys = self._keys()
        for key in keys:
            yield key

    async def list_prefix(self, prefix: str) -> AsyncIterator[str]:
        async with self._lock:
            keys = [k for k in self._keys() if k.startswith(prefix)]
        for key in keys:
            yield key

    async def list_dir(self, prefix: str) -> AsyncIterator[str]:
        async with self._lock:
            keys = self._keys()
        seen: set[str] = set()
        for key in keys:
            if not key.startswith(prefix):
                continue
            remainder = key[len(prefix) :]
            child = remainder.split("/", 1)[0]
            if child and child not in seen:
                seen.add(child)
                yield child
