# zarr-json Python Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Python reference implementation of zarr-json — a read-write `zarr.abc.store.Store` backed by a JSON object — plus the shared `examples/` conformance fixtures used by all three language implementations.

**Architecture:** A zarr-json document is a JSON object whose keys are Zarr v3 store keys. Keys ending in `zarr.json` (metadata keys) hold inline JSON objects; all other keys (byte keys) hold base64 strings. The store holds the parsed object in memory, guards it with a lock, and persists through a pluggable *backing* (memory / file / string). Pure functions handle key classification and value encode/decode; a validator checks the two validity rules; the `ZarrJsonStore` class wires these into the zarr-python v3 Store ABC.

**Tech Stack:** Python 3.12, `uv` for project/dependency management, `zarr` v3 (`zarr.abc.store.Store`), `pytest` + `pytest-asyncio` for tests. Standard library `base64`, `json`, `asyncio`.

---

## File Structure

All paths relative to repository root `/home/d-v-b/dev/zarr-json`.

- `examples/` — shared conformance fixtures (created in Task 1; consumed by all three implementations).
  - `examples/valid/` — valid zarr-json documents (`.json` files).
  - `examples/invalid/` — invalid zarr-json documents (`.json` files).
  - `examples/MANIFEST.json` — maps each fixture file to its expected validity verdict and, for invalid ones, the failing rule.
- `python/pyproject.toml` — uv project definition, deps, pytest config.
- `python/src/zarr_json/__init__.py` — public exports.
- `python/src/zarr_json/codec.py` — pure functions: key classification, value encode/decode.
- `python/src/zarr_json/validator.py` — the two validity rules; `validate()` and a `Strictness` enum.
- `python/src/zarr_json/backing.py` — `Backing` protocol + `MemoryBacking`, `FileBacking`, `StringBacking`.
- `python/src/zarr_json/store.py` — `ZarrJsonStore`, the `zarr.abc.store.Store` subclass.
- `python/tests/test_codec.py` — unit tests for `codec.py`.
- `python/tests/test_validator.py` — unit tests for `validator.py`, including all `examples/` fixtures.
- `python/tests/test_backing.py` — unit tests for the three backings.
- `python/tests/test_store.py` — unit tests for `ZarrJsonStore` operations + lock behavior.
- `python/tests/test_integration.py` — drives the store through zarr-python (create group + array, write/read chunks, list).
- `python/tests/conftest.py` — shared fixtures (path to `examples/`, sample documents).

**Key design facts referenced across tasks:**

- A *metadata key* is a key whose string value ends with `zarr.json` (e.g. `zarr.json`, `a/zarr.json`). Every other key is a *byte key*.
- In a zarr-json document, a metadata key maps to a JSON **object**; a byte key maps to a base64 **string**.
- `get` must return bytes: metadata key → `json.dumps(obj).encode("utf-8")`; byte key → `base64.b64decode(string)`.
- `set` receives bytes: metadata key → `json.loads(bytes)` (must be a dict); byte key → `base64.b64encode(bytes).decode("ascii")`.
- The two validity rules: **(R1) well-formed keys** — every key is a non-empty `str`, has no leading/trailing `/`, no empty segments (`//`), no `.`/`..` segments; **(R2) per-value type** — metadata keys map to `dict`, byte keys map to `str`.

---

## Task 1: Shared `examples/` conformance fixtures

**Files:**
- Create: `examples/valid/empty.json`
- Create: `examples/valid/group_only.json`
- Create: `examples/valid/group_with_array_and_chunk.json`
- Create: `examples/invalid/metadata_key_not_object.json`
- Create: `examples/invalid/byte_key_not_string.json`
- Create: `examples/invalid/leading_slash_key.json`
- Create: `examples/invalid/empty_segment_key.json`
- Create: `examples/MANIFEST.json`

- [ ] **Step 1: Create the valid fixtures**

