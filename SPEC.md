# zarr-json Specification

**Version:** 0.1.0-draft
**Date:** 2026-08-20
**Status:** Draft

zarr-json is a convention for storing a Zarr v3 hierarchy as a single JSON
document, for simple interchange of small hierarchies: one portable,
human-inspectable, hand-editable file.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be
interpreted as described in RFC 2119.

## 1. Overview (non-normative)

A Zarr v3 store is an association of *keys* to *byte strings*. zarr-json
encodes such a store as one JSON object whose member names are the store
keys and whose values carry the bytes in one of three forms: metadata
documents as inline JSON objects, opaque bytes as base64 strings, and —
for arrays encoded with the `json` codec (§8) — chunk data as inline JSON
arrays of the decoded values. A JSON value's type alone determines its
meaning: object = metadata, string = bytes, array = data values.

```json
{
  "zarr.json":         { "zarr_format": 3, "node_type": "group", "attributes": {} },
  "a/zarr.json":       { "zarr_format": 3, "node_type": "array", "...": "..." },
  "a/c/0":             [1.5, "NaN", 2, 3.25],
  "b/zarr.json":       { "zarr_format": 3, "node_type": "array", "...": "..." },
  "b/c/0":             "H4sIAOq/hmoA..."
}
```

## 2. Terminology

- **document** — a zarr-json document: a single JSON (RFC 8259) object.
- **store key** (or **key**) — a member name of the document; a Zarr v3
  store key.
- **metadata key** — a key that names a Zarr v3 metadata document (§3.2).
- **byte key** — any key that is not a metadata key.
- **inline array** — a JSON array appearing as the value of a byte key.
- **canonical serialization** — the byte-exact JSON text form defined in §5.
- **decoded bytes** — the byte string a key's value denotes (§6).

## 3. Keys

### 3.1 Well-formed keys

A key MUST be a non-empty string that does not begin or end with `/` and,
when split on `/`, yields no segment that is empty, `.`, or `..`. This is
rule **R1**.

### 3.2 Metadata keys

A key is a *metadata key* if and only if it is exactly `zarr.json` or ends
with `/zarr.json` (i.e. its final `/`-separated segment is `zarr.json`).
Every other key is a *byte key*.

Note: a key merely *ending in* the characters `zarr.json` without a
segment boundary (e.g. `xyzarr.json`) is a byte key.

## 4. Values

Rule **R2**, by key class:

- The value of a **metadata key** MUST be a JSON object.
- The value of a **byte key** MUST be either a JSON string (base64-encoded
  bytes, §4.1) or a JSON array (inline data values, §4.2).

### 4.1 Byte strings (base64)

A byte-key string value MUST be base64 per RFC 4648 §4: the standard
alphabet (`A–Z a–z 0–9 + /`), padding with `=` to a multiple of four
characters, and no whitespace or other characters. Encoders MUST emit
canonical base64. Decoders MUST accept any string meeting the above;
decoders MAY additionally accept non-zero trailing padding bits (e.g.
`"AB=="`, which denotes the single byte `0x00`) — all reference
implementations do.

A string value that fails base64 decoding is a *decode error* for that
key; it does not make the document invalid (§7).

### 4.2 Inline arrays

A byte-key array value denotes the UTF-8 bytes of its canonical
serialization (§5). Any JSON array is permitted; in practice inline
arrays are produced by the `json` codec (§8) and hold chunk data.

## 5. Canonical JSON serialization

The canonical serialization of a JSON value is UTF-8 text produced by
these rules:

1. **No whitespace.** Separators are exactly `,` and `:`.
2. **Object members** appear in their original order (document order /
   insertion order). Member names are **not** sorted. *(This deliberately
   departs from RFC 8785, which sorts; Zarr metadata is friendlier to
   humans in written order, and JSON object semantics do not depend on
   member order.)*
3. **Strings** use JSON escaping with the two-character forms `\"` `\\`
   `\b` `\f` `\n` `\r` `\t`, `\u00xx` (lowercase hex) for other control
   characters, and no escaping of any other character (non-ASCII is
   written as UTF-8 directly). Strings MUST be well-formed Unicode: a
   lone surrogate is a canonicalization error.
4. **Numbers** follow RFC 8785 §3.2.2.3:
   - A number whose source token is an *integer literal* (no `.`, `e`, or
     `E`) is an integer and serializes as its exact decimal digits, at any
     magnitude. The token `-0` serializes as `0`.
   - Every other number is a float64 value and serializes with ECMAScript
     `Number::toString` semantics: shortest round-trip digits; no decimal
     point for integral values (`1.0` → `1`); negative zero → `0`; fixed
     notation for magnitudes in `[1e-6, 1e21)`, otherwise exponential with
     an explicit sign and no zero-padding (`1e+21`, `1e-7`).
   - Non-finite values cannot be written; a number token that overflows
     float64 (e.g. `1e999`) is a *strict-parse* error (§6.3).
5. `true`, `false`, `null` serialize as those literals.

Two consequences worth stating: canonical serialization is deterministic
and byte-identical across implementations, and `parse ∘ serialize` is the
identity on canonical text.

## 6. Byte semantics

### 6.1 Decoding (document value → bytes)

- metadata key → the canonical serialization (§5) of its object, as UTF-8.
- byte key, string value → the base64-decoded bytes.
- byte key, array value → the canonical serialization of the array, as
  UTF-8.

### 6.2 Encoding (bytes → document value)

