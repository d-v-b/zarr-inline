"""Conformance harness: shared cross-implementation behavior as a CLI.

Reads a zarr-inline document (a JSON object) on stdin and writes a JSON
report on stdout:

- "issues": validator issues, sorted by (key, rule).
- "decoded": for every issue-free key that decodes, base64 of the bytes
  decode_value returns (the bytes a Zarr library would see).
- "reencoded": encode_value(key, decoded_bytes) for every decoded key.
- "errors": sorted keys that passed validation but failed to decode (e.g.
  a byte key whose string value is not valid base64).

The TypeScript and Rust implementations ship the same harness; the Python
property test in tests/test_conformance_property.py generates documents and
requires the three reports to agree. See
DESIGN.md section 6.1.
"""

from __future__ import annotations

import base64
import json
import sys
from typing import Any

from zarr_inline.document import decode_value, encode_value
from zarr_inline.validator import validate


def run(document: dict[str, Any]) -> dict[str, Any]:
    issues = validate(document)
    issue_keys = {i.key for i in issues}
    decoded: dict[str, str] = {}
    reencoded: dict[str, Any] = {}
    errors: list[str] = []
    for key, value in document.items():
        if key in issue_keys:
            continue
        try:
            data = decode_value(key, value)
        except ValueError:
            errors.append(key)
            continue
        decoded[key] = base64.b64encode(data).decode("ascii")
        reencoded[key] = encode_value(key, data)
    return {
        "issues": [
            {"rule": i.rule, "key": i.key}
            for i in sorted(issues, key=lambda i: (i.key, i.rule))
        ],
        "decoded": decoded,
        "reencoded": reencoded,
        "errors": sorted(errors),
    }


def main() -> int:
    from zarr_inline.document import strict_loads

    try:
        document = strict_loads(sys.stdin.buffer.read())
    except ValueError as exc:
        print(f"invalid JSON input: {exc}", file=sys.stderr)
        return 1
    if not isinstance(document, dict):
        print("input must be a JSON object", file=sys.stderr)
        return 1
    try:
        text = json.dumps(run(document), ensure_ascii=False)
        sys.stdout.buffer.write(text.encode("utf-8"))
    except (ValueError, UnicodeEncodeError) as exc:
        # e.g. lone surrogates in keys: the report would not be valid UTF-8.
        print(f"cannot encode report: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
