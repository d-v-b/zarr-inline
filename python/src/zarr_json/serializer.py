"""The ``json`` array->bytes codec: chunks as canonical JSON arrays.

Encoding is the Zarr v3 fill_value scalar serialization, applied elementwise
and nested by shape in C order. Every Zarr v3 data type must define a JSON
scalar serialization to be representable in the ``fill_value`` metadata
field, so this codec covers every dtype (including extension dtypes) by
construction: NaN/Infinity become the strings "NaN"/"Infinity", complex
values become [re, im] pairs, fixed-length bytes become base64 strings, and
so on. zarr-python exposes the serialization as ZDType.to_json_scalar /
from_json_scalar.

Output is canonical JSON (see codec.canonical_dumps), which is what lets
ZarrJsonStore inline these chunks as real JSON arrays in the document.

A rank-0 chunk serializes to a bare JSON scalar; the store only inlines
arrays, so rank-0 chunks are stored base64-encoded.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Self

import numpy as np
from zarr.abc.codec import ArrayBytesCodec
from zarr.core.common import JSON
from zarr.registry import register_codec

from zarr_json.codec import canonical_dumps, strict_loads

if TYPE_CHECKING:
    from zarr.core.array_spec import ArraySpec
    from zarr.core.buffer import Buffer, NDBuffer


def _nest(flat: list[Any], shape: tuple[int, ...]) -> Any:
    if len(shape) == 0:
        return flat[0]
    if len(shape) == 1:
        return flat
    step = len(flat) // shape[0]
    return [_nest(flat[i * step : (i + 1) * step], shape[1:]) for i in range(shape[0])]


def _flatten(nested: Any, shape: tuple[int, ...]) -> list[Any]:
    # Shape-driven: a scalar's JSON form may itself be a list (complex ->
    # [re, im]), so recursion must stop at the last dimension, not at
    # non-list values.
    if len(shape) == 0:
        return [nested]
    if not isinstance(nested, list) or len(nested) != shape[0]:
        raise ValueError(f"json codec: chunk JSON does not match chunk shape {shape}")
    if len(shape) == 1:
        return list(nested)
    out: list[Any] = []
    for sub in nested:
        out.extend(_flatten(sub, shape[1:]))
    return out


_NON_FINITE = ("NaN", "Infinity", "-Infinity")


def _is_float_sort(v: Any) -> bool:
    return (isinstance(v, (int, float)) and not isinstance(v, bool)) or v in _NON_FINITE


def _check_scalar_sort(value: Any, native: np.dtype[Any]) -> None:
    """Enforce SPEC 9.2 element sorts before delegating to zarr-python's
    lenient from_json_scalar (which accepts 1.0, true, and "1" for int32,
    and 1 for bool). Integer dtypes take integer tokens only; bool takes
    booleans only; floats take integers, floats, or the non-finite strings;
    complex takes a [re, im] pair of float-sort values.
    """
    kind = native.kind
    ok = True
    if kind in "iu":
        ok = isinstance(value, int) and not isinstance(value, bool)
    elif kind == "b":
        ok = isinstance(value, bool)
    elif kind == "f":
        ok = _is_float_sort(value)
    elif kind == "c":
        ok = (
            isinstance(value, (list, tuple))
            and len(value) == 2
            and all(_is_float_sort(part) for part in value)
        )
    if not ok:
        raise ValueError(
            f"json codec: invalid {native} scalar {value!r}: wrong JSON number sort"
        )


def _check_finite(value: Any, scalar: Any, native: np.dtype[Any]) -> None:
    """SPEC 9.2: a finite JSON number that overflows the target float type's
    finite range is out of range (a codec error), never Infinity; non-finite
    values are representable only through the explicit strings.
    """
    if native.kind not in "fc":
        return
    numeric = (
        isinstance(value, (int, float)) and not isinstance(value, bool)
        if native.kind == "f"
        else all(isinstance(p, (int, float)) and not isinstance(p, bool) for p in value)
    )
    if numeric and not np.isfinite(scalar):
        raise ValueError(
            f"json codec: {native} value {value!r} is out of range (not finite after "
            'conversion); use "NaN"/"Infinity"/"-Infinity" for non-finite values'
        )


@dataclass(frozen=True)
class JsonSerializer(ArrayBytesCodec):
    """Array->bytes codec encoding chunks as canonical UTF-8 JSON arrays."""

    is_fixed_size = False

    @classmethod
    def from_dict(cls, data: dict[str, JSON]) -> Self:
        if data.get("name") != "json":
            raise ValueError(f"expected codec name 'json', got {data.get('name')!r}")
        if data.get("configuration") not in (None, {}):
            raise ValueError(
                "json codec takes no configuration; got "
                f"{data.get('configuration')!r}"
            )
        return cls()

    def to_dict(self) -> dict[str, JSON]:
        return {"name": "json"}

    async def _encode_single(
        self, chunk_array: NDBuffer, chunk_spec: ArraySpec
    ) -> Buffer:
        zdtype = chunk_spec.dtype
        nd = chunk_array.as_ndarray_like()
        flat = [zdtype.to_json_scalar(v, zarr_format=3) for v in nd.ravel()]
        text = canonical_dumps(_nest(flat, tuple(nd.shape)))
        return chunk_spec.prototype.buffer.from_bytes(text.encode("utf-8"))

    async def _decode_single(
        self, chunk_bytes: Buffer, chunk_spec: ArraySpec
    ) -> NDBuffer:
        zdtype = chunk_spec.dtype
        # SPEC 9.2: chunk bytes are strict-parsed (no NaN/Infinity tokens,
        # no float64 overflow literals).
        nested = strict_loads(chunk_bytes.to_bytes())
        flat = _flatten(nested, tuple(chunk_spec.shape))
        native = zdtype.to_native_dtype()
        for v in flat:
            _check_scalar_sort(v, native)
        scalars = []
        for v in flat:
            try:
                scalar = zdtype.from_json_scalar(v, zarr_format=3)
            except OverflowError as exc:  # e.g. a 400-digit integer token -> float
                raise ValueError(
                    f"json codec: {native} value {v!r} is out of range: {exc}"
                ) from exc
            _check_finite(v, scalar, native)
            scalars.append(scalar)
        arr = np.asarray(scalars, dtype=zdtype.to_native_dtype()).reshape(
            chunk_spec.shape
        )
        return chunk_spec.prototype.nd_buffer.from_ndarray_like(arr)

    def compute_encoded_size(self, input_byte_length: int, chunk_spec: ArraySpec) -> int:
        raise NotImplementedError("json codec output size is not fixed")


register_codec("json", JsonSerializer)
