# zarr-json Value Typing — Design Space

**Date:** 2026-08-20
**Status:** Exploration; on 2026-08-20 the JSON-array value type (a subset of option B2) was adopted — see the amendment in 2026-05-14-zarr-json-design.md

## The problem

A zarr-json document holds two semantically different kinds of values:

- **JSON values** — metadata documents, and potentially (future) decoded array
  data.
- **Byte values** — opaque post-codec bytes, base64-encoded.

JSON itself cannot distinguish them. A JSON string could be a base64 encoding
of bytes or a genuine string datum. Chunk bytes can even *be* valid JSON
(`b"123"` parses; `"AAECAw=="` is both a base64 payload and a JSON string), so
content sniffing is unsound in both directions.

The current spec resolves the ambiguity **extrinsically, via the key name**:
keys ending in `zarr.json` hold JSON objects, everything else holds base64
strings. This works for well-behaved Zarr v3 stores but has three structural
weaknesses:

1. **The rule is Zarr-v3-specific and lexically fragile.** The container
   format must know Zarr's metadata-document naming. The current
   `endswith("zarr.json")` check misclassifies `xyzarr.json` and
   `a/notzarr.json` as metadata (confirmed against the implementation). A
   Zarr v2 variant would need a new list of magic names (`.zarray`,
   `.zgroup`, `.zattrs`).
2. **The encoding is partial.** A Zarr store is a total map Key → Bytes, but
   zarr-json cannot hold arbitrary bytes at a metadata-named key (`set`
   errors unless the bytes parse as a JSON object). The container therefore
   encodes only a *subset* of stores.
3. **There is no room in the value space.** If we ever want value-represented
   data (chunks as JSON arrays — the companion question in this project), the
   key name no longer determines the type, and a string value at a chunk key
   becomes ambiguous: base64 bytes or a string datum?

There is also a quieter fidelity wrinkle: inlining metadata as JSON gives up
byte-exact round-trips (key order, whitespace, number formatting). The spec
currently accepts this ("key ordering is not significant"), but any use case
involving checksums or signatures would not.

## The clean reframe

Formally, the document wants to encode a **sum type**:

```
Document = Map<Key, Json | Bytes>
```

This splits the problem into three independent dimensions:

- **A. What is the store's value type?** (what does the document model?)
- **B. How is the sum discriminated in the JSON encoding?** (the tagged-union
  question)