`examples/valid/empty.json` — a valid (empty) store:

```json
{}
```

`examples/valid/group_only.json` — a root group, no arrays:

```json
{
  "zarr.json": {
    "zarr_format": 3,
    "node_type": "group",
    "attributes": {}
  }
}
```

`examples/valid/group_with_array_and_chunk.json` — root group, one array, one base64 chunk. The chunk value is the base64 of 8 bytes `00 01 02 03 04 05 06 07`:

```json
{
  "zarr.json": {
    "zarr_format": 3,
    "node_type": "group",
    "attributes": {}
  },
  "myarray/zarr.json": {
    "zarr_format": 3,
    "node_type": "array",
    "shape": [8],
    "data_type": "uint8",
    "chunk_grid": { "name": "regular", "configuration": { "chunk_shape": [8] } },
    "chunk_key_encoding": { "name": "default", "configuration": { "separator": "/" } },
    "fill_value": 0,
    "codecs": [ { "name": "bytes", "configuration": { "endian": "little" } } ],
    "attributes": {}
  },
  "myarray/c/0": "AAECAwQFBgc="
}
```

- [ ] **Step 2: Create the invalid fixtures**

`examples/invalid/metadata_key_not_object.json` — violates R2 (metadata key maps to a string):

```json
{
  "zarr.json": "not an object"
}
```

`examples/invalid/byte_key_not_string.json` — violates R2 (byte key maps to an object):

```json
{
  "zarr.json": {
    "zarr_format": 3,
    "node_type": "group",
    "attributes": {}
  },
  "myarray/c/0": { "not": "a string" }
}
```

`examples/invalid/leading_slash_key.json` — violates R1 (key has a leading slash):

```json
{
  "/zarr.json": {
    "zarr_format": 3,
    "node_type": "group",
    "attributes": {}
  }
}
```

`examples/invalid/empty_segment_key.json` — violates R1 (key has an empty segment `//`):

```json
{
  "a//zarr.json": {
    "zarr_format": 3,
    "node_type": "group",
    "attributes": {}
  }
}
```

- [ ] **Step 3: Create the manifest**

`examples/MANIFEST.json` — maps each fixture to its expected verdict. `rule` is `null` for valid fixtures, and `"R1"` or `"R2"` for invalid ones:

```json
{
  "valid/empty.json": { "valid": true, "rule": null },
  "valid/group_only.json": { "valid": true, "rule": null },
  "valid/group_with_array_and_chunk.json": { "valid": true, "rule": null },
  "invalid/metadata_key_not_object.json": { "valid": false, "rule": "R2" },
  "invalid/byte_key_not_string.json": { "valid": false, "rule": "R2" },
  "invalid/leading_slash_key.json": { "valid": false, "rule": "R1" },
  "invalid/empty_segment_key.json": { "valid": false, "rule": "R1" }
}
```

- [ ] **Step 4: Verify all fixtures are well-formed JSON**

Run: `python3 -c "import json,glob; [json.load(open(f)) for f in glob.glob('examples/**/*.json', recursive=True)]; print('all parse OK')"`
Expected: `all parse OK`

- [ ] **Step 5: Commit**

```bash
git add examples/
git commit -m "Add shared zarr-json conformance fixtures"
```

---

## Task 2: Python project scaffold

**Files:**
- Create: `python/pyproject.toml`
- Create: `python/src/zarr_json/__init__.py`
- Create: `python/tests/conftest.py`

- [ ] **Step 1: Create `python/pyproject.toml`**

```toml
[project]
name = "zarr-json"
version = "0.1.0"
description = "Store a Zarr v3 hierarchy as a single JSON object"
requires-python = ">=3.12"
dependencies = [
    "zarr>=3.0.0",
]

[dependency-groups]
dev = [
    "pytest>=8.0.0",
    "pytest-asyncio>=0.24.0",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/zarr_json"]

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
```

- [ ] **Step 2: Create an empty package init**

