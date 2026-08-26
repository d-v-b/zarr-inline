"""Convert an on-disk Zarr v3 hierarchy into a single zarr-inline document.

Run from the repository root:

    uv run --project python python examples/convert_hierarchy.py

The script builds a small demo hierarchy in a temporary directory, converts
it both ways — legible (chunks as human-readable JSON arrays) and
byte-faithful (original codecs kept, chunks as base64) — prints the legible
document, and reads it back through zarr to show the round trip.
"""

import json
import tempfile
from pathlib import Path

import numpy as np
import zarr

from zarr_inline import from_zarr, open_document, to_zarr, verify_document, write_document

with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)

    # An ordinary Zarr hierarchy on disk: a group with attributes and two
    # arrays, one of them compressed with zarr's defaults.
    source = tmp / "survey.zarr"
    root = zarr.open_group(str(source), mode="w")
    root.attrs["title"] = "temperature survey"
    temp = root.create_array("temp", shape=(4, 4), chunks=(2, 2), dtype="float64")
    temp[:] = np.arange(16, dtype="float64").reshape(4, 4) / 3
    temp[0, 0] = float("nan")
    root.create_array("qc/flags", shape=(6,), chunks=(4,), dtype="uint8")[:] = [0, 1, 0, 2, 0, 1]

    # One call: the whole hierarchy as a single pretty-printed JSON file.
    # inline_data=True (the default) re-encodes every array with the `json`
    # codec, so the chunk values are right there in the document.
    document = write_document(source, tmp / "survey.json")
    print(json.dumps(document, indent=2)[:1000], "...\n")

    # The byte-faithful variant keeps the original codecs (chunks are
    # base64-encoded compressed bytes) — exact, but not human-readable.
    # (inline_data="auto" splits the difference: arrays the json codec
    # cannot serve, e.g. variable-length strings, stay byte-faithful while
    # everything else is inlined.)
    faithful = from_zarr(source, inline_data=False)
    print("byte-faithful chunk:", faithful["temp/c/0/0"][:40], "...\n")

    # The document is a normal Zarr store: open it as a group in one call,
    # and assert the round trip.
    reloaded = open_document(tmp / "survey.json")
    verify_document(document, source)
    print("round trip:", reloaded["temp"][0].tolist(), "| attrs:", dict(reloaded.attrs))

    # And a document can be exploded back into an ordinary directory store.
    to_zarr(faithful, tmp / "restored.zarr")
    print("restored:", zarr.open_group(str(tmp / "restored.zarr"), mode="r")["qc/flags"][:].tolist())