Writers (e.g. a store's `set`) MUST proceed:

- metadata key: strict-parse (§6.3) the bytes; the result MUST be a JSON
  object; store it inline. Anything else is an error.
- byte key: if the bytes strict-parse to a JSON **array** whose canonical
  serialization is byte-identical to the input, store that array
  (*lossless inlining*); otherwise store the canonical base64 of the
  bytes.

The inlining rule is lossless by construction: whatever the bytes were,
decoding the stored value reproduces them exactly.

### 6.3 Strict parsing

Wherever this specification says *strict-parse*, JSON parsing MUST reject,
in addition to everything RFC 8259 rejects: the non-JSON tokens `NaN`,
`Infinity`, `-Infinity`; and any number token that overflows float64 to a
non-finite value (e.g. `1e999`). Integer literals MUST be preserved
exactly at any magnitude (they are not subject to float64 range).

### 6.4 Normal form

A document in which every byte value that *could* be inlined losslessly
*is* inlined, every base64 string is canonical, and every inline value is
in canonical form is in **normal form**. Writers produce normal-form
values; a write cycle (`get` then `set`) normalizes a key. Two documents
are *equivalent* when they have the same key set and identical decoded
bytes per key; equivalence, not textual equality, is the round-trip
guarantee.

## 7. Validity

A document is **valid** when every key satisfies R1 (§3.1) and every value
satisfies R2 (§4). That is all: validity does not require a root
`zarr.json`, does not forbid orphan chunks, and does not check that the
document forms a coherent Zarr hierarchy — a Zarr store is valid while
empty or partially populated, so a document under construction is valid
throughout.

Validators MUST report at most one issue per key, checking R1 first and
reporting R2 only for keys that pass R1. Validators SHOULD offer a strict
mode (invalid document is an error) and a lenient mode (issues are
diagnostics; offending entries are skipped, and remaining entries stay
fully usable, including listing operations).

Base64 decode failures and canonicalization failures are *decode errors*
surfaced when a key's bytes are requested; they are not validity issues.

### 7.1 Store write requirements

A store implementation MUST reject a `set` with a key violating R1, so
that a store driven through its API always produces a valid document.

## 8. The `json` array→bytes codec

An array→bytes codec (Zarr v3 "serializer") named `json`, with no
configuration (the `configuration` member MUST be absent or empty).
Arrays encoded with it appear in the document as inline JSON arrays of
their decoded values.

### 8.1 Encoding

A chunk encodes as the canonical serialization (§5) of a nested JSON
array: the chunk's elements in C (row-major) order, nested by the chunk
shape, each element serialized with the **Zarr v3 `fill_value` scalar
convention** for the array's data type. In particular:

| data type family | element JSON |
|---|---|
| bool | `true` / `false` |
| integers (any width) | exact decimal digits |
| floats | number per §5.4; non-finite as the strings `"NaN"`, `"Infinity"`, `"-Infinity"` |
| complex | two-element array `[re, im]`, each per the float rule |
| fixed-length bytes / raw | base64 string |
| strings | JSON string |

Encoders MUST NOT emit the bit-pattern hex-string float forms that Zarr v3
permits for `fill_value` (e.g. `"0x7fc00000"`); decoders MAY accept them.
The sign of negative zero is not preserved (§5.4).

Because every Zarr v3 data type must define a `fill_value` serialization
to be representable in metadata at all, this codec is defined for every
data type by construction.

### 8.2 Decoding

Decoding is shape-driven: recurse through the nested arrays exactly
`rank` levels (a scalar's JSON form may itself be an array — complex —
so recursion depth comes from the chunk shape, never from the values).
The nesting MUST match the chunk shape exactly. Scalar parsing MUST be
strict: out-of-range or non-integral values for integer types, and
malformed scalars generally, are errors, not coercions.

### 8.3 Composition and restrictions

- The `json` codec SHOULD be the only codec in the chain. `bytes→bytes`
  codecs after it (compression) produce opaque chunks, defeating the
  purpose; `array→array` codecs before it (e.g. `transpose`) are
  **implementation-defined** and currently not interoperable.
- The codec does not support partial (sub-chunk) decoding; combining it
  with sharding is legal per Zarr v3 but produces illegible shards and is
  NOT RECOMMENDED.
- A rank-0 chunk encodes as a bare JSON scalar. A bare scalar is not an
  array, so containers store rank-0 chunks base64-encoded (§6.2).

## 9. Interoperability constraints

A *portable* document additionally satisfies (violations are
implementation-defined, not invalid):

- Nesting depth at most 100.
- No lone surrogates in any string; no leading BOM.
- Object member names within metadata SHOULD NOT be integer-like strings
  (`"0"`, `"42"`): JavaScript object semantics reorder them, which
  changes canonical member order across implementations.

Numbers carry no portability constraints: integers of any size and the
full float64 range round-trip exactly in all reference implementations.

## 10. Security considerations

Documents may come from untrusted sources. Implementations SHOULD bound
input size and parser recursion, and MUST NOT assume hierarchy coherence
(orphan keys, dangling metadata, and mismatched chunk shapes are all
representable). Decode errors — invalid base64, canonicalization
failures, shape mismatches — MUST surface as errors, never as silently
corrupted data. A zarr-json document contains no executable content.

## 11. Conformance

Three reference implementations (Python/zarr-python, TypeScript/zarrita,
Rust/zarrs) live in this repository. Shared fixtures in `examples/` (with
`MANIFEST.json` verdicts), a conformance-harness protocol, a
property-based cross-implementation test, and an array-level crosscheck
matrix are described in `docs/superpowers/specs/`:
`2026-08-20-conformance-protocol.md` and
`2026-08-20-crosscheck-protocol.md`.

## 12. References

- Zarr v3 core specification (stores, keys, metadata, codecs, fill_value).
- RFC 8259 (JSON), RFC 4648 §4 (base64), RFC 8785 §3.2.2.3 (number
  serialization), RFC 2119 (key words).
- ECMA-262, `Number::toString`.
- OME-NGFF 0.5 (the example in `examples/valid/ome_zarr_0.5_image.json`).
