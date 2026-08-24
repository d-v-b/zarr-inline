"""Validate a zarr-inline document against the two validity rules.

R1 — well-formed keys: the empty root key or a string with no leading or
     trailing "/", no empty segments, and no "." or ".." segments.
R2 — per-value type: metadata keys map to a JSON object (dict); byte keys
     map to a base64 string (str) or an inline JSON array (list) or object
     (dict).
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any

from zarr_inline.document import is_metadata_key


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
        super().__init__(f"invalid zarr-inline document: {joined}")


def _check_key_well_formed(key: str) -> ValidationIssue | None:
    if not isinstance(key, str):
        return ValidationIssue("R1", str(key), "key must be a string")
    if key == "":
        return None
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
        if not isinstance(value, (str, list, dict)):
            return ValidationIssue(
                "R2",
                key,
                "byte key must map to a base64 string or a JSON array or object",
            )
    return None


def check_key(key: str) -> ValidationIssue | None:
    """Public form of the R1 well-formed-key check (Zarr v3 store keys)."""
    return _check_key_well_formed(key)


def validate(
    document: dict[str, Any],
    strictness: Strictness = Strictness.LENIENT,
) -> list[ValidationIssue]:
    """Check a zarr-inline document. Returns the list of issues (empty if valid).

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
