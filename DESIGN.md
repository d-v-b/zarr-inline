# zarr-json: How It Works

This document explains the design behind [SPEC.md](SPEC.md): the model, the
reasoning behind its central choices, how the three implementations are
built, how they are tested against each other, and the constraints and
limitations that shape all of it. The spec is normative; this document is
explanatory.

## 1. Purpose and scope

Zarr stores a hierarchy as a tree of directories and files, which is
awkward to share: many files, not one artifact. zarr-json represents the
same hierarchy as a single JSON object — a small hierarchy becomes one
portable, human-inspectable, hand-editable document.

The premise is *small* hierarchies. Consequently:

- **Performance is an explicit non-goal.** Every design choice below
  trades CPU for legibility and cross-language exactness without apology.
- **Correctness is a goal**, including under concurrent mutation of a
  store.
- **Zarr v3 only.** A Zarr v2 variant could be derived (v2 metadata
  documents are `.zarray`, `.zgroup`, `.zattrs`) but is out of scope.
- **Hierarchy integrity is not validated.** The format's premise is that
  documents are cheap to inspect; a consumer who needs integrity can look.

## 2. The model: a store transformation

A Zarr v3 store is a map from keys to byte strings. zarr-json is a
transformation of that map into a JSON object: keys carry over unchanged
as member names; each value is encoded in one of three forms.

```
Key → Bytes        ⟷        JSON object member
metadata document  ⟷        inline JSON object
opaque bytes       ⟷        base64 string
json-codec chunk   ⟷        inline JSON array of decoded values
```

### 2.1 Value typing: the sum-type problem

The document must encode a sum type, `Map<Key, Json | Bytes>`, in JSON —
which cannot natively distinguish a base64 string from a string datum, and
whose chunk bytes can themselves be valid JSON text (`b"123"` parses). So
the type tag must live somewhere deliberate. The options considered, in
the vocabulary of tagged-union encodings:

