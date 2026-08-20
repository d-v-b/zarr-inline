# Chunks as JSON Arrays — the Codec Question

**Date:** 2026-08-20
**Status:** Exploration; on 2026-08-20 option 1 (the fill_value-based json codec) was adopted — see the amendment in 2026-05-14-zarr-json-design.md
**Depends on:** 2026-08-20-value-typing-design-space.md (assumes the JSON
*array* type is reserved for inline data values)

## The premise

Under the Zarr model, whatever sits at a chunk key is the **output of the
codec pipeline**. So "display chunks as JSON arrays" is only coherent if the
pipeline's output *is* JSON text — which means the conversion array ↔ JSON
has to live somewhere. There are exactly three places it can live.

## Where the conversion lives

### 1. A `json` array→bytes codec (host-side)

Define a new Zarr v3 array→bytes codec ("serializer" in zarr-python terms):
encode = chunk → canonical UTF-8 JSON (nested arrays, C order); decode = the
inverse, with shape/dtype from the array spec.

- The zarr-json container stays completely dumb and Zarr-agnostic: on `get`
  of an array value it just serializes canonical JSON text; the *host's*
  codec does all dtype interpretation. Clean layering — dtype knowledge
  lives in exactly one place.
- The document is self-describing: `codecs: [{"name": "json"}]` in the
  array metadata honestly states how chunks are encoded.
- Cost: **ecosystem coordination.** The codec must be registered in every
  host library that reads such documents (zarr-python, zarrita.js, zarrs),
  and ideally named in the zarr-extensions registry. A stock library
  without the codec cannot read the array (it can still read the rest of
  the document).
- Precedent: numcodecs already ships a v2-era `JSON` codec (historically
  used for object dtypes), so the concept is not novel to the ecosystem.

**Spike result (this repo, zarr-python 3.2.1):** a working codec is ~40
lines — subclass `ArrayBytesCodec`, implement `_encode_single` /
`_decode_single`, `register_codec("json", ...)`, pass as
`serializer=JsonCodec()` at array creation. Full loop verified: zarr writes
through `ZarrJsonStore`, the document holds
`"legible/c/0/0": [[0,1,2,3],[4,5,6,7]]`, zarr reads it back exactly.
See `scratchpad` spike; worth promoting to the repo if we go this way.

### 2. Store-side transcoding (container-side)

No new codec: for arrays whose chain is exactly `[bytes]` (with known
endianness), the store itself converts binary ↔ values, consulting the
owning array's metadata (which it holds in the same document) for
shape/dtype.

- Zero ecosystem change — the metadata still says `bytes`, so *any* stock
  Zarr library can read the document **through a zarr-json store**, and the
  document is legible at rest.
- Cost: the zarr-json **spec absorbs dtype/binary knowledge** (fixed-width
  dtype tables, endianness, float bit-patterns) and every implementation
  must carry a mini-codec. The container stops being Zarr-agnostic — the
  exact property the typing redesign was buying. Transcoding must also be
  normative (a document may hold an array value wherever the chain is
  `[bytes]`), or documents stop being portable between implementations.
- Restricted to trivially invertible chains, same as option 1 in practice.

### 3. Hierarchy-level converter (outside the store)

An export/import tool walks the hierarchy through the host API, decodes
data with whatever chain the array has, and **rewrites the codec chain** to
`json` (or to `bytes`+compressor, going the other way), updating metadata to
match.

- This is not really a third home for the conversion — it *composes with*
  option 1: the converter is how an existing compressed array becomes a
  legible one ("make legible" / "make compact" transforms), while the codec
  defines what legible means. Crucially the output document stays
  self-consistent: metadata never lies about how chunks are encoded.
- A converter is also the only sound producer of value-data from arrays
  that currently use opaque codecs, since a store shim only ever sees
  post-codec bytes.

## Findings from the spike

**The canonical-form trick makes the store's write policy sound without
metadata.** The open problem from the typing doc was dimension C: a
bytes-only `Store.set` can't be told whether incoming bytes are "really"
JSON. If the codec spec mandates a *canonical* serialization (no
whitespace, shortest-round-trip numbers), the store can use the policy:

> inline iff `canonical_serialize(parse(bytes)) == bytes`

This is provably lossless **regardless of what the bytes actually are** —
even if some compressed chunk coincidentally passed the check, `get` would
return byte-identical output. The store never consults metadata, never
guesses wrong in a way that matters, and stays Zarr-unaware. Canonical form
is therefore not a nicety; it's what makes the whole design sound.

**Host libraries add default compressors.** zarr-python appended a default
zstd after the json serializer (`codecs: [json, zstd]`), silently producing
opaque chunks again; `compressors=None` is required. Any convenience API we
ship (e.g. "create legible array") must pin the *whole* chain, and the spec
should note that legibility requires the chain to terminate at `json`.

**The fidelity table already exists: it is the `fill_value` serialization.**
Because every Zarr v3 array metadata document must represent a scalar of its
data type in the `fill_value` field, the Zarr spec (core + data-type
extensions) already defines a JSON serialization for **every scalar of every
dtype** — including every dtype anyone will ever register, since defining
that serialization is a precondition for being a valid v3 dtype at all. The
codec spec therefore reduces to one sentence of substance:

> encode = the `fill_value` scalar serialization, applied elementwise,
> nested by shape in C order.

Verified against zarr-python 3.2.1, whose dtype classes expose exactly this
machinery (`ZDType.to_json_scalar` / `from_json_scalar`):

