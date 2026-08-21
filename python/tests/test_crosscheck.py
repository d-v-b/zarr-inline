"""Cross-language writer x reader matrix over json-codec arrays.

Each implementation's crosscheck harness turns a payload into a zarr-json
document (write) and a document back into a payload (read); every
(writer, reader) pair must reproduce the input payload exactly. See
DESIGN.md section 6.2.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]

# The portable payload: every dtype all three host libraries support, edge
# chunks (shape not divisible by chunks), a nested group path, non-finite
# floats, and int64 across its full range including values JavaScript can
# only carry as BigInt (see the crosscheck protocol).
PAYLOAD = {
    "arrays": [
        {"path": "b", "dtype": "bool", "shape": [3], "chunks": [2],
         "data": [True, False, True]},
        {"path": "f32", "dtype": "float32", "shape": [4], "chunks": [3],
         "data": [0.5, -2.75, "NaN", 1.5]},
        {"path": "f64", "dtype": "float64", "shape": [5], "chunks": [2],
         "data": [0.5, "NaN", "Infinity", "-Infinity", -2.75]},
        {"path": "grp/i64", "dtype": "int64", "shape": [2, 2], "chunks": [1, 2],
         "data": [[-9223372036854775808, 9223372036854775807],
                  [9007199254740993, -5]]},
        {"path": "i32", "dtype": "int32", "shape": [3], "chunks": [2],
         "data": [-2147483648, 0, 2147483647]},
        {"path": "u8", "dtype": "uint8", "shape": [2, 4], "chunks": [2, 4],
         "data": [[0, 1, 2, 3], [4, 5, 6, 7]]},
    ]
}


def _available(name: str, probe: Path, build: list[list[str]], cwd: Path) -> bool:
    if probe.exists():
        return True
    if not cwd.exists():
        return False
    for cmd in build:
        if subprocess.run(cmd, cwd=cwd, capture_output=True).returncode != 0:
            return False
    return probe.exists()


def _harnesses() -> dict[str, list[str]]:
    out = {"python": [sys.executable, "-m", "zarr_json.crosscheck"]}
    ts = REPO / "typescript" / "dist" / "crosscheck.js"
    if _available(
        "ts", ts,
        [["npm", "install", "--no-audit", "--no-fund"], ["npm", "run", "build"]],
        REPO / "typescript",
    ):
        out["typescript"] = ["node", str(ts)]
    rs = REPO / "rust" / "target" / "debug" / "crosscheck"
    if _available("rust", rs, [["cargo", "build"]], REPO / "rust"):
        out["rust"] = [str(rs)]
    return out


HARNESSES = _harnesses()


def _run(cmd: list[str], mode: str, payload: dict) -> dict:
    proc = subprocess.run(
        [*cmd, mode],
        input=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        capture_output=True,
        timeout=120,
    )
    assert proc.returncode == 0, (
        f"{cmd} {mode} failed: {proc.stderr.decode(errors='replace')}"
    )
    return json.loads(proc.stdout)


@pytest.mark.parametrize("writer", sorted(HARNESSES))
@pytest.mark.parametrize("reader", sorted(HARNESSES))
def test_writer_reader_matrix(writer, reader):
    if len(HARNESSES) < 3:
        missing = {"python", "typescript", "rust"} - set(HARNESSES)
        pytest.skip(f"crosscheck harnesses unavailable: {sorted(missing)}")
    document = _run(HARNESSES[writer], "write", PAYLOAD)
    result = _run(HARNESSES[reader], "read", document)
    assert result == PAYLOAD, f"{writer}->{reader} mismatch"


def test_all_implementations_read_the_ome_zarr_example():
    """zarr-python, zarrita, and zarrs all open the shipped OME-Zarr 0.5
    example and read identical values from it."""
    if len(HARNESSES) < 3:
        missing = {"python", "typescript", "rust"} - set(HARNESSES)
        pytest.skip(f"crosscheck harnesses unavailable: {sorted(missing)}")
    example = REPO / "examples" / "valid" / "ome_zarr_0.5_image.json"
    document = json.loads(example.read_text())
    results = {
        name: _run(cmd, "read", document) for name, cmd in HARNESSES.items()
    }
    expected = results["python"]
    assert [a["path"] for a in expected["arrays"]] == ["0", "1"]
    assert results["typescript"] == expected
    assert results["rust"] == expected
