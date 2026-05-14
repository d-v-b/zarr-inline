"""Pure functions for classifying keys and encoding/decoding values."""

METADATA_SUFFIX = "zarr.json"


def is_metadata_key(key: str) -> bool:
    """Return True if the key names a Zarr v3 metadata document."""
    return key.endswith(METADATA_SUFFIX)