| option | tag lives in | verdict |
|---|---|---|
| key-name convention (`*zarr.json` → JSON) | the key | Zarr-version-specific; partial (can't hold arbitrary bytes at metadata-named keys); no room for a third value kind |
| **structural: object / string / array** | the value's JSON type | **adopted** — see below |
| marked bytes `{"b64": "..."}` | wrapper on bytes only | fully general; needs a collision escape; chunk values stop being bare strings |
| fully tagged `{"json": …}` / `{"b64": …}` | wrapper on everything | bulletproof and extensible; heaviest legibility tax |
| prefix sentinel `"base64:..."` (kerchunk) | in-band string prefix | needs escaping; doesn't cover objects |
| sectioned `{"metadata": {…}, "data": {…}}` | position | document stops mirroring the key space |

**Structural discrimination** is adopted: for a given key class, the JSON
type of the value determines its meaning — object = metadata, string =
bytes, array = data values. For every plain Zarr store this yields the
same document as the key convention would (metadata documents are
objects, chunks are strings), but it makes the container total over byte
stores, keeps Zarr-naming knowledge out of the container except for the
one `zarr.json` rule, and reserves the JSON *array* type for inline data.
The remaining gap — a top-level JSON string or number cannot be a JSON
*value* — does not arise in Zarr v3.

### 2.2 Prior art

- **kerchunk / fsspec reference filesystem** solves the same
  key → (bytes | text | external-ref) problem with a `"base64:"` prefix
  and `[url, offset, length]` arrays.
- **MongoDB Extended JSON** marks bytes with a reserved `{"$binary": …}`
  wrapper.
- **Zarr consolidated metadata** inlines only metadata documents; zarr-json
  is the extension of that idea to data, which is exactly where the typing
  problem enters.
- **TensorStore** has the closest structural relatives: its `zip` and
  `ocdbt` kvstore adapters put an entire key-value store in one artifact,
  strictly value-agnostic — the layering zarr-json preserves in spirit. Its
  `json` driver (JSON values addressed by RFC 6901 pointers, atomic
  read-modify-write per pointer) and `array` driver (data embedded in the
  spec as nested JSON arrays) are precedents for pointer-addressed layouts
  and for the nested-array value representation; TensorStore puts
  JSON-valued data behind a `json` *dtype* rather than a codec, and its
  zarr drivers deliberately do not store it.

## 3. Legible data: the `json` codec

Under the Zarr model, whatever sits at a chunk key is the *output of the
codec pipeline*, so "chunks as JSON arrays" requires the pipeline's output
to be JSON text. The conversion array ↔ JSON could live in three places:

1. **an array→bytes codec** (host-side; adopted);
2. store-side transcoding of `[bytes]`-only chains — no ecosystem change,
   but the container would absorb dtype/endianness knowledge and every
   implementation would carry a mini-codec;
3. a hierarchy-level converter that rewrites codec chains on export —
   which composes with (1) rather than replacing it, and is the only sound
   way to make an already-compressed array legible.

The codec keeps the container dumb: on `get` of an array value the store
serializes canonical JSON text and the *host's* codec does all dtype
interpretation. The cost is ecosystem coordination — the codec must exist
in every host library that reads such arrays (it does, in all three
reference implementations; the name `json` is not yet registered with the
zarr-extensions registry).

### 3.1 Definition: the fill_value convention, elementwise

Every Zarr v3 data type must define a JSON scalar serialization to be
representable in the `fill_value` metadata field at all. The codec reuses
it: **encode = the fill_value scalar serialization applied elementwise,
nested by chunk shape in C order, in canonical form.** Coverage over data
types is therefore total by construction, and the implementation in each
language is a loop over existing fill-value machinery (`ZDType.to_json_scalar`
in zarr-python, zarrs's `FillValueMetadata`, zarrita's scalar conventions).

| data type | element JSON |
|---|---|
| bool | `true` / `false` |
| integers | exact digits, any width |
| floats | number; `"NaN"`, `"Infinity"`, `"-Infinity"` as strings |
| complex | `[re, im]`, each per the float rule |
| fixed-length bytes / void | base64 string (unambiguous: only the top-level JSON type carries the container tag) |
| strings | JSON string |
| datetime / timedelta | epoch integer |

Decoding is shape-driven — recursion depth comes from the chunk shape,
never from the values, because a complex scalar's JSON form is itself a
two-element array — and strict: out-of-range or wrong-sort scalars are
errors, never coercions.

### 3.2 Why canonical form makes the store sound

The store API is `str → bytes`; `set` receives bare bytes and cannot be
told whether they are "really" JSON. The store decides from the bytes
alone: it inlines a byte value as an array **iff** the bytes strict-parse
to a JSON array whose canonical re-serialization is byte-identical to the
input. This is lossless regardless of what the bytes actually are — even
a compressed chunk that coincidentally passed the check would round-trip
byte-exactly — so the store never consults metadata and never guesses
wrong in a way that matters. The `json` codec emits canonical output, so
its chunks always pass; compressed bytes, binary, non-canonical JSON like
`[1, 2]`, `NaN` tokens, and rank-0 scalars all fall through to base64.

Canonical form is therefore load-bearing, not cosmetic: the classification
rests on the equality `canonical(parse(bytes)) == bytes` being
deterministic and identical across languages.

Two practical notes. Host libraries append default compressors unless
told not to (zarr-python adds zstd after a user-supplied serializer), so
creating a legible array requires pinning the whole chain
(`compressors=None`). And the check costs a parse attempt per write —
cheap for binary chunks, which fail at the first byte, and acceptable for
canonical JSON chunks, which are small by premise.

### 3.3 Composition

The codec should be the only codec in the chain. Compression after it
defeats the purpose. An array→array codec before it — `transpose` — is
not interoperable: zarr-python and zarrs nest the chunk JSON by the
codec-resolved (permuted) shape, while zarrita's pipeline does not expose
resolved metadata to its array→bytes codec (its transpose is implemented
through strides with the original shape, which was unobservable until a
shape-dependent codec existed). The fix is small and upstream
(`TransposeCodec.getEncodedMeta` in zarrita); until then portable
documents use `json` alone.

## 4. Canonical serialization

The canonical form (SPEC §5) is compact, UTF-8-unescaped, and preserves
member order. Its number rules are where the cross-language work is.

**RFC 8785 numbers.** Floats serialize with ECMAScript `Number::toString`
semantics. JavaScript gets this natively; Python implements the ES
algorithm over `repr`'s shortest digits (differential-tested against node
on 10,000 doubles), Rust over ryu's digits via a custom serde formatter.
This removes every float-text divergence that native formatters have
(Python's `1e-07` vs `1e-7`, `1.0` vs `1`, `-0.0` vs `0`) at the cost of
the sign of negative zero, which JCS serializes as `0`. Member order is
deliberately *not* sorted, departing from full JCS: Zarr metadata reads
better in written order, and JSON object semantics do not depend on it.

**Two-sorted numbers, exact integers.** A number is an arbitrary-precision
integer or a float64, decided by its token (integer literal or not).
Integers survive exactly at any magnitude in all three implementations:
Python natively; TypeScript by parsing out-of-safe-range integer literals
as `BigInt` through the `JSON.parse` reviver's source-text access (Node ≥
21); Rust through serde_json's `arbitrary_precision` raw tokens, with the
canonical formatter re-formatting float tokens and passing integer tokens
through. `1.0` and `1` both canonicalize to `1`; the sort is not
recoverable from text, which is harmless because every consumer
(metadata semantics, dtype-driven chunk decoding) interprets numbers by
context.

