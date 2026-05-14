import asyncio

import pytest
from zarr.core.buffer import default_buffer_prototype
from zarr.core.buffer.cpu import Buffer

from zarr_json.backing import MemoryBacking
from zarr_json.store import ZarrJsonStore

PROTOTYPE = default_buffer_prototype()


def buf(data: bytes) -> Buffer:
    return Buffer.from_bytes(data)


async def test_get_metadata_key_returns_json_bytes():
    store = ZarrJsonStore(MemoryBacking({"zarr.json": {"node_type": "group"}}))
    result = await store.get("zarr.json", PROTOTYPE)
    assert result is not None
    import json
    assert json.loads(result.to_bytes()) == {"node_type": "group"}


async def test_get_byte_key_base64_decodes():
    store = ZarrJsonStore(MemoryBacking({"a/c/0": "AAECAwQFBgc="}))
    result = await store.get("a/c/0", PROTOTYPE)
    assert result is not None
    assert result.to_bytes() == bytes(range(8))


async def test_get_missing_key_returns_none():
    store = ZarrJsonStore(MemoryBacking({}))
    assert await store.get("nope", PROTOTYPE) is None


async def test_set_byte_key_stores_base64():
    backing = MemoryBacking({})
    store = ZarrJsonStore(backing)
    await store.set("a/c/0", buf(bytes(range(8))))
    assert backing.load()["a/c/0"] == "AAECAwQFBgc="


async def test_set_metadata_key_stores_object():
    backing = MemoryBacking({})
    store = ZarrJsonStore(backing)
    await store.set("zarr.json", buf(b'{"node_type": "group"}'))
    assert backing.load()["zarr.json"] == {"node_type": "group"}


async def test_set_then_get_round_trips_bytes():
    store = ZarrJsonStore(MemoryBacking({}))
    await store.set("a/c/0", buf(b"\x00\xff\x10"))
    result = await store.get("a/c/0", PROTOTYPE)
    assert result.to_bytes() == b"\x00\xff\x10"


async def test_get_with_range_byte_request():
    from zarr.abc.store import RangeByteRequest

    store = ZarrJsonStore(MemoryBacking({"a/c/0": "AAECAwQFBgc="}))
    result = await store.get("a/c/0", PROTOTYPE, RangeByteRequest(2, 5))
    assert result.to_bytes() == bytes([2, 3, 4])


async def test_delete_removes_key():
    backing = MemoryBacking({"a/c/0": "AAA="})
    store = ZarrJsonStore(backing)
    await store.delete("a/c/0")
    assert "a/c/0" not in backing.load()


async def test_exists_reflects_membership():
    store = ZarrJsonStore(MemoryBacking({"zarr.json": {"node_type": "group"}}))
    assert await store.exists("zarr.json") is True
    assert await store.exists("missing") is False


async def test_list_yields_all_keys():
    store = ZarrJsonStore(
        MemoryBacking({"zarr.json": {}, "a/zarr.json": {}, "a/c/0": "AAA="})
    )
    keys = sorted([k async for k in store.list()])
    assert keys == ["a/c/0", "a/zarr.json", "zarr.json"]


async def test_list_prefix_filters_by_prefix():
    store = ZarrJsonStore(
        MemoryBacking({"zarr.json": {}, "a/zarr.json": {}, "a/c/0": "AAA="})
    )
    keys = sorted([k async for k in store.list_prefix("a/")])
    assert keys == ["a/c/0", "a/zarr.json"]


async def test_list_dir_yields_immediate_children_only():
    store = ZarrJsonStore(
        MemoryBacking(
            {"zarr.json": {}, "a/zarr.json": {}, "a/c/0": "AAA=", "a/b/zarr.json": {}}
        )
    )
    children = sorted([k async for k in store.list_dir("a/")])
    assert children == ["b", "c", "zarr.json"]


async def test_concurrent_sets_are_serialized_by_lock():
    # 50 concurrent writes to distinct keys; all must land.
    store = ZarrJsonStore(MemoryBacking({}))
    await asyncio.gather(
        *(store.set(f"a/c/{i}", buf(bytes([i]))) for i in range(50))
    )
    keys = sorted([k async for k in store.list()])
    assert keys == sorted(f"a/c/{i}" for i in range(50))


async def test_store_capability_flags():
    store = ZarrJsonStore(MemoryBacking({}))
    assert store.supports_writes is True
    assert store.supports_deletes is True
    assert store.supports_listing is True
