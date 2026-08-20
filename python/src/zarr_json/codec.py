"""Pure functions for classifying keys and encoding/decoding values.

A zarr-json value is one of:

- metadata key (``zarr.json`` or ``*/zarr.json``) -> inline JSON object
- byte key -> base64 string (opaque bytes), or a JSON array (inline data
  values, produced by the ``json`` array->bytes codec)

Inline arrays use a canonical JSON serialization (no whitespace, no NaN /
Infinity tokens) so that parse -> re-serialize is byte-identical. That makes
the inlining rule in encode_value lossless by construction: a byte value is
inlined only if its bytes are exactly the canonical serialization of a JSON
array, so decode_value reproduces the original bytes no matter what they
actually were.
"""

import base64
import json
from typing import Any

METADATA_SUFFIX = "zarr.json"


def _reject_constant(token: str) -> Any:
    raise ValueError(f"invalid JSON: {token} is not a JSON token")


def _finite_float(text: str) -> float:
    value = float(text)
    if value != value or value in (float("inf"), float("-inf")):
        raise ValueError(f"invalid JSON: number {text} overflows float64")
    return value


def strict_loads(text: str | bytes) -> Any:
    """Parse JSON, rejecting what Python's json module is lenient about but
    other implementations are not: bare NaN/Infinity tokens (JavaScript's
    JSON.parse and Rust's serde_json reject them) and number literals that
    overflow float64 to infinity, like 1e999 (serde_json rejects them).
    """
    return json.loads(text, parse_constant=_reject_constant, parse_float=_finite_float)


def is_metadata_key(key: str) -> bool:
    """Return True if the key names a Zarr v3 metadata document."""
    return key == METADATA_SUFFIX or key.endswith("/" + METADATA_SUFFIX)


def canonical_dumps(value: Any) -> str:
    """Serialize a JSON value in the canonical zarr-json form.

    No whitespace; non-ASCII characters unescaped (UTF-8); object member
    order preserved; NaN/Infinity tokens rejected (they are not JSON; the
    fill_value convention represents them as strings like "NaN"). This form
    is shared by all zarr-json implementations so that decoded bytes agree
    across languages.
    """
    return json.dumps(value, separators=(",", ":"), allow_nan=False, ensure_ascii=False)


def decode_value(key: str, value: Any) -> bytes:
    """Convert a stored zarr-json value into the bytes Zarr expects.

    Metadata keys hold a JSON object -> serialize to UTF-8 JSON bytes.
    Byte keys hold a base64 string -> base64-decode to raw bytes, or a JSON
    array -> canonical-serialize to UTF-8 JSON bytes.
    """
    if is_metadata_key(key):
        if not isinstance(value, dict):
            raise ValueError(f"metadata key {key!r} must map to a JSON object")
        return canonical_dumps(value).encode("utf-8")
    if isinstance(value, list):
        return canonical_dumps(value).encode("utf-8")
    if not isinstance(value, str):
        raise ValueError(f"byte key {key!r} must map to a base64 string or JSON array")
    return base64.b64decode(value, validate=True)


def encode_value(key: str, data: bytes) -> Any:
    """Convert Zarr's bytes into the value stored in a zarr-json document.

    Metadata keys: parse bytes as JSON, require a JSON object.
    Byte keys: inline as a JSON array if the bytes are exactly the canonical
    serialization of one (lossless by construction); otherwise base64-encode.
    """
    if is_metadata_key(key):
        parsed = strict_loads(data)
        if not isinstance(parsed, dict):
            raise ValueError(f"metadata key {key!r} requires a JSON object value")
        return parsed
    inlined = _try_inline_array(data)
    if inlined is not None:
        return inlined
    return base64.b64encode(data).decode("ascii")


def _try_inline_array(data: bytes) -> list[Any] | None:
    """Return the parsed JSON array if inlining `data` is lossless, else None."""
    try:
        parsed = strict_loads(data)
        if isinstance(parsed, list) and canonical_dumps(parsed).encode("utf-8") == data:
            return parsed
    except ValueError:
        # Not JSON, not UTF-8, or contains NaN/Infinity tokens (allow_nan=False).
        pass
    return None
