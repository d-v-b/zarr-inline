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


async def test_concurrent_sets_all_land():
    # 50 concurrent writes to distinct keys; all must land. (Distinct keys
    # would survive even without a lock — this checks completeness, not
    # serialization; see test_concurrent_mutations_keep_document_consistent.)
    store = ZarrJsonStore(MemoryBacking({}))
    await asyncio.gather(
        *(store.set(f"a/c/{i}", buf(bytes([i]))) for i in range(50))
    )
    keys = sorted([k async for k in store.list()])
    assert keys == sorted(f"a/c/{i}" for i in range(50))


async def test_concurrent_mutations_keep_document_consistent():
    # Contention on the SAME key: interleaved set/delete. Whatever the final
    # state, the lock must guarantee the document is internally consistent —
    # the key is either present with a well-formed base64 value or absent,
    # never a half-written entry — and every operation completes without error.
    store = ZarrJsonStore(MemoryBacking({}))

    async def setter():
        for _ in range(50):
            await store.set("a/c/0", buf(b"\x01\x02\x03"))

    async def deleter():
        for _ in range(50):
            await store.delete("a/c/0")

    await asyncio.gather(setter(), deleter(), setter(), deleter())

    # Document is in a consistent state: key absent, or present and decodable.
    if await store.exists("a/c/0"):
        result = await store.get("a/c/0", PROTOTYPE)
        assert result.to_bytes() == b"\x01\x02\x03"


async def test_store_capability_flags():
    store = ZarrJsonStore(MemoryBacking({}))
    assert store.supports_writes is True
    assert store.supports_deletes is True
    assert store.supports_listing is True


async def test_get_with_offset_byte_request():
    from zarr.abc.store import OffsetByteRequest

    store = ZarrJsonStore(MemoryBacking({"a/c/0": "AAECAwQFBgc="}))
    result = await store.get("a/c/0", PROTOTYPE, OffsetByteRequest(5))
    assert result.to_bytes() == bytes([5, 6, 7])


async def test_get_with_suffix_byte_request():
    from zarr.abc.store import SuffixByteRequest

    store = ZarrJsonStore(MemoryBacking({"a/c/0": "AAECAwQFBgc="}))
    result = await store.get("a/c/0", PROTOTYPE, SuffixByteRequest(3))
    assert result.to_bytes() == bytes([5, 6, 7])


async def test_get_with_zero_suffix_byte_request_returns_empty():
    from zarr.abc.store import SuffixByteRequest

    store = ZarrJsonStore(MemoryBacking({"a/c/0": "AAECAwQFBgc="}))
    result = await store.get("a/c/0", PROTOTYPE, SuffixByteRequest(0))
    assert result.to_bytes() == b""


async def test_read_only_store_rejects_set():
    store = ZarrJsonStore(MemoryBacking({}), read_only=True)
    with pytest.raises(ValueError):
        await store.set("a/c/0", buf(b"\x00"))


async def test_read_only_store_rejects_delete():
    store = ZarrJsonStore(MemoryBacking({"a/c/0": "AA=="}), read_only=True)
    with pytest.raises(ValueError):
        await store.delete("a/c/0")


async def test_with_read_only_returns_enforcing_store_sharing_document():
    backing = MemoryBacking({"a/c/0": "AA=="})
    store = ZarrJsonStore(backing)
    ro = store.with_read_only(True)
    # shares the same document by identity
    assert ro._document is store._document
    # and actually enforces read-only
    with pytest.raises(ValueError):
        await ro.set("a/c/1", buf(b"\x01"))


async def test_strict_mode_rejects_invalid_document_on_construction():
    from zarr_json.validator import Strictness, ValidationError

    # metadata key mapping to a non-object value violates R2
    with pytest.raises(ValidationError):
        ZarrJsonStore(MemoryBacking({"zarr.json": "not an object"}), strictness=Strictness.STRICT)


async def test_strict_mode_accepts_valid_document_on_construction():
    from zarr_json.validator import Strictness

    # construction must succeed without raising
    store = ZarrJsonStore(
        MemoryBacking({"zarr.json": {"node_type": "group"}}), strictness=Strictness.STRICT
    )
    assert await store.exists("zarr.json") is True


async def test_lenient_mode_warns_on_invalid_document_but_constructs():
    import warnings as _warnings

    with _warnings.catch_warnings(record=True) as caught:
        _warnings.simplefilter("always")
        store = ZarrJsonStore(MemoryBacking({"zarr.json": "not an object"}))
    # construction succeeded
    assert store is not None
    # at least one validation warning was surfaced
    assert any("zarr-json validation" in str(w.message) for w in caught)


async def test_lenient_mode_no_warning_on_valid_document():
    import warnings as _warnings

    with _warnings.catch_warnings(record=True) as caught:
        _warnings.simplefilter("always")
        ZarrJsonStore(MemoryBacking({"zarr.json": {"node_type": "group"}}))
    assert not any("zarr-json validation" in str(w.message) for w in caught)


