"""Transform Zarr store entries into JSON object members and back.

Encoding takes a ``(key: str, value: bytes)`` store entry and emits a
``(key: str, value: JSON)`` document member. The input key selects the value
representation: metadata bytes become an inline JSON object, while other
bytes become either a base64 string or an inline canonical JSON array/object.
Decoding applies the inverse transformation to recover the original store
entry.

Inline arrays and objects use a canonical JSON serialization (no whitespace, no NaN /
Infinity tokens) so that parse -> re-serialize is byte-identical. That makes
the inlining rule in encode_value lossless by construction: a byte value is
inlined only if its bytes are exactly the canonical serialization of a JSON
array or object, so decode_value reproduces the original bytes no matter what they
actually were.
"""

import base64
import json
from typing import Never, cast

import rfc8785
from zarr_metadata import JSONValue, ZARR_V3_ARRAY_METADATA_STORE_KEY


def _reject_constant(token: str) -> Never:
    raise ValueError(f"invalid JSON: {token} is not a JSON token")


def _finite_float(text: str) -> float:
    value = float(text)
    if value != value or value in (float("inf"), float("-inf")):
        raise ValueError(f"invalid JSON: number {text} overflows float64")
    return value


def strict_loads(text: str | bytes) -> object:
    """Parse JSON, rejecting what Python's json module is lenient about but
    other implementations are not: bare NaN/Infinity tokens (JavaScript's
    JSON.parse and Rust's serde_json reject them) and number literals that
    overflow float64 to infinity, like 1e999 (serde_json rejects them).
    """
    return json.loads(text, parse_constant=_reject_constant, parse_float=_finite_float)


def is_metadata_key(key: str) -> bool:
    """Return True if the key names a Zarr v3 metadata document."""
    return key == ZARR_V3_ARRAY_METADATA_STORE_KEY or key.endswith(
        "/" + ZARR_V3_ARRAY_METADATA_STORE_KEY
    )


def _canonical_write(value: object, out: list[str]) -> None:
    if value is None:
        out.append("null")
    elif value is True:
        out.append("true")
    elif value is False:
        out.append("false")
    elif isinstance(value, int):
        out.append(str(value))
    elif isinstance(value, float):
        try:
            # Python's json module has no RFC 8785 / ECMAScript number mode:
            # it emits spellings such as 1.0, -0.0, and 1e-07. Delegate the
            # difficult scalar conversion to the RFC implementation. The
            # surrounding writer remains local because zarr-inline preserves
            # object member order and supports integers beyond the JCS safe
            # integer domain.
            out.append(rfc8785.dumps(value).decode("ascii"))
        except rfc8785.CanonicalizationError as exc:
            raise ValueError("canonical JSON cannot represent non-finite numbers") from exc
    elif isinstance(value, str):
        out.append(json.dumps(value, ensure_ascii=False))
    elif isinstance(value, (list, tuple)):
        out.append("[")
        for i, item in enumerate(value):
            if i:
                out.append(",")
            _canonical_write(item, out)
        out.append("]")
    elif isinstance(value, dict):
        out.append("{")
        for i, (key, item) in enumerate(value.items()):
            if i:
                out.append(",")
            if not isinstance(key, str):
                raise ValueError(f"object member name must be a string: {key!r}")
            out.append(json.dumps(key, ensure_ascii=False))
            out.append(":")
            _canonical_write(item, out)
        out.append("}")
    else:
        raise ValueError(f"value is not JSON-serializable: {type(value).__name__}")


def canonical_dumps(value: object) -> str:
    """Serialize a JSON value in the canonical zarr-inline form.

    No whitespace; non-ASCII characters unescaped (UTF-8); object member
    order preserved (member names are NOT sorted — this deliberately departs
    from full RFC 8785); numbers per RFC 8785: floats via ECMAScript
    Number::toString (via ``rfc8785``), integers as digits; non-finite numbers
    rejected (the fill_value convention represents them as strings like
    "NaN"). This form is shared by all zarr-inline implementations so that
    decoded bytes agree byte-for-byte across languages.
    """
    out: list[str] = []
    _canonical_write(value, out)
    return "".join(out)


def decode_value(key: str, value: object) -> bytes:
    """Convert a stored zarr-inline value into the bytes Zarr expects.

    Metadata keys hold a JSON object -> serialize to UTF-8 JSON bytes.
    Byte keys hold a base64 string -> base64-decode to raw bytes, or an
    inline JSON array/object -> canonical-serialize to UTF-8 JSON bytes.
    """
    if is_metadata_key(key):
        if not isinstance(value, dict):
            raise ValueError(f"metadata key {key!r} must map to a JSON object")
        return canonical_dumps(value).encode("utf-8")
    if isinstance(value, (list, dict)):
        return canonical_dumps(value).encode("utf-8")
    if not isinstance(value, str):
        raise ValueError(
            f"byte key {key!r} must map to a base64 string or an inline JSON "
            "array or object"
        )
    return base64.b64decode(value, validate=True)


def encode_value(key: str, data: bytes) -> JSONValue:
    """Convert Zarr's bytes into the value stored in a zarr-inline document.

    Metadata keys: parse bytes as JSON, require a JSON object (value-level
    losslessness: stock Zarr writers do not emit canonical text).
    Byte keys: anything that losslessly round-trips as byte-stable
    (canonical) JSON of a self-describing type — array or object — is
    written inline as JSON; everything else is base64-encoded. A top-level
    JSON *string* can never be inlined: the string type is the base64
    channel, and that reservation is what keeps values decodable.
    """
    if is_metadata_key(key):
        parsed = strict_loads(data)
        if not isinstance(parsed, dict):
            raise ValueError(f"metadata key {key!r} requires a JSON object value")
        return cast(dict[str, JSONValue], parsed)
    inlined = _try_inline_json(data)
    if inlined is not None:
        return inlined
    return base64.b64encode(data).decode("ascii")


def _try_inline_json(
    data: bytes,
) -> list[JSONValue] | dict[str, JSONValue] | None:
    """Return the parsed array/object if inlining `data` is lossless, else None."""
    try:
        parsed = strict_loads(data)
        if isinstance(parsed, (list, dict)) and (
            canonical_dumps(parsed).encode("utf-8") == data
        ):
            return cast(list[JSONValue] | dict[str, JSONValue], parsed)
    except ValueError:
        # Not JSON, not UTF-8, or contains NaN/Infinity tokens (allow_nan=False).
        pass
    return None