**Strict parsing.** Native JSON parsers disagree at the edges: Python's
accepts bare `NaN`/`Infinity` tokens and overflow literals like `1e999`;
serde_json rejects both and additionally rejects >128-deep nesting and
BOMs; JavaScript accepts overflow. Every implementation therefore parses
through a strict wrapper that rejects the tokens and float64 overflow and
preserves big integers, at every text boundary (document load, metadata
bytes on `set`, the inlining check, chunk bytes, harness input).
Duplicate member names resolve identically everywhere (last value, first
position) and are specified as such.

## 5. Implementation architecture

Each implementation is a thin wrapper around an existing Zarr library: it
provides a **read-write store** conforming to the host's store interface,
and the host does all array reading and writing.

| language | host | store interface |
|---|---|---|
| Python | zarr-python v3 | `zarr.abc.store.Store` |
| TypeScript | zarrita | `AsyncMutable` (`AsyncReadable & AsyncWritable`, with `getRange`) |
| Rust | zarrs | `ReadableStorageTraits` + `WritableStorageTraits` + `ListableStorageTraits` |

All three share one internal shape:

- **codec** — pure functions: key classification, canonical serialization,
  strict parsing, `decode_value` (document value → bytes) and
  `encode_value` (bytes → document value, with the inlining rule).
- **validator** — R1 (well-formed keys) and R2 (value type by key class);
  at most one issue per key, R1 first; strict mode raises, lenient mode
  returns diagnostics.
- **store** — holds the parsed document behind a lock (Python: an
  `asyncio.Lock`, so a store is bound to one event loop; TypeScript: a
  FIFO async mutex, since operations interleave at `await` points; Rust:
  an `RwLock`), implements `get`/`set`/`delete`/`exists`/`list`/
  `list_prefix`/`list_dir` by scanning keys and splitting on `/`, rejects
  R1-malformed keys on `set`, and runs the validator on construction.
  Partial reads apply byte ranges to the decoded bytes; Rust's partial
  writes are a read-modify-write under a single lock acquisition. In
  lenient mode, invalid entries are skipped and the rest — including
  listing — stays usable.
