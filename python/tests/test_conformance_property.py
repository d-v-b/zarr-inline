"""Property-based cross-implementation conformance tests.

Hypothesis generates zarr-json documents; each document is run through the
Python conformance harness in-process and through the TypeScript and Rust
harness CLIs (built on demand; skipped if their toolchains or sources are
absent). All reports must agree structurally.

Canonical numbers follow RFC 8785 (ECMAScript Number::toString), so
floats — including integral values, negative zero, exponent forms, and
subnormals — are portable and generated freely within the float64-safe
magnitude range. The generated value space still avoids the residual
divergences documented in
docs/superpowers/specs/2026-08-20-conformance-protocol.md:

- (none for numbers: integers of any size and the full float64 range are
  portable across all three implementations);
- integer-like JSON object member names (JS objects reorder them).
"""

from __future__ import annotations

import base64
import json
import subprocess
from pathlib import Path

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from zarr_json.conformance import run as run_python

REPO = Path(__file__).resolve().parents[2]

# --- external harnesses -----------------------------------------------------


def _build_or_skip(name: str, marker: Path, build: list[list[str]], cwd: Path) -> None:
    if marker.exists():
        return
    if not cwd.exists():
        pytest.skip(f"{name} implementation not present at {cwd}")
    for cmd in build:
        proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
        if proc.returncode != 0:
            pytest.skip(f"{name} harness build failed: {cmd}: {proc.stderr[-500:]}")
    if not marker.exists():
        pytest.skip(f"{name} harness missing after build: {marker}")


@pytest.fixture(scope="session")
def ts_harness() -> list[str]:
    marker = REPO / "typescript" / "dist" / "conformance.js"
    _build_or_skip(
        "TypeScript",
        marker,
        [["npm", "install", "--no-audit", "--no-fund"], ["npm", "run", "build"]],
        REPO / "typescript",
    )
    return ["node", str(marker)]


@pytest.fixture(scope="session")
def rust_harness() -> list[str]:
    marker = REPO / "rust" / "target" / "debug" / "conformance"
    _build_or_skip(
        "Rust",
        marker,
        [["cargo", "build", "--bin", "conformance"]],
        REPO / "rust",
    )
    return [str(marker)]


def run_external(cmd: list[str], document: dict) -> dict:
    proc = subprocess.run(
        cmd,
        input=json.dumps(document, ensure_ascii=False).encode("utf-8"),
        capture_output=True,
        timeout=60,
    )
    assert proc.returncode == 0, (
        f"{cmd} failed on {document!r}: {proc.stderr.decode(errors='replace')}"
    )
    return json.loads(proc.stdout)


# --- document strategies ----------------------------------------------------

SEGMENT = st.from_regex(r"[a-z0-9][a-z0-9._-]{0,5}", fullmatch=True).filter(
    lambda s: s not in (".", "..")
)
OBJ_KEY = st.from_regex(r"[a-z_][a-z0-9_]{0,6}", fullmatch=True)

SAFE_INT = st.integers(min_value=-(10**30), max_value=10**30)
SAFE_FLOAT = st.floats(
    min_value=-(2.0**53 - 1), max_value=2.0**53 - 1, allow_nan=False
)
SAFE_TEXT = st.text(
    alphabet=st.sampled_from(list('abz09 _-"\\\n\té∆中\U0001f388')),
    max_size=8,
)
SAFE_SCALAR = st.one_of(st.none(), st.booleans(), SAFE_INT, SAFE_FLOAT, SAFE_TEXT)
JSON_VALUE = st.recursive(
    SAFE_SCALAR,
    lambda children: st.one_of(
        st.lists(children, max_size=3),
        st.dictionaries(OBJ_KEY, children, max_size=3),
    ),
    max_leaves=8,
)

METADATA_KEY = st.lists(SEGMENT, min_size=0, max_size=2).map(
    lambda segs: "/".join([*segs, "zarr.json"])
)
DATA_KEY = st.lists(SEGMENT, min_size=1, max_size=3).map("/".join)

METADATA_VALUE = st.dictionaries(OBJ_KEY, JSON_VALUE, max_size=4)
BYTE_VALUE = st.one_of(
    st.binary(max_size=24).map(lambda b: base64.b64encode(b).decode("ascii")),
    st.lists(JSON_VALUE, max_size=4),
)

VALID_ENTRY = st.one_of(
    st.tuples(METADATA_KEY, METADATA_VALUE),
    st.tuples(DATA_KEY, BYTE_VALUE),
)

# Strings that may or may not be valid base64 — every implementation must
# agree on which ones decode and which land in the report's "errors" list.
DUBIOUS_TEXT = st.text(
    alphabet=st.sampled_from(list("AbZ09+/=!. \n_-")), max_size=12
)

BAD_KEY = st.sampled_from(["/x", "x/", "a//b", "a/./b", "..", "a/../b", ""])
BAD_ENTRY = st.one_of(
    st.tuples(BAD_KEY, st.one_of(METADATA_VALUE, BYTE_VALUE)),
    st.tuples(METADATA_KEY, st.one_of(st.lists(JSON_VALUE, max_size=2), SAFE_SCALAR)),
    st.tuples(DATA_KEY, st.one_of(SAFE_INT, st.booleans(), st.none(), METADATA_VALUE)),
    st.tuples(DATA_KEY, DUBIOUS_TEXT),
)

VALID_DOCUMENT = st.lists(VALID_ENTRY, max_size=5).map(dict)
MIXED_DOCUMENT = st.lists(st.one_of(VALID_ENTRY, BAD_ENTRY), max_size=6).map(dict)


# --- properties -------------------------------------------------------------


def assert_all_agree(document: dict, ts_cmd: list[str], rust_cmd: list[str]) -> None:
    expected = json.loads(json.dumps(run_python(document), ensure_ascii=False))
    ts_report = run_external(ts_cmd, document)
    rust_report = run_external(rust_cmd, document)
    assert ts_report == expected, f"TypeScript disagrees on {document!r}"
    assert rust_report == expected, f"Rust disagrees on {document!r}"


@settings(
    max_examples=50, deadline=None, suppress_health_check=[HealthCheck.too_slow]
)
@given(document=VALID_DOCUMENT)
def test_implementations_agree_on_valid_documents(document, ts_harness, rust_harness):
    assert run_python(document)["issues"] == [], "generated document must be valid"
    assert_all_agree(document, ts_harness, rust_harness)


@settings(
    max_examples=50, deadline=None, suppress_health_check=[HealthCheck.too_slow]
)
@given(document=MIXED_DOCUMENT)
def test_implementations_agree_on_documents_with_issues(
    document, ts_harness, rust_harness
):
    assert_all_agree(document, ts_harness, rust_harness)
