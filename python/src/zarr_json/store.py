"""ZarrJsonStore: a read-write zarr.abc.store.Store backed by a JSON object."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Iterable

from zarr.abc.store import (
    ByteRequest,
    OffsetByteRequest,
    RangeByteRequest,
    Store,
    SuffixByteRequest,
)
from zarr.core.buffer import Buffer, BufferPrototype

from zarr_json.backing import Backing
from zarr_json.codec import decode_value, encode_value


def _apply_byte_range(data: bytes, byte_range: ByteRequest | None) -> bytes:
    if byte_range is None:
        return data
    if isinstance(byte_range, RangeByteRequest):
        return data[byte_range.start : byte_range.end]
    if isinstance(byte_range, OffsetByteRequest):
        return data[byte_range.offset :]
    if isinstance(byte_range, SuffixByteRequest):
        return data[-byte_range.suffix :]
    raise ValueError(f"unsupported byte range: {byte_range!r}")


class ZarrJsonStore(Store):
    """A Zarr v3 store whose entire contents live in one JSON object.

    Construct from a Backing (memory / file / string). All operations are
    serialized by an asyncio.Lock. Mutating operations call backing.persist().
    """

    def __init__(self, backing: Backing) -> None:
        super().__init__(read_only=False)
        self._backing = backing
        self._document = backing.load()
        self._lock = asyncio.Lock()

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
            if key not in self._document:
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
        async with self._lock:
            self._document[key] = encode_value(key, value.to_bytes())
            self._backing.persist(self._document)

    async def delete(self, key: str) -> None:
        async with self._lock:
            self._document.pop(key, None)
            self._backing.persist(self._document)

    async def exists(self, key: str) -> bool:
        async with self._lock:
            return key in self._document

    async def list(self) -> AsyncIterator[str]:
        async with self._lock:
            keys = list(self._document.keys())
        for key in keys:
            yield key

    async def list_prefix(self, prefix: str) -> AsyncIterator[str]:
        async with self._lock:
            keys = [k for k in self._document if k.startswith(prefix)]
        for key in keys:
            yield key

    async def list_dir(self, prefix: str) -> AsyncIterator[str]:
        async with self._lock:
            keys = list(self._document.keys())
        seen: set[str] = set()
        for key in keys:
            if not key.startswith(prefix):
                continue
            remainder = key[len(prefix) :]
            child = remainder.split("/", 1)[0]
            if child and child not in seen:
                seen.add(child)
                yield child