`python/src/zarr_json/__init__.py`:

```python
"""zarr-json: store a Zarr v3 hierarchy as a single JSON object."""
```

- [ ] **Step 3: Create `python/tests/conftest.py`**

```python
import json
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
EXAMPLES_DIR = REPO_ROOT / "examples"


@pytest.fixture
def examples_dir() -> Path:
    return EXAMPLES_DIR


@pytest.fixture
def manifest() -> dict:
    return json.loads((EXAMPLES_DIR / "MANIFEST.json").read_text())
```

- [ ] **Step 4: Install dependencies and verify the environment**

Run: `cd python && uv sync`
Expected: resolves and installs `zarr`, `pytest`, `pytest-asyncio` into `python/.venv`; no errors.

- [ ] **Step 5: Verify pytest runs (collecting zero tests is fine)**

Run: `cd python && uv run pytest -q`
Expected: `no tests ran` (exit code 5) — confirms pytest + config load correctly.

- [ ] **Step 6: Commit**

```bash
git add python/pyproject.toml python/src/zarr_json/__init__.py python/tests/conftest.py python/uv.lock
git commit -m "Scaffold Python zarr-json project"
```

---

## Task 3: `codec.py` — key classification

**Files:**
- Create: `python/src/zarr_json/codec.py`
- Test: `python/tests/test_codec.py`

- [ ] **Step 1: Write the failing test**

`python/tests/test_codec.py`:

```python
from zarr_json.codec import is_metadata_key


def test_root_zarr_json_is_metadata_key():
    assert is_metadata_key("zarr.json") is True


def test_nested_zarr_json_is_metadata_key():
    assert is_metadata_key("myarray/zarr.json") is True


def test_chunk_key_is_not_metadata_key():
    assert is_metadata_key("myarray/c/0/0") is False


def test_key_containing_but_not_ending_zarr_json_is_not_metadata():
    assert is_metadata_key("zarr.json/c/0") is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd python && uv run pytest tests/test_codec.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'zarr_json.codec'`

- [ ] **Step 3: Write minimal implementation**

`python/src/zarr_json/codec.py`:

```python
"""Pure functions for classifying keys and encoding/decoding values."""

METADATA_SUFFIX = "zarr.json"


def is_metadata_key(key: str) -> bool:
    """Return True if the key names a Zarr v3 metadata document."""
    return key.endswith(METADATA_SUFFIX)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd python && uv run pytest tests/test_codec.py -q`
Expected: PASS — 4 passed

- [ ] **Step 5: Commit**

```bash
git add python/src/zarr_json/codec.py python/tests/test_codec.py
git commit -m "Add key classification to zarr-json codec"
```

---

## Task 4: `codec.py` — value encode/decode

**Files:**
- Modify: `python/src/zarr_json/codec.py`
- Test: `python/tests/test_codec.py`

- [ ] **Step 1: Write the failing test**

Append to `python/tests/test_codec.py`:

```python
import pytest

from zarr_json.codec import decode_value, encode_value


def test_decode_metadata_value_serializes_object_to_json_bytes():
    out = decode_value("zarr.json", {"zarr_format": 3, "node_type": "group"})
    assert isinstance(out, bytes)
    import json
    assert json.loads(out) == {"zarr_format": 3, "node_type": "group"}


def test_decode_byte_value_base64_decodes_string():
    # base64 of bytes 00 01 02 03 04 05 06 07
    assert decode_value("a/c/0", "AAECAwQFBgc=") == bytes(range(8))


def test_encode_metadata_value_parses_json_bytes_to_object():
    raw = b'{"zarr_format": 3, "node_type": "array"}'
    assert encode_value("zarr.json", raw) == {"zarr_format": 3, "node_type": "array"}


def test_encode_byte_value_base64_encodes_bytes():
    assert encode_value("a/c/0", bytes(range(8))) == "AAECAwQFBgc="


def test_encode_metadata_value_rejects_non_object_json():
    with pytest.raises(ValueError, match="JSON object"):
        encode_value("zarr.json", b"[1, 2, 3]")


def test_round_trip_metadata():
    obj = {"zarr_format": 3, "node_type": "group", "attributes": {}}
    assert encode_value("zarr.json", decode_value("zarr.json", obj)) == obj


def test_round_trip_bytes():
    data = bytes([9, 8, 7, 0, 255, 1])
    assert decode_value("a/c/0", encode_value("a/c/0", data)) == data
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd python && uv run pytest tests/test_codec.py -q`
Expected: FAIL with `ImportError: cannot import name 'decode_value'`

