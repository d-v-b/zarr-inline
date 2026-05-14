# zarr-json Design

**Date:** 2026-05-14
**Status:** Approved design — ready for implementation planning

## Summary

zarr-json is a specification plus three reference implementations for serializing
a Zarr v3 store as a single JSON object. The goal is simple interchange of small
Zarr hierarchies: a whole hierarchy becomes one JSON document that can be shared,
inspected, and edited with ordinary JSON tooling.

This document covers Zarr v3 only. A Zarr v2 variant can be derived later by
extrapolation; it is out of scope here.

## Motivation

Zarr normally stores a hierarchy as a tree of directories and files. That is
awkward to share: it is many files, not one artifact. Representing the same
hierarchy as a single JSON object makes a small hierarchy a single, portable,
human-inspectable document.

## The Specification

### Document shape

A zarr-json document is a single JSON object. Its keys are Zarr v3 store keys
(the same keys a directory-backed store would use, e.g. `zarr.json`,
`myarray/zarr.json`, `myarray/c/0/0`). Its values are one of two kinds:

- **Metadata values** — inline JSON objects.
- **Byte values** — base64-encoded strings.

### The metadata / bytes distinction

The fundamental rule: **metadata is JSON, everything else is base64-encoded
bytes.**

- A key that ends with `zarr.json` is a *metadata key*. Its value MUST be a JSON
  object. The names of metadata documents are defined by this spec; for Zarr v3
  the metadata document name is `zarr.json`, so metadata keys are exactly those
  ending in `zarr.json`.
- Every other key is a *byte key*. Its value MUST be a base64-encoded string,
  decoding to the raw bytes that key would hold in a directory store (e.g.
  chunk data, after the Zarr codec pipeline has been applied).

A document where a key's name and its value type disagree (a `zarr.json` key
with a non-object value, or a non-`zarr.json` key with a non-string value) is
invalid.

base64 is required — not raw JSON number arrays — because chunk data is the
output of the Zarr codec pipeline (compression, filters), which produces opaque
bytes.

### Consistency rules

Validity of the content *inside* each `zarr.json` defers entirely to the Zarr v3
specification. zarr-json does not restate Zarr v3.

Beyond the per-value type rule above, a valid zarr-json document MUST also
satisfy these structural consistency rules — enough to confirm the document is a
coherent hierarchy, without re-deriving Zarr v3:

1. **Root metadata present** — the document contains a root `zarr.json` key.
2. **Well-formed keys** — every key is a well-formed Zarr v3 store path.
3. **No orphan chunks** — every byte key sits under some node; the array prefix
   of every chunk key has a corresponding `zarr.json` metadata key.
4. **Chunk keys belong to arrays** — a chunk key's owning `zarr.json` describes
   an array node, not a group node.

These rules are checked by the validator (see below). They describe a
*complete* document; a store under construction may be transiently inconsistent,
so individual `get`/`set` operations are not blocked by them.

### Round-trip guarantee

Loading a zarr-json document and exporting it without mutation yields an
equivalent object: the key set and the values are preserved. Key ordering within
metadata objects is not considered significant.

## Implementations

Three reference implementations, one per language, each a thin wrapper around an
existing Zarr library. Each exposes a **read-write store** backed by a zarr-json
object and conforms to the host library's store interface, so the host library
performs all array reading/writing and zarr-json only provides the store.

| Language   | Host Zarr library | Store interface conformed to       |
|------------|-------------------|------------------------------------|
| Python     | `zarr-python` v3  | `zarr.abc.store.Store`             |
| TypeScript | `zarrita.js`      | its readable + writable store API  |
| Rust       | `zarrs`           | `ReadableWritableStorageTraits`    |

Performance is an explicit non-goal. Correctness — including correctness under
concurrent mutation — is not.

### Component breakdown

Each implementation has the same internal shape, adapted to language idioms.

#### Backing interface

Abstracts where the JSON object lives ("pluggable backing"). Two operations:
load the object, persist the object. Provided backings:

- **memory** — the object is held in memory and is the source of truth; persist
  is a no-op.