- **backing** (Python, TypeScript) — where the document lives: memory
  (the object is the source of truth), string (parsed from / dumped to
  text), file (Python; read from / written to a `.json` file,
  pretty-printed). The store calls `persist` after every mutation; for the
  file backing that is a full-document rewrite per write, accepted under
  the performance non-goal (an explicit flush mode would be the natural
  optimization if it ever mattered). Rust exposes the document directly
  (`document()` / `to_json_string()`).

  **Document text is owned by whatever persisted it last.** Whitespace and
  indentation in the document are never significant — a key's bytes are
  the canonical serialization of its *parsed* value, so a hand-formatted
  document reads identically to a minified one. But `persist` re-serializes
  the whole in-memory document with the host's JSON dumper, so hand layout
  does not survive a re-persist: Python's file backing pretty-prints at
  `indent=2`, string exports and `to_json_string()` are compact. Member
  order is preserved. Number *spellings* can also be rewritten, and this
  varies by language because persist uses the native dumper rather than
  the canonical serializer (a hand-written `1.0` stays `1.0` in Python and
  Rust, becomes `1` in TypeScript); any key that goes through a write
  cycle is fully normalized. The guarantee across all of this is
  equivalence (SPEC §7.3) — same keys, same decoded bytes — not textual
  stability, exactly as zarr-python rewrites `zarr.json` in its own
  formatting. A formatting-preserving backing (targeted textual edits
  instead of re-serialization) would be the fix if hand layout ever needed
  to survive edits; nothing in the current use case calls for it.
- **serializer** — the `json` codec registered with the host: zarr-python
  via `register_codec`, zarrita via its codec `registry` map, zarrs via
  `inventory`-based plugin registration mirroring its own `bytes` codec.
- **harnesses** — the conformance and crosscheck CLIs (§6).

Language-specific points worth knowing:

- **TypeScript** re-keys every loaded document onto a null-prototype
  object (a plain object silently loses a write to `"__proto__"`); its
  canonical serializer is hand-rolled (JSON.stringify emits `0` for `-0`
  and `null` for non-finite values, and cannot error on lone surrogates);
  its codec walks `chunk.stride` in C order; int64/uint64 travel as
  `BigInt` across their full ranges; it requires Node ≥ 21.
- **Rust** builds the conformance harness without zarrs
  (`--no-default-features`) so the container layer is testable
  independently; listing skips keys zarrs's `StoreKey` rejects; partial
  reads use checked arithmetic (zarrs's own `MemoryStore` panics in debug
  builds on out-of-range ranges).
- **Python** is the reference implementation; the others mirror its
  semantics.

Error handling follows the spec's taxonomy: malformed document → error in
strict mode, diagnostics in lenient mode; `set` of non-object bytes at a
metadata key → error, no mutation; `get` of a missing key → the host's
not-found convention; invalid base64 on `get` → per-key error.

## 6. Testing and conformance

Per implementation: unit tests for the codec (classification,
encode/decode, the inlining rule's edge cases), the validator (every rule,
valid and invalid), backings, store operations and locking, and the
serializer (per-dtype round trips plus one test per error case); and an
integration test driving the host library through the store.

Across implementations, three layers, all orchestrated from Python:

**Fixtures.** `examples/valid/` and `examples/invalid/` hold documents;
`examples/MANIFEST.json` maps each to its expected verdict and failing
rule. Every implementation runs every fixture through its validator.
`examples/valid/ome_zarr_0.5_image.json` is a real OME-NGFF 0.5
multiscale image with inline chunks, which all three host libraries open
and read identically.

### 6.1 Conformance harness protocol

Each implementation ships a CLI that reads a document on stdin and writes
a report on stdout:

```json
{
  "issues":    [{"rule": "R1", "key": "..."}],
  "decoded":   {"<key>": "<base64 of decode_value(key, value)>"},
  "reencoded": {"<key>": <encode_value(key, decoded bytes)>},
  "errors":    ["<key>"]
}
```

- `issues`: all validator issues, sorted by `(key, rule)` — keys compared
  by Unicode code point.
- `decoded` / `reencoded`: every issue-free key that decodes, any order
  (compared structurally; `decoded` values are base64 strings, so
  byte-level agreement is exact).
- `errors`: keys that passed validation but failed to decode (e.g. a byte
  key whose string is not base64), sorted. A decode failure on one key
  never aborts the report.
- Non-object or unparseable input: message on stderr, exit 1.

| implementation | build | run |
|---|---|---|
| Python | `cd python && uv sync` | `uv run python -m zarr_json.conformance` |
| TypeScript | `cd typescript && npm install && npm run build` | `node typescript/dist/conformance.js` |
| Rust | `cd rust && cargo build` | `rust/target/debug/conformance` |