- [ ] **Step 3: Write minimal implementation**

Append to `python/src/zarr_json/codec.py`:

```python
import base64
import json
from typing import Any

JsonValue = dict[str, Any]


def decode_value(key: str, value: Any) -> bytes:
    """Convert a stored zarr-json value into the bytes Zarr expects.

    Metadata keys hold a JSON object -> serialize to UTF-8 JSON bytes.
    Byte keys hold a base64 string -> base64-decode to raw bytes.
    """
    if is_metadata_key(key):
        if not isinstance(value, dict):
            raise ValueError(f"metadata key {key!r} must map to a JSON object")
        return json.dumps(value).encode("utf-8")
    if not isinstance(value, str):
        raise ValueError(f"byte key {key!r} must map to a base64 string")
    return base64.b64decode(value, validate=True)


def encode_value(key: str, data: bytes) -> Any:
    """Convert Zarr's bytes into the value stored in a zarr-json document.

    Metadata keys: parse bytes as JSON, require a JSON object.
    Byte keys: base64-encode the bytes.
    """
    if is_metadata_key(key):
        parsed = json.loads(data)
        if not isinstance(parsed, dict):
            raise ValueError(f"metadata key {key!r} requires a JSON object value")
        return parsed
    return base64.b64encode(data).decode("ascii")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd python && uv run pytest tests/test_codec.py -q`
Expected: PASS — 11 passed

- [ ] **Step 5: Commit**

```bash
git add python/src/zarr_json/codec.py python/tests/test_codec.py
git commit -m "Add value encode/decode to zarr-json codec"
```

---

## Task 5: `validator.py` — validity rules

**Files:**
- Create: `python/src/zarr_json/validator.py`
- Test: `python/tests/test_validator.py`

- [ ] **Step 1: Write the failing test**

`python/tests/test_validator.py`:

```python
import json

import pytest

from zarr_json.validator import Strictness, ValidationError, validate


def test_empty_document_is_valid():
    assert validate({}) == []


def test_valid_group_document_passes():
    doc = {"zarr.json": {"zarr_format": 3, "node_type": "group", "attributes": {}}}
    assert validate(doc) == []


def test_metadata_key_with_non_object_value_reports_r2():
    errors = validate({"zarr.json": "not an object"})
    assert len(errors) == 1
    assert errors[0].rule == "R2"
    assert errors[0].key == "zarr.json"


def test_byte_key_with_non_string_value_reports_r2():
    errors = validate({"a/c/0": {"not": "a string"}})
    assert len(errors) == 1
    assert errors[0].rule == "R2"


def test_leading_slash_key_reports_r1():
    errors = validate({"/zarr.json": {}})
    assert any(e.rule == "R1" for e in errors)


def test_empty_segment_key_reports_r1():
    errors = validate({"a//zarr.json": {}})
    assert any(e.rule == "R1" for e in errors)


def test_dot_segment_key_reports_r1():
    errors = validate({"a/./zarr.json": {}})
    assert any(e.rule == "R1" for e in errors)


def test_strict_mode_raises_on_invalid_document():
    with pytest.raises(ValidationError):
        validate({"zarr.json": "not an object"}, strictness=Strictness.STRICT)


def test_lenient_mode_returns_errors_without_raising():
    errors = validate({"zarr.json": "not an object"}, strictness=Strictness.LENIENT)
    assert len(errors) == 1


def test_all_manifest_fixtures_get_expected_verdict(examples_dir, manifest):
    for rel_path, expected in manifest.items():
        doc = json.loads((examples_dir / rel_path).read_text())
        errors = validate(doc)
        if expected["valid"]:
            assert errors == [], f"{rel_path} should be valid"
        else:
            assert errors, f"{rel_path} should be invalid"
            assert any(e.rule == expected["rule"] for e in errors), (
                f"{rel_path} should fail rule {expected['rule']}"
            )
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd python && uv run pytest tests/test_validator.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'zarr_json.validator'`