- **file** — the object is read from / written to a `.json` file on disk.
- **string** — the object is parsed from a string; persist returns a string.

The store is constructed from a backing. The store logic is identical regardless
of which backing is used.

#### Store core

Holds the parsed JSON object and implements the host library's store operations:

- `get(key)` — look up the key. If a metadata key, serialize the inline JSON
  object to UTF-8 bytes. If a byte key, base64-decode the string. Missing key →
  the host library's not-found convention.
- `set(key, bytes)` — classify the key by suffix. If a metadata key, parse the
  incoming bytes as JSON and require a JSON object; store it inline. If a byte
  key, base64-encode the bytes and store the string. Then persist via the
  backing (subject to persistence timing, below).
- `delete(key)` — remove the key, then persist.
- `exists(key)` — membership test on the object's key set.
- `list()` / `list_prefix()` / `list_dir()` — scan the object's keys; `list_dir`
  and `list_prefix` derive hierarchy by splitting flat key strings on `/`.

#### Lock

Guards the JSON object so concurrent `get`/`set`/`delete`/`list` are serialized.
Each language uses its native mechanism:

- Python — `threading.Lock` (and/or an async lock as the interface requires).
- Rust — `RwLock`.
- TypeScript — an async mutex (JS is single-threaded, but operations interleave
  at `await` points).

#### Validator

Checks the structural consistency rules. Runs on load with configurable
strictness, and is available as a standalone call.

## Data Flow

**Loading.** Caller constructs a backing → store reads the object via the
backing → validator runs (strict: reject an invalid document; lenient: surface a
diagnostic and continue) → store is ready.

**Read (`get`).** Acquire lock → look up key → metadata key: stringify the inline
object to UTF-8 bytes; byte key: base64-decode → release lock → return bytes (or
not-found). The host Zarr library interprets the bytes.

**Write (`set`).** Acquire lock → classify key by suffix → metadata key: parse
incoming bytes as JSON, reject if not a JSON object; byte key: base64-encode →
store value in object → persist via backing → release lock.

**Delete / list.** Acquire lock → mutate or scan the object's keys → persist if
mutating → release lock.

**Export.** The object *is* the document — the backing's persist step writes it
(to a file) or returns it (as a string). There is no separate serialization
path.

## Persistence Timing

The store persists via the backing; *when* persistence happens is the backing's
concern.

- **memory backing** — persist is a no-op; the in-memory object is the source of
  truth.
- **file / string backing** — an explicit `flush()` makes persistence explicit
  (avoids a full-document rewrite on every chunk write). An optional "autoflush"
  construction flag persists per write for callers who want per-write
  durability. The default is explicit flush.

## Error Handling

- **Malformed document on load** (not a JSON object; a key/value-type mismatch) —
  fail construction in strict mode; in lenient mode, surface a diagnostic and
  skip the offending entry.
- **`set` on a metadata key with bytes that are not a JSON object** — error, no
  mutation.
- **`get` on a missing key** — the host library's not-found convention
  (`None` / `undefined` / `Ok(None)`).
- **Invalid base64 in a byte value on `get`** — error.
- **Consistency-rule violations** (orphan chunk, missing root, etc.) — reported
  by the validator; they do not block individual `get`/`set`, since a store
  under construction is transiently inconsistent.

## Testing

**Per implementation:**

- Unit tests — key classification, encode/decode (metadata ↔ bytes, base64),
  lock behavior, each backing (memory, file, string), and the validator (one
  test per consistency rule, with a valid and an invalid case each).
- Integration test — drive the store through the host Zarr library: create a
  group and an array, write chunks, read them back, list the hierarchy.

**Cross-implementation conformance:**

- A shared set of zarr-json document fixtures (valid and invalid) is committed to
  the repository. Each implementation runs every fixture through its validator
  and must produce the matching verdict, ensuring the three implementations agree
  on what the spec means.

## Out of Scope

- Zarr v2 (derivable later by extrapolation).
- High performance — explicitly a non-goal.
- Restating or re-validating the Zarr v3 spec's rules for the content inside
  `zarr.json` documents.
- Store adapters or features beyond conforming to each host library's store
  interface.
