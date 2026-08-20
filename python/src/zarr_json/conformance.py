"""Conformance harness: shared cross-implementation behavior as a CLI.

Reads a zarr-json document (a JSON object) on stdin and writes a JSON
report on stdout:

- "issues": validator issues, sorted by (key, rule).
- "decoded": for every issue-free key, base64 of the bytes decode_value
  returns (the bytes a Zarr library would see).
- "reencoded": encode_value(key, decoded_bytes) for every decoded key.

The TypeScript and Rust implementations ship the same harness; the Python
property test in tests/test_conformance_property.py generates documents and
requires the three reports to agree. See
docs/superpowers/specs/2026-08-20-conformance-protocol.md.
"""

from __future__ import annotations

import base64
import json
import sys
from typing import Any

from zarr_json.codec import decode_value, encode_value
from zarr_json.validator import validate


def run(document: dict[str, Any]) -> dict[str, Any]:
    issues = validate(document)
    issue_keys = {i.key for i in issues}
    decoded: dict[str, str] = {}
    reencoded: dict[str, Any] = {}
    for key, value in document.items():
        if key in issue_keys:
            continue
        data = decode_value(key, value)
        decoded[key] = base64.b64encode(data).decode("ascii")
        reencoded[key] = encode_value(key, data)
    return {
        "issues": [
            {"rule": i.rule, "key": i.key}
            for i in sorted(issues, key=lambda i: (i.key, i.rule))
        ],
        "decoded": decoded,
        "reencoded": reencoded,
    }


def main() -> int:
    document = json.load(sys.stdin)
    if not isinstance(document, dict):
        print("input must be a JSON object", file=sys.stderr)
        return 1
    json.dump(run(document), sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