- [ ] **Step 3: Write minimal implementation**

`python/src/zarr_json/validator.py`:

```python
"""Validate a zarr-json document against the two validity rules.

R1 — well-formed keys: every key is a non-empty string with no leading or
     trailing "/", no empty segments, and no "." or ".." segments.
R2 — per-value type: metadata keys map to a JSON object (dict); byte keys
     map to a base64 string (str).
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any

from zarr_json.codec import is_metadata_key


class Strictness(Enum):
    STRICT = "strict"
    LENIENT = "lenient"


@dataclass(frozen=True)
class ValidationIssue:
    rule: str  # "R1" or "R2"
    key: str
    message: str


class ValidationError(Exception):
    """Raised by validate() in STRICT mode when a document is invalid."""

    def __init__(self, issues: list[ValidationIssue]) -> None:
        self.issues = issues
        joined = "; ".join(f"[{i.rule}] {i.key}: {i.message}" for i in issues)
        super().__init__(f"invalid zarr-json document: {joined}")


def _check_key_well_formed(key: str) -> ValidationIssue | None:
    if not isinstance(key, str) or key == "":
        return ValidationIssue("R1", str(key), "key must be a non-empty string")
    if key.startswith("/") or key.endswith("/"):
        return ValidationIssue("R1", key, "key must not have a leading or trailing '/'")
    segments = key.split("/")
    for seg in segments:
        if seg == "":
            return ValidationIssue("R1", key, "key must not have empty segments")
        if seg in (".", ".."):
            return ValidationIssue("R1", key, "key must not have '.' or '..' segments")
    return None


def _check_value_type(key: str, value: Any) -> ValidationIssue | None:
    if is_metadata_key(key):
        if not isinstance(value, dict):
            return ValidationIssue("R2", key, "metadata key must map to a JSON object")
    else:
        if not isinstance(value, str):
            return ValidationIssue("R2", key, "byte key must map to a base64 string")
    return None


def validate(
    document: dict[str, Any],
    strictness: Strictness = Strictness.LENIENT,
) -> list[ValidationIssue]:
    """Check a zarr-json document. Returns the list of issues (empty if valid).

    In STRICT mode, raises ValidationError if any issue is found.
    """
    issues: list[ValidationIssue] = []
    for key, value in document.items():
        key_issue = _check_key_well_formed(key)
        if key_issue is not None:
            issues.append(key_issue)
            continue  # value-type check on a malformed key is not meaningful
        value_issue = _check_value_type(key, value)
        if value_issue is not None:
            issues.append(value_issue)
    if strictness is Strictness.STRICT and issues:
        raise ValidationError(issues)
    return issues
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd python && uv run pytest tests/test_validator.py -q`
Expected: PASS — 10 passed

- [ ] **Step 5: Commit**

```bash
git add python/src/zarr_json/validator.py python/tests/test_validator.py
git commit -m "Add zarr-json document validator"
```

---

## Task 6: `backing.py` — pluggable backings

**Files:**
- Create: `python/src/zarr_json/backing.py`
- Test: `python/tests/test_backing.py`

- [ ] **Step 1: Write the failing test**

