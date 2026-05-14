"""Pure functions for classifying keys and encoding/decoding values."""

import base64
import json
from typing import Any

METADATA_SUFFIX = "zarr.json"


def is_metadata_key(key: str) -> bool:
    """Return True if the key names a Zarr v3 metadata document."""
    return key.endswith(METADATA_SUFFIX)


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