async def test_set_rejects_malformed_store_key():
    import pytest
    from zarr.core.buffer import default_buffer_prototype

    from zarr_json import MemoryBacking, ZarrJsonStore

    store = ZarrJsonStore(MemoryBacking({}))
    buf = default_buffer_prototype().buffer.from_bytes(b"x")
    for bad in ("", "/a", "a/", "a//b", "a/./b", "a/../b", ".."):
        with pytest.raises(ValueError, match="invalid store key"):
            await store.set(bad, buf)
    assert MemoryBacking({}).load() == {}


async def test_failed_persist_leaves_document_unchanged():
    from zarr.core.buffer import default_buffer_prototype

    from zarr_json import MemoryBacking, ZarrJsonStore

    class FlakyBacking:
        def __init__(self):
            self.inner = MemoryBacking({"keep/c/0": "AAEC"})
            self.fail = False

        def load(self):
            return self.inner.load()

        def persist(self, document):
            if self.fail:
                raise OSError("disk full")
            self.inner.persist(document)

    backing = FlakyBacking()
    store = ZarrJsonStore(backing)
    proto = default_buffer_prototype()
    backing.fail = True
    with pytest.raises(OSError):
        await store.set("new/c/0", proto.buffer.from_bytes(b"\x01"))
    assert await store.get("new/c/0", proto) is None
    assert not await store.exists("new/c/0")
    with pytest.raises(OSError):
        await store.set("keep/c/0", proto.buffer.from_bytes(b"\x09"))
    assert (await store.get("keep/c/0", proto)).to_bytes() == b"\x00\x01\x02"
    with pytest.raises(OSError):
        await store.delete("keep/c/0")
    assert (await store.get("keep/c/0", proto)).to_bytes() == b"\x00\x01\x02"
    backing.fail = False
    await store.set("new/c/0", proto.buffer.from_bytes(b"\x01"))
    assert (await store.get("new/c/0", proto)).to_bytes() == b"\x01"


async def test_lenient_mode_treats_invalid_entries_as_absent_until_rewritten():
    import warnings

    from zarr.core.buffer import default_buffer_prototype

    from zarr_json import MemoryBacking, ZarrJsonStore

    backing = MemoryBacking({"bad/c/0": 123, "ok/c/0": "AAEC"})
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        store = ZarrJsonStore(backing)
    proto = default_buffer_prototype()
    assert not await store.exists("bad/c/0")
    assert await store.get("bad/c/0", proto) is None
    assert [k async for k in store.list()] == ["ok/c/0"]
    assert [k async for k in store.list_dir("")] == ["ok"]
    # The offending entry survives in the document text (never destroyed)...
    assert backing.load()["bad/c/0"] == 123
    # ...and a successful set makes the key live again.
    await store.set("bad/c/0", proto.buffer.from_bytes(b"\x07"))
    assert await store.exists("bad/c/0")
    assert sorted([k async for k in store.list()]) == ["bad/c/0", "ok/c/0"]


async def test_set_json_stores_inline_canonical_values():
    from zarr_json import MemoryBacking, ZarrJsonStore

    backing = MemoryBacking({})
    store = ZarrJsonStore(backing)
    await store.set_json("zarr.json", {"zarr_format": 3, "node_type": "group", "x": 1.0})
    await store.set_json("a/c/0", [1.5, float("-0.0"), 2, "NaN"])
    doc = backing.load()
    # Inline representations, canonicalized (1.0 -> 1, -0.0 -> 0).
    assert doc["zarr.json"] == {"zarr_format": 3, "node_type": "group", "x": 1}
    assert doc["a/c/0"] == [1.5, 0, 2, "NaN"]
    # Equivalent to set(key, canonical bytes): decoded bytes are canonical.
    from zarr.core.buffer import default_buffer_prototype

    proto = default_buffer_prototype()
    assert (await store.get("a/c/0", proto)).to_bytes() == b'[1.5,0,2,"NaN"]'


async def test_set_json_rejects_wrong_shape_for_key_class():
    from zarr_json import MemoryBacking, ZarrJsonStore

    store = ZarrJsonStore(MemoryBacking({}))
    with pytest.raises(ValueError, match="takes a JSON object"):
        await store.set_json("zarr.json", [1, 2])
    with pytest.raises(ValueError, match="takes a JSON array"):
        await store.set_json("a/c/0", {"not": "an array"})


async def test_set_json_rejects_non_canonicalizable_values():
    from zarr_json import MemoryBacking, ZarrJsonStore

    store = ZarrJsonStore(MemoryBacking({}))
    with pytest.raises(ValueError, match="non-finite"):
        await store.set_json("a/c/0", [float("nan")])