`python/tests/test_backing.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd python && uv run pytest tests/test_backing.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'zarr_json.backing'`

- [ ] **Step 3: Write minimal implementation**

`python/src/zarr_json/backing.py`:

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd python && uv run pytest tests/test_backing.py -q`
Expected: PASS — 6 passed

- [ ] **Step 5: Commit**

```bash
git add python/src/zarr_json/backing.py python/tests/test_backing.py
git commit -m "Add pluggable backings for zarr-json"
```

---

## Task 7: `store.py` — `ZarrJsonStore` core operations

**Files:**
- Create: `python/src/zarr_json/store.py`
- Test: `python/tests/test_store.py`

This task implements the `zarr.abc.store.Store` subclass. The store holds a document object (obtained from a backing), guards it with an `asyncio.Lock`, and uses `codec.py` to translate between stored values and Zarr's `Buffer` bytes. `get` honors `byte_range`. After every mutating operation it calls `backing.persist`.

- [ ] **Step 1: Write the failing test**

`python/tests/test_store.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd python && uv run pytest tests/test_store.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'zarr_json.store'`

- [ ] **Step 3: Write minimal implementation**

`python/src/zarr_json/store.py`:

```python
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

    def __eq__(self, other: object) -> bool:
        return isinstance(other, ZarrJsonStore) and other._document is self._document

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd python && uv run pytest tests/test_store.py -q`
Expected: PASS — 15 passed

- [ ] **Step 5: Commit**

```bash
git add python/src/zarr_json/store.py python/tests/test_store.py
git commit -m "Add ZarrJsonStore core operations"
```

---

## Task 8: Public exports

**Files:**
- Modify: `python/src/zarr_json/__init__.py`
- Test: `python/tests/test_codec.py` (append one import-surface test)

- [ ] **Step 1: Write the failing test**

Append to `python/tests/test_codec.py`:

```python
def test_public_api_is_importable_from_package_root():
    import zarr_json

    assert hasattr(zarr_json, "ZarrJsonStore")
    assert hasattr(zarr_json, "MemoryBacking")
    assert hasattr(zarr_json, "FileBacking")
    assert hasattr(zarr_json, "StringBacking")
    assert hasattr(zarr_json, "validate")
    assert hasattr(zarr_json, "Strictness")
    assert hasattr(zarr_json, "ValidationError")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd python && uv run pytest tests/test_codec.py::test_public_api_is_importable_from_package_root -q`
Expected: FAIL with `AttributeError: module 'zarr_json' has no attribute 'ZarrJsonStore'`

- [ ] **Step 3: Write minimal implementation**

Replace `python/src/zarr_json/__init__.py` with:

```python
"""zarr-json: store a Zarr v3 hierarchy as a single JSON object."""

from zarr_json.backing import Backing, FileBacking, MemoryBacking, StringBacking
from zarr_json.store import ZarrJsonStore
from zarr_json.validator import (
    Strictness,
    ValidationError,
    ValidationIssue,
    validate,
)

__all__ = [
    "Backing",
    "FileBacking",
    "MemoryBacking",
    "StringBacking",
    "Strictness",
    "ValidationError",
    "ValidationIssue",
    "ZarrJsonStore",
    "validate",
]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd python && uv run pytest tests/test_codec.py::test_public_api_is_importable_from_package_root -q`
Expected: PASS — 1 passed

- [ ] **Step 5: Commit**

```bash
git add python/src/zarr_json/__init__.py python/tests/test_codec.py
git commit -m "Export zarr-json public API from package root"
```

---

## Task 9: Integration test — drive the store through zarr-python

**Files:**
- Create: `python/tests/test_integration.py`

This task proves the store works as a real Zarr v3 store: create a group and array through zarr-python, write and read chunks, list the hierarchy, and confirm the underlying JSON document has the expected shape (metadata keys are objects, chunk keys are base64 strings).

- [ ] **Step 1: Write the failing test**

`python/tests/test_integration.py`:

```python
import json