| dtype case | fill_value-convention JSON | verified |
|---|---|---|
| ints ≤ 2^53 | number | exact |
| int64/uint64 beyond 2^53 | number (arbitrary-precision grammar) | exact in Python; **JS parsers lose precision** — but this is already `fill_value`'s problem in every JS Zarr implementation; the codec inherits the wart *and its eventual fix* in one place |
| finite floats | number, shortest-round-trip decimal (`-0.0` preserved) | exact |
| NaN / ±Inf | strings `"NaN"`, `"Infinity"`, `"-Infinity"` | exact; end-to-end in the spike — document shows `[1.5,"NaN","Infinity",-0.0]`, zarr reads back nan/inf |
| NaN payloads / signaling bits | v3 spec *allows* bit-exact hex strings (`"0x7ff8000000000001"`), but zarr-python's scalar API collapses to `"NaN"` | implementation gap, not a spec gap |
| complex | `[re, im]` pair, each per float rules (`["NaN",1.0]` works) | exact |
| bool | `true` / `false` | exact |
| datetime/timedelta | epoch integer (NaT = int64 min) | exact |
| string dtypes | JSON strings | exact |
| fixed bytes / void (`S*`, `V*`, `r*`) | base64 strings *inside* the array | exact — and the typing recursion resolves itself: only the *top-level* JSON type carries the container tag, so base64 strings as elements are unambiguous |

This also collapses the implementation cost: the Python codec is a loop over
`to_json_scalar` (the elementwise spike round-trips NaN/Inf/complex/datetime
through `ZarrJsonStore`), and zarrita/zarrs already have fill-value
codecs to build on. Performance of elementwise conversion is poor and
explicitly doesn't matter; common dtypes can fast-path later.

One caveat the codec spec must add: the fill_value encoding is **many-to-one**
(a NaN may legally be `"NaN"` or a hex string; a float could be a number or
hex). For the canonical-form trick to work, the codec must pick one
deterministic choice per value (e.g. number for finite, `"NaN"`/`"Infinity"`
for standard non-finite, hex string only when bit-payload preservation is
requested) and pin decimal formatting to shortest-round-trip. Decode accepts
all legal forms; encode is canonical.

**Other spec points:** nested arrays in C order (readable, matches shape)
vs flat + reshape (simpler parsers) — nested favors the display goal;
no partial decoding (whole-chunk only); combining with sharding is legal
per v3 but pointless (chunks end up inside a binary shard) — recommend
against; name/registration — plain `json` vs a namespaced name, and whether
to propose it to zarr-extensions.

## Prior art: TensorStore

TensorStore is instructive because it faced "JSON-valued data" and chose a
**different decomposition** than a codec:

- It has a first-class **`json` dtype** (also `string`/`ustring`) — "JSON
  value" as a *logical element type* — with the principle that "data types
  correspond to the logical data representation, not the precise encoding."
- JSON-dtype data lives behind a dedicated **`json` driver** (a JSON file
  in any kvstore, exposed as a rank-0 json tensor, sub-addressed by JSON
  Pointer, with atomic read-modify-write per pointer). Notably its zarr2 /
  zarr3 drivers **cannot store** json/string dtypes at all — TensorStore
  deliberately kept "zarr chunks are binary" and put JSON-valued data in a
  different driver rather than defining a JSON chunk encoding.
- Its **`array` driver** embeds actual array data *inline in the JSON spec*
  as nested JSON arrays (`{"driver": "array", "array": [[1,2,3],[4,5,6]],
  "dtype": "int32"}`) — direct precedent for the nested-array value
  representation, though the docs leave NaN/Inf/int64 JSON fidelity
  unspecified, which supports treating the fidelity table above as the real
  spec work.

Mapping to our options: TensorStore's stance is closest to option 3
(conversion outside the store/codec machinery) plus a type-system escape
hatch we don't have (a json *dtype*). Zarr v3's extension point for "how
are chunks encoded" is the codec chain, not the driver layer — so option 1
is the idiomatic Zarr translation of what TensorStore does with drivers.
The nested-array inline representation itself (rather than flat + shape)
matches the `array` driver precedent.

## How this composes with the typing decision

Under structural discrimination (B2), the two data representations coexist
per-array in one document with zero ambiguity — demonstrated in the spike:

```json
"legible/zarr.json":  { "codecs": [{"name": "json"}], ... },
"legible/c/0/0":      [[0,1,2,3],[4,5,6,7]],
"compact/zarr.json":  { "codecs": [{"name": "bytes"}, {"name": "gzip"}], ... },
"compact/c/0":        "H4sIAOq/hmoA/2NgOGDPwKDgwMCQAMQTHAAS9y3IEAAAAA=="
```

The bytes-vs-values question stops being a fork in the format and becomes a
per-array choice, made where codec choices are always made — at array
creation (or via a converter). The container format itself never changes.

## Open questions

1. Codec name and registration path (`json`? namespaced? zarr-extensions
   proposal?).
2. Nested vs flat serialization.
3. The int64-in-JS answer — inherited from `fill_value` rather than new to
   this codec; whatever the ecosystem's answer for fill values (BigInt-aware
   parsing, string encoding) applies here identically.
4. Whether option 2 (store-side transcoding of `[bytes]` chains) is worth
   offering *in addition*, for documents that must remain readable by stock
   libraries. It could be a non-normative implementation feature rather
   than a spec requirement.
5. Whether the reference implementations ship the codec (it's ~40
   lines/language) or it lives as a separate zarr extension.
