import json

from zarr_json.backing import FileBacking, MemoryBacking, StringBacking


def test_memory_backing_load_returns_initial_object():
    backing = MemoryBacking({"zarr.json": {"node_type": "group"}})
    assert backing.load() == {"zarr.json": {"node_type": "group"}}


def test_memory_backing_persist_is_noop_and_keeps_object():
    backing = MemoryBacking({})
    backing.persist({"a/c/0": "AAA="})
    assert backing.load() == {"a/c/0": "AAA="}


def test_string_backing_load_parses_string():
    backing = StringBacking('{"zarr.json": {"node_type": "group"}}')
    assert backing.load() == {"zarr.json": {"node_type": "group"}}


def test_string_backing_persist_updates_dumped_string():
    backing = StringBacking("{}")
    backing.persist({"a/c/0": "AAA="})
    assert json.loads(backing.dumps()) == {"a/c/0": "AAA="}


def test_file_backing_round_trips_through_disk(tmp_path):
    path = tmp_path / "doc.json"
    path.write_text('{"zarr.json": {"node_type": "group"}}')
    backing = FileBacking(path)
    assert backing.load() == {"zarr.json": {"node_type": "group"}}
    backing.persist({"a/c/0": "AAA="})
    assert json.loads(path.read_text()) == {"a/c/0": "AAA="}


def test_file_backing_load_missing_file_returns_empty_document(tmp_path):
    backing = FileBacking(tmp_path / "does_not_exist.json")
    assert backing.load() == {}