import numpy as np
import zarr

from zarr_json import MemoryBacking, StringBacking, ZarrJsonStore
from zarr_json.codec import is_metadata_key


async def test_create_group_and_array_write_read_through_zarr_python():
    backing = MemoryBacking({})
    store = ZarrJsonStore(backing)

    root = zarr.open_group(store=store, mode="w")
    arr = root.create_array("data", shape=(8,), chunks=(4,), dtype="uint8")
    arr[:] = np.arange(8, dtype="uint8")

    # Read back through a fresh store over the same document.
    store2 = ZarrJsonStore(MemoryBacking(backing.load()))
    root2 = zarr.open_group(store=store2, mode="r")
    arr2 = root2["data"]
    np.testing.assert_array_equal(arr2[:], np.arange(8, dtype="uint8"))


async def test_document_shape_metadata_objects_and_base64_chunks():
    backing = MemoryBacking({})
    store = ZarrJsonStore(backing)
    root = zarr.open_group(store=store, mode="w")
    arr = root.create_array("data", shape=(4,), chunks=(4,), dtype="uint8")
    arr[:] = np.arange(4, dtype="uint8")

    doc = backing.load()
    for key, value in doc.items():
        if is_metadata_key(key):
            assert isinstance(value, dict), f"{key} should be a JSON object"
        else:
            assert isinstance(value, str), f"{key} should be a base64 string"

    assert "zarr.json" in doc
    assert "data/zarr.json" in doc


async def test_round_trip_through_string_backing():
    backing = MemoryBacking({})
    store = ZarrJsonStore(backing)
    root = zarr.open_group(store=store, mode="w")
    arr = root.create_array("data", shape=(4,), chunks=(2,), dtype="int32")
    arr[:] = np.array([10, 20, 30, 40], dtype="int32")

    # Serialize the whole hierarchy to a JSON string, then reload it.
    text = json.dumps(backing.load())
    store2 = ZarrJsonStore(StringBacking(text))
    root2 = zarr.open_group(store=store2, mode="r")
    np.testing.assert_array_equal(
        root2["data"][:], np.array([10, 20, 30, 40], dtype="int32")
    )
```

- [ ] **Step 2: Add `numpy` to dev dependencies**

`numpy` is needed only by the integration test. Add it to the dev group in `python/pyproject.toml`:

```toml
[dependency-groups]
dev = [
    "pytest>=8.0.0",
    "pytest-asyncio>=0.24.0",
    "numpy>=2.0.0",
]
```

Then run: `cd python && uv sync`
Expected: installs `numpy`; no errors.

- [ ] **Step 3: Run test to verify it fails, then passes**

Run: `cd python && uv run pytest tests/test_integration.py -q`
Expected: PASS — 3 passed. (If `zarr.open_group`'s `mode`/API differs in the installed zarr version, adjust the calls to the installed zarr v3 API — the store interface itself is what is under test.)

- [ ] **Step 4: Run the full test suite**

Run: `cd python && uv run pytest -q`
Expected: PASS — all tests from Tasks 3–9 pass (codec, validator, backing, store, integration).

- [ ] **Step 5: Commit**

```bash
git add python/tests/test_integration.py python/pyproject.toml python/uv.lock
git commit -m "Add integration test driving ZarrJsonStore through zarr-python"
```

---

## Task 10: README for the Python implementation

**Files:**
- Create: `python/README.md`

- [ ] **Step 1: Write `python/README.md`**

```markdown
# zarr-json (Python)

Store a Zarr v3 hierarchy as a single JSON object. `ZarrJsonStore` is a
read-write `zarr.abc.store.Store` whose entire contents live in one JSON
document — keys ending in `zarr.json` hold inline JSON metadata, all other
keys hold base64-encoded bytes.

See the spec: `../docs/superpowers/specs/2026-05-14-zarr-json-design.md`.