`python/tests/test_conformance_property.py` generates documents with
Hypothesis — metadata objects, base64 byte values, inline arrays,
dubious strings at byte keys, malformed keys and type violations; floats
across the float64-safe range including integral values, negative zero,
exponent forms, and subnormals; integers to ±10^30 — runs the Python
harness in-process and the other two as subprocesses (built on demand,
skipped if their toolchains are absent), and requires the three parsed
reports to be identical. The generated space avoids only integer-like
object member names (§7).

### 6.2 Crosscheck protocol

The conformance harness tests the container layer; the crosscheck
harness tests the array layer across host libraries. Payload:

```json
{"arrays": [{"path": "grp/a", "dtype": "int64", "shape": [2, 2],
             "chunks": [1, 2], "data": [[1, 2], [3, 4]]}]}
```

`dtype` is a Zarr v3 data type name (the portable set: `bool`, `uint8`,
`int32`, `int64`, `float32`, `float64`); `data` is nested C-order JSON in
fill_value scalar conventions. `<harness> write` turns a payload into a
document through the host library (root group, arrays at `path` with the
`json` codec and no compressors, default `/` chunk-key encoding);
`<harness> read` opens every `<path>/zarr.json` array node in a document,
sorted by path, and emits a payload. Invocations mirror the table above
with `crosscheck` in place of `conformance` and a `write` or `read`
argument.

`python/tests/test_crosscheck.py` runs the full writer × reader matrix
(nine combinations) over a fixed payload — every portable dtype, edge
chunks, a nested group path, non-finite floats, int64 across its full
range including values JavaScript carries only as BigInt — and requires
every reader to reproduce the written payload exactly (Python-side
structural comparison, so `1` and `1.0` compare equal; `"NaN"` strings
keep non-finite comparisons exact). Readers tolerate each other's
metadata idioms without special cases; the Rust writer disables zarrs's
`_zarrs` attribute to stay maximally standard.

## 7. Constraints and known limitations

Portable documents (SPEC §10) stay within bounds where all three
implementations provably agree. What lies outside, and why:

- **Integer-like object member names** (`"0"`, `"10"`) inside metadata:
  JavaScript's native objects enumerate them numerically first, so an
  implementation built on `JSON.parse` cannot preserve document member
  order for them, and canonical bytes diverge. This is the one remaining
  item the property test must avoid. (Store keys are unaffected — they
  contain `/`.)
- **`transpose` + `json`** is not interoperable pending the zarrita
  upstream fix (§3.3); cross-reads fail loudly on shape mismatch.
- **Negative-zero sign** is lost (RFC 8785). **NaN payloads** are not
  preserved (every NaN becomes `"NaN"`). Zarr v3's bit-exact hex-string
  float forms are never emitted; decoder acceptance genuinely differs
  (zarr-python and zarrs accept, zarrita rejects), so documents containing
  them are non-portable.
- **Nesting depth** is bounded at 100 for portability (serde_json's limit
  is 128; CPython's is higher but finite). **Lone surrogates** and a
  **leading BOM** split the parsers three ways and are excluded.
- **Codec name.** `json` is unregistered; a stock Zarr library without the
  codec cannot read `json`-encoded arrays (the rest of the document stays
  readable).
- **Key grammar.** R1 is slightly broader than Zarr v3's node-name rules
  (v3 also forbids all-period names and reserves the `__` prefix);
  zarr-json defers hierarchy naming to the Zarr layer.
- **Rank-0 chunks** encode as a bare scalar and so are stored base64 —
  except complex, whose `[re, im]` form is an array and inlines.
- **Performance** is traded away deliberately: the inlining check parses
  on every write, the file backing rewrites the whole document per
  mutation, and the Python codec converts elementwise. Natural
  optimizations (first-byte fast path, explicit flush, vectorized dtype
  fast paths) are all semantics-preserving and none is implemented.

## 8. Repository layout

```
SPEC.md                  normative specification
DESIGN.md                this document
examples/                shared fixtures (valid/, invalid/, MANIFEST.json)
python/                  zarr-python implementation; owns the cross-implementation tests
typescript/              zarrita implementation
rust/                    zarrs implementation
```
