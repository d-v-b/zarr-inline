# Use cases

The one-line version of zarr-inline is "a Zarr hierarchy in one file". The
more useful version is that it turns a Zarr hierarchy into a **JSON
value** — something you can embed, paste, diff, hash, and compute over,
not merely store. Every use case below follows from that.

## Zarr as a value

A document is a plain JSON object with no magic member, so it can appear
*inside* any JSON-bearing context: another Zarr node's `attributes`, a
configuration file, a notebook cell, an HTTP response body, a JSON
database column, a chat message, a GitHub issue. Two consequences worth
naming:

- **Zarr inside Zarr.** A large hierarchy can carry small auxiliary arrays
  in its attributes as complete zarr-inline stores — coordinate axes,
  lookup tables and colormaps, calibration curves, a thumbnail pyramid,
  an ROI mask — with real dtypes, shapes, and chunk grids. This is the
  principled form of the common anti-pattern of stuffing arrays into
  `attributes` as bare JSON lists.
- **Zarr in APIs and pages.** A web service can return a small array as
  JSON that a client opens directly with zarrita; a static HTML page can
  embed its data in a `<script>` block and read it with no fetch and no
  CORS — the [document browser](browser.md) on this site works that way.

## Reproducers and bug reports

One JSON blob pasted into an issue is a complete, runnable Zarr store.
Because base64 values carry *any* bytes, this works for every codec —
compressed chunks, sharded arrays, custom filters — not only the legible
`json`-codec form. The Python package's `from_zarr(path)` produces the
blob; `open_document(blob)` reproduces the store on the other end.

## Test fixtures for Zarr software

Store-level test cases as text: line-diffable, reviewable in pull
requests, readable without tooling. This repository already uses the
format this way — its conformance and crosscheck suites exchange
documents between three implementations — and the same idea applies to
any Zarr library or downstream tool: ship store fixtures, including
sharding and custom codecs, as one JSON file each.

## Version-controlled small datasets

Calibration tables, reference results, tutorial data, golden outputs:
committed as pretty-printed JSON with one chunk per line, so `git diff`
shows exactly which values changed. The canonical value form makes two
equivalent documents compare equal after a write cycle, and the canonical
*document* form (specification §7.4) gives a stable content hash for
deduplication and reproducibility checks.

## Tutorials, documentation, and papers

A tiny labeled dataset can be pasted directly into prose. With
`dimension_names` set, xarray opens a document as a labeled dataset
(`xr.open_zarr(ZarrInlineStore(...))`) — effectively NetCDF-in-JSON, but
with exact dtypes, big integers, and non-finite floats, which text-based
CF/JSON conventions do not preserve.

## Interchange with language models and agents

The format is text that a model can read, write, and edit correctly:
metadata as JSON objects, chunks as JSON arrays of values, strict numbers.
A model can construct a small dataset in a reply, patch a chunk in an
existing one, or explain a hierarchy from its document alone.

## Hierarchy skeletons

A document holding only `zarr.json` keys — `from_zarr(path, data=False)`
in Python — is a consolidated-metadata snapshot of an arbitrarily large
dataset: its full structure, attributes, dtypes, shapes, and chunk grids
in one file, for discovery, validation, and schema checks without moving
any data. Arrays read back as their fill value.

## Interoperability with kerchunk

A zarr-inline document maps mechanically onto a kerchunk reference set:
inline JSON becomes reference text, base64 values become
`base64:`-prefixed strings. `to_kerchunk(document)` in Python performs the
mapping, so any fsspec-based reader (`ReferenceFileSystem`) can open a
document without the zarr-inline store.

## What it is not for

Large data. Every design choice trades performance for legibility and
cross-language exactness; see [how it works](how-it-works.md#1-purpose-and-scope).
Documents are read fully into memory, numbers are text, and the inlining
check parses on every write. If a dataset does not comfortably fit in a
text editor, a conventional Zarr store is the right tool.