## Install

```bash
cd python && uv sync
```

## Usage

```python
import zarr
from zarr_json import ZarrJsonStore, MemoryBacking, StringBacking

# Build a hierarchy into an in-memory JSON object.
backing = MemoryBacking({})
store = ZarrJsonStore(backing)
root = zarr.open_group(store=store, mode="w")
arr = root.create_array("data", shape=(8,), chunks=(4,), dtype="uint8")
arr[:] = range(8)

# `backing.load()` is the JSON document — share it as one file.
document = backing.load()

# Reload from a JSON string.
import json
store2 = ZarrJsonStore(StringBacking(json.dumps(document)))
root2 = zarr.open_group(store=store2, mode="r")
```

## Backings

- `MemoryBacking(document)` — the in-memory object is the source of truth.
- `FileBacking(path)` — reads from / writes to a `.json` file.
- `StringBacking(text)` — parses from a string; `dumps()` returns the current string.

## Validation

```python
from zarr_json import validate, Strictness

issues = validate(document)                       # lenient: returns a list
validate(document, strictness=Strictness.STRICT)   # strict: raises ValidationError
```

`validate` checks the two validity rules: **R1** well-formed keys and **R2**
per-value type (metadata keys map to objects, byte keys map to base64 strings).

## Tests

```bash
cd python && uv run pytest -q
```
```

- [ ] **Step 2: Commit**

```bash
git add python/README.md
git commit -m "Add README for Python zarr-json implementation"
```

---

## Self-Review Notes

**Spec coverage check** — every spec section maps to a task:

- *Document shape / metadata-bytes distinction* → Task 3 (`is_metadata_key`), Task 4 (encode/decode).
- *Validity (R1 well-formed keys, R2 per-value type)* → Task 5 (`validator.py`), exercised against `examples/` fixtures.
- *Backing interface (memory / file / string)* → Task 6.
- *Store core (get/set/delete/exists/list/list_prefix/list_dir)* → Task 7.
- *Lock — concurrent operations serialized* → Task 7 (`asyncio.Lock`, `test_concurrent_sets_are_serialized_by_lock`).
- *get honors byte_range* → Task 7 (`_apply_byte_range`, `test_get_with_range_byte_request`).
- *Persistence timing — persist via backing* → Task 7 (`set`/`delete` call `backing.persist`); memory backing's persist is a no-op (Task 6). Note: this plan persists per-mutation; the spec's optional explicit-`flush()` / autoflush refinement for file/string backings is deliberately deferred — per-mutation persist is correct, just not optimal, and performance is an explicit non-goal.
- *Error handling — malformed values, non-object JSON on metadata set, missing key → None, invalid base64* → Task 4 (`encode_value`/`decode_value` raise `ValueError`), Task 5 (validator), Task 7 (`get` returns `None` for missing key).
- *Round-trip guarantee* → Task 9 (`test_round_trip_through_string_backing`).
- *Shared `examples/` fixtures* → Task 1, consumed in Task 5.
- *Testing: unit per component + integration through host library + conformance fixtures* → Tasks 3–9.

**Placeholder scan** — no TBD/TODO; every code step shows complete code; every command shows expected output. The one conditional note (Task 9 Step 3, "if zarr's API differs") is a real compatibility hedge against an unpinned upstream API, not a placeholder.

**Type consistency** — `is_metadata_key`, `decode_value`, `encode_value` (codec) used consistently in validator, store. `Backing` protocol's `load`/`persist` match all three backing classes and the store's calls. `ValidationIssue.rule`/`.key` consistent between `validator.py` and `MANIFEST.json` (`"R1"`/`"R2"`). `Strictness.STRICT`/`LENIENT` consistent. Store method signatures match the zarr-python v3 Store ABC (`get` with `prototype` + `byte_range`, `get_partial_values`, `supports_writes`/`supports_deletes`/`supports_listing` as properties).