- **C. Where is the JSON-vs-bytes decision made at write time?** (a
  bytes-only `Store` interface can't be told the type)

Encoding a sum type in JSON is a well-studied problem — serde's
externally/internally/adjacently-tagged and untagged unions are exactly this
menu — so dimension B has known options with known failure modes.

## Dimension A — the value model

- **A1. Key → Bytes, encoded opaquely.** Everything base64. Maximum fidelity,
  total encoding, zero legibility. The degenerate anchor point; defeats the
  format's purpose but clarifies what we're paying legibility for.
- **A2. Key → Bytes, with a legible projection.** The *model* is still a byte
  store; values whose bytes are UTF-8 JSON are *displayed* inline. This is
  the status quo's self-description ("intuition: a store transformation").
- **A3. Key → (Json | Bytes) as a first-class model.** The document formally
  holds two types; a Zarr store maps into it (metadata → Json, chunks →
  Bytes). The container becomes Zarr-agnostic: any keyed mix of JSON and
  bytes is representable, and Zarr-ness (v2 or v3) is a layer above.
- **A4. Key → Json (values-first).** All data as native JSON values (chunks
  as number arrays); bytes are the exceptional case or forbidden along with
  compression codecs. This is the "human-facing representation of a
  hierarchy" pole of the companion representation question. It largely
  dissolves dimension B for data (arrays are unambiguous) but re-encounters
  it for string dtypes and raw-bytes dtypes.

## Dimension B — discriminating the sum in JSON

- **B1. Key-name convention (status quo).** Tag lives outside the value.
  Untagged in serde terms, with an out-of-band discriminator.
  - - Zarr-version-specific; lexical bugs; partial encoding; no room for
    value-typed data.
  - - Values are pristine — metadata is inline with zero ceremony.

- **B2. Structural discrimination (untagged by JSON type).** The value's own
  JSON type is the tag: **object → JSON, string → base64 bytes** (arrays,
  numbers, booleans, null reserved or later assigned).
  - - For every real Zarr v3 store this produces a document *byte-identical*
    to today's — metadata documents are objects, chunk values are strings.
    The design doc's "intuition" section, promoted to the normative rule.
  - - Fixes weakness 1 (no key knowledge in the container; Zarr v2 works for
    free) and weakness 2 (any Key → Bytes map is encodable — bytes at any
    key are just a string).
  - - Leaves room: if value-typed data is added later, **array** is free —
    `"c/0": [1,2,3]` (values) vs `"c/0": "AAEC"` (bytes) coexist
    unambiguously at the same key namespace.
  - - Cannot represent a *top-level* JSON string/number/bool as a JSON value
    (they'd read as bytes / be invalid). Irrelevant for Zarr v3 metadata
    (always objects); becomes a real gap only if string-valued data ever
    needs inlining.
  - - The reader is unambiguous, but the *writer* still needs a policy for
    when incoming bytes should be inlined as JSON (see dimension C) — the
    key convention survives there as a heuristic, no longer load-bearing for
    validity.

- **B3. Marked bytes (bytes are the tagged case).** Bytes get a reserved
  wrapper — `{"b64": "AAEC"}` (or a `"base64:"`-style equivalent) — and
  everything else is inline JSON of any type.
  - - Fully general Json | Bytes: any JSON value, any bytes, any key.
  - - Ceremony lands only on the illegible values, where nobody's reading
    anyway; metadata stays pristine.
  - - Needs an escape rule for the collision case (a genuine JSON value that
    is itself `{"b64": ...}`-shaped), e.g. a `{"json": ...}` wrapper.
    Zarr metadata never collides in practice, but totality demands the rule.
  - - Chunk values stop being bare strings — a (small) spec and document
    change from today.

- **B4. Fully tagged (every value wrapped).** Externally tagged
  `{"json": {...}}` / `{"b64": "..."}`, or adjacently tagged
  `{"kind": "bytes", "data": "..."}`.
  - - Bulletproof, self-describing, maximally extensible: new kinds slot in
    (`{"array": ...}` decoded data, `{"utf8": "..."}` text bytes,
    `{"ref": {"url":..., "offset":..., "length":...}}` external chunks à la
    kerchunk).
  - - Every metadata document gains a wrapper layer; the document stops
    looking like "the store, inlined." The heaviest tax on legibility per
    unit of safety.

- **B5. String prefix sentinel.** All byte values are strings prefixed
  `"base64:..."`; unprefixed strings are UTF-8 text (this is exactly the
  kerchunk / fsspec reference-filesystem convention).
  - - Prior-art alignment; potential interop with kerchunk tooling.
  - - In-band signaling needs an escaping rule for genuine strings starting
    with the prefix; doesn't by itself distinguish JSON-object values (still
    needs B1 or B2 for those).

- **B6. Sectioned document.** The tag is positional: top-level namespaces
  like `{"metadata": {...}, "data": {...}}`, or an out-of-band type manifest
  (`"__types__": {...}`).
  - - Reads pleasantly — all metadata grouped, all data grouped.
  - - The document no longer mirrors the store keyspace; every key appears
    in two places conceptually; `list`/`list_dir` must merge namespaces;
    manifest variants can drift from entries.

## Dimension C — who decides at write time

The Zarr `Store` interface traffics only in bytes, so something must decide
each write's representation:

- **C1. Key convention in the store shim (status quo).** Sound only because
  Zarr v3 writers put JSON at `zarr.json` keys and nothing else. Under B2 it
  survives as a *write policy* rather than a validity rule — a wrong guess
  would produce a valid (just less legible or oddly-inlined) document rather
  than an unreadable one.
- **C2. Content sniffing.** Unsound; ruled out. Chunk bytes can be valid
  JSON, and base64 strings are indistinguishable from string data.
- **C3. Hierarchy-level converter instead of (or beside) a store.** Export /
  import via the Zarr library's node API — the way consolidated metadata
  works — where node types and dtypes are *known*, so the converter can
  choose representations per node (and is the only sound route to A4's
  value-represented data, since it can run the codec pipeline).
- **C4. Both.** The store shim is the fidelity path (any store, bytes
  preserved); a converter is the legibility path (opinionated, may decode
  data to values). They can share one container format if dimension B
  reserves room for both value kinds.

## Prior art

- **kerchunk / fsspec reference filesystem** — the same key → (bytes | text |
  external-ref) problem; solved with the `"base64:"` prefix and
  `[url, offset, length]` arrays (B5 + structural).
- **TensorStore kvstore adapters (`zip`, `ocdbt`)** — the same *move* as
  zarr-json: an adapter that represents an entire key-value store inside a
  single artifact (a ZIP archive; an OCDBT B+tree object). Both containers
  are strictly value-agnostic — bytes in, bytes out, the adapter never
  interprets a value — which is the layering that keeps them format- and
  Zarr-agnostic. zarr-json is the human-readable member of this family, and
  the legibility goal is precisely what tempts it to break that layering;
  B2 is the option that keeps the container value-agnostic *in spirit*
  (discrimination by JSON type, never by content interpretation).
  TensorStore never faced the JSON sum-type problem because its containers
  are binary; kerchunk remains the closest art for that specific question.
- **TensorStore `json` driver** — read-write access to JSON values in any
  kvstore, addressed by RFC 6901 JSON Pointer, with atomic
  read-modify-write per pointer (concurrent writes to non-overlapping
  pointers don't lose updates). Prior art for two things zarr-json has not
  yet considered: a *nested* document layout addressed by pointers (vs our
  flat store-key map), and per-subvalue write atomicity (vs our
  whole-object lock).
- **MongoDB Extended JSON** — `{"$binary": ...}`: marked bytes (B3) with
  `$`-reserved keys as the collision guard.
- **Zarr consolidated metadata** — inlines only metadata, excludes data
  entirely; zarr-json is the extension of that idea to data, and the typing
  problem enters exactly at that extension.
- **serde union representations** — the standard taxonomy behind dimension B.
- **CBOR / Ion / msgpack** — formats with native byte types; the "leave JSON"
  option, out of scope given the project's premise.

## How the options score

Criteria: legibility (L), reader-unambiguity (U), totality over Key→Bytes
stores (T), spec+impl simplicity (S), Zarr-agnosticism (Z), extensibility to
value-data / refs (E).

| Option | L | U | T | S | Z | E |
|---|---|---|---|---|---|---|
| B1 key convention (status quo) | good | good* | **no** | good | **no** | **no** |
| B2 structural | good | good | **yes** | **best** | yes | partial (arrays free; strings not) |
| B3 marked bytes | good | good | yes | ok (escape rule) | yes | good |
| B4 fully tagged | poor | best | yes | ok | yes | best |
| B5 prefix sentinel | good | ok (escaping) | yes | ok | partial | partial |
| B6 sectioned | good | good | yes | poor (dual namespace) | yes | ok |

\* B1's unambiguity holds only after fixing the suffix check to match whole
path segments, and only for stores that never put non-JSON bytes at
metadata-named keys.

## Observations, not yet decisions

1. **B2 is the minimal fix.** It keeps every existing document valid
   byte-for-byte, deletes the container's knowledge of Zarr naming, makes
   the encoding total, and reserves the `array` JSON type for a future
   value-represented data mode — which converts the companion
   bytes-vs-values question from either/or into both, distinguishable by
   structure. Its one real gap (top-level JSON strings/numbers as values)
   doesn't exist in Zarr v3.
2. **B3/B4 are where to go if requirements grow** — external references,
   byte-exact metadata (store a metadata doc as bytes when checksums
   matter), or string-dtype inline data. They buy generality with ceremony.
3. **Dimension C is quietly the architectural fork.** A store shim can never
   soundly produce value-represented data (it only ever sees post-codec
   bytes); if A4/values matter, a hierarchy-level converter must exist, and
   the format should be designed so both producers emit the same container.
4. Independent of any decision: the `endswith("zarr.json")` check should
   match `key == "zarr.json"` or `key.endswith("/zarr.json")` — the current
   form misclassifies keys like `xyzarr.json`.
