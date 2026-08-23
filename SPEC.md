# zarr-json Specification

**Version:** 0.2.0-draft
**Date:** 2026-08-21
**Status:** Draft (revised after adversarial spec review)

zarr-json is a convention for storing a Zarr v3 hierarchy as a single JSON
document, for simple interchange of small hierarchies: one portable,
human-inspectable, hand-editable file.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, MAY, RECOMMENDED, and
NOT RECOMMENDED are to be interpreted as described in RFC 2119.

## 1. Overview (non-normative)

A Zarr v3 store is an association of *keys* to *byte strings*. zarr-json
encodes such a store as one JSON object whose member names are the store
keys and whose values carry the bytes in one of three forms: metadata
documents as inline JSON objects, opaque bytes as base64 strings, and any
payload that IS byte-stable canonical JSON — such as chunks encoded with
the `json` codec (§9) — as an inline JSON array or object. For a given key
class, the value's JSON type determines its meaning: string = bytes,
array/object = inline JSON.

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

- **document** — a zarr-json document: JSON text (RFC 8259) whose
  top-level value is an object.
- **store key** (or **key**) — a member name of the document. Keys are
  intended to hold Zarr v3 store keys (but see §3.3).
- **metadata key** — a key that names a Zarr v3 metadata document (§3.2).
- **byte key** — any key that is not a metadata key.
- **inline value** — a JSON array or object appearing as the value of a
  byte key.
- **canonical serialization** — the byte-exact JSON text form defined in §5.
- **decoded bytes** — the byte string a key's value denotes (§7.1).
- **strict-parse** — the parsing discipline defined in §6.
- **error classes** — *document error*, *validity issue*, *decode error*,
  *codec error*; defined in §8.3.

## 3. Keys

### 3.1 Well-formed keys (rule R1)

A key MUST be a non-empty string that does not begin or end with `/` and,
when split on `/`, yields no segment that is empty, `.`, or `..`.

Keys are compared by exact code-point sequence: no case folding and no
Unicode normalization. Keys differing only in normalization form (e.g.
`é` vs `é`) are distinct.

### 3.2 Metadata keys

A key is a *metadata key* if and only if it is exactly `zarr.json` or its
final `/`-separated segment is `zarr.json`. The comparison is exact and
case-sensitive: `Zarr.json` and `xyzarr.json` are byte keys. Every other
key is a *byte key*.

### 3.3 Relation to Zarr v3 (non-normative)

R1 is deliberately broader than Zarr v3's node-name rules: v3 additionally
forbids node names consisting only of periods and reserves names beginning
with `__`. zarr-json does not re-validate hierarchy-level naming — as with
all hierarchy coherence (§8), that is deferred to the Zarr layer. Valid
zarr-json documents therefore exist whose keys no conforming Zarr v3
hierarchy would produce.

## 4. Values (rule R2)

By key class:

- The value of a **metadata key** MUST be a JSON object.
- The value of a **byte key** MUST be a JSON string (base64-encoded
  bytes, §4.1), or a JSON array or object (inline values, §4.2).

Any other value type (a number, boolean, or null at any key; a string or
array at a metadata key) is a validity issue (§8). Future revisions of
this specification may assign meaning to currently-invalid value types;
R2 is the format's extension point, and lenient readers (§8) therefore
skip, rather than fail on, values they do not recognize.

### 4.1 Byte strings (base64)

A byte-key string value MUST be base64 per RFC 4648 §4: zero or more
four-character groups from the standard alphabet (`A–Z a–z 0–9 + /`),
where only the final group may carry padding, in one of the two forms
`XX==` or `XXX=`. No whitespace or other characters are permitted.
(Consequently `""` denotes zero bytes, and strings such as `"===="` or
`"A==="` are not base64.)

*Canonical base64* additionally has zero non-zero trailing padding bits
(RFC 4648 §3.5): the encoding an encoder produces from bytes. Encoders
MUST emit canonical base64. Decoders MUST accept any string meeting the
grammar above, including non-canonical trailing padding bits (`"AB=="`
denotes the single byte `0x00`).

A string value that does not meet the grammar is a *decode error* for
that key (§8.3); it is not a validity issue.

### 4.2 Inline values

A byte-key array or object value denotes the UTF-8 bytes of its canonical
serialization (§5). Any array or object whose canonical serialization is
defined is permitted; in practice inline arrays are produced by the
`json` codec (§9) and hold chunk data, and inline objects arise from
payloads that are themselves canonical JSON documents. A value whose
canonical serialization fails (e.g. it contains a lone surrogate) is a
*decode error* for that key.

A top-level JSON **string** can never be an inline value: the string type
is the base64 channel (§4.1), and that reservation is what keeps every
value decodable.

## 5. Canonical JSON serialization

Canonical serialization maps a JSON value (in the data model of §5.1) to
UTF-8 text. It is deterministic: for any given value it yields exactly one
byte sequence, identical across implementations.

### 5.1 Data model

A JSON value is `null`, `true`, `false`, a string, a number, an array of
values, or an object of (name, value) members in a defined order. A
**number is one of two sorts**:

- an **integer**: arbitrary precision, unbounded magnitude;
- a **float64**: an IEEE-754 binary64 value (finite; non-finite values
  are not representable — see §5.5).

Parsing maps a number token that is an *integer literal* — no `.`, `e`,
or `E` — to an integer, and every other number token to the nearest
float64. Programmatic APIs MUST preserve the distinction; host-language
integer types map to integers, floating-point types to float64.
Implementations MUST preserve integer values exactly at any magnitude,
through parse, storage, and serialization.

### 5.2 Structure

1. **No whitespace.** Separators are exactly `,` and `:`.
2. **Object members** serialize in the value's member order (§5.1) —
   document order for parsed values, insertion order for constructed
   ones. Member names are **not** sorted. *(This deliberately departs
   from RFC 8785, which sorts.)*
3. `true`, `false`, `null` serialize as those literals.

### 5.3 Strings

JSON escaping with the two-character forms `\"` `\\` `\b` `\f` `\n` `\r`
`\t`, `\u00xx` (lowercase hex) for the remaining control characters
U+0000–U+001F, and no escaping of any other character (non-ASCII,
including U+007F, is written directly as UTF-8). A string that is not
well-formed Unicode (contains a lone surrogate) has no canonical
serialization: serializing it is a *canonicalization error*.

### 5.4 Numbers

- An **integer** serializes as its exact decimal digits with a leading
  `-` if negative, at any magnitude. There is exactly one form: the
  integer 0 serializes as `0` (the token `-0` parses to it). *(This rule
  is this specification's own; it extends RFC 8785, which is limited to
  float64.)*
- A **float64** serializes per RFC 8785 §3.2.2.3, i.e. ECMAScript
  `Number::toString`: shortest round-trip digits; no decimal point for
  integral values (`1.0` → `1`); negative zero → `0`; fixed notation for
  magnitudes in `[1e-6, 1e21)`, otherwise exponential with an explicit
  mantissa sign convention of ECMAScript (`1e+21`, `1e-7` — exponent
  unpadded, `+` only for non-negative exponents ≥ 21).
- Serializing a non-finite float64 is a *canonicalization error*.

Implementers MUST use a proven shortest-round-trip implementation of
ECMAScript `Number::toString` (for example Ryu with the ECMAScript notation
thresholds). Formatting with a fixed number of significant or fractional
digits, or printing the exact integer represented by an integral binary64,
is not conforming. Required boundary and rounding vectors are:

| binary64 value | canonical text |
|---|---|
| `-0.0` | `0` |
| `1.0` | `1` |
| `1e-6` | `0.000001` |
| `1e-7` | `1e-7` |
| `1e20` | `100000000000000000000` |
| `1e21` | `1e+21` |
| `5e-324` | `5e-324` |
| binary64 `-0x1.17664b157641dp+59` | `-629151929367400100` |

The last value is the binary64 number commonly displayed as
`-6.291519293674001e17`; its exact integer value is
`-629151929367400064`, but that longer decimal is **not** the ECMAScript
shortest representation.

When a host already exposes correctly rounded shortest-round-trip digits
(for example modern Python's `repr(float)`), an implementation may split
that shortest mantissa and exponent and move the decimal point to meet the
fixed/exponential thresholds above. It MUST preserve those digits while
doing so. It MUST NOT switch to a fixed-precision formatter such as `.15f`:
that asks a different rounding question and produces the exact wrong result
for vectors such as the last row.

### 5.5 Properties (non-normative)

`serialize ∘ parse` is the identity on canonical text, and
`parse ∘ serialize` is the identity on the data model. Note that the
integer 1 and the float64 1.0 both serialize as `1`; the distinction is
not recoverable from canonical text, which is harmless here because every
consumer of these values (Zarr metadata semantics, the `json` codec's
dtype-driven decoding) interprets numbers by context, not token sort.

## 6. Strict parsing

*Strict-parse* is a JSON-text parser and may return **any** JSON value. It is
not the same operation as reading a zarr-json document: reading a document
first strict-parses the text and then requires the result to be an object,
while embedded parses accept the value type their caller requires (an object
for metadata bytes, an array for the byte-key inlining check, and any
shape-appropriate JSON value for chunk bytes).

Reading a document, and every embedded parse this specification calls for
(metadata bytes in §7.2, chunk bytes in §9.2), MUST use the following
strict-parse discipline:

- everything RFC 8259 rejects is rejected — in particular the non-JSON
  tokens `NaN`, `Infinity`, `-Infinity`;
- a non-integer number token whose value overflows float64 (e.g. `1e999`)
  is rejected;
- integer-literal tokens are preserved exactly at any magnitude (§5.1);
- an object with duplicate member names parses to a single member per
  name: the **last** value in text order, at the position of the **first**
  occurrence. (Writers never emit duplicates: canonical serialization is
  defined over the data model, which cannot hold them.)

Implementations whose host JSON parser cannot meet these requirements
(e.g. cannot preserve big integers or detect overflow) MUST use a
conforming parser instead.

A document whose text is not strict-parseable, or whose top-level value
is not a JSON object, is a *document error* in both validation modes. A
document SHOULD NOT begin with a byte-order mark; readers MAY reject one.

## 7. Byte semantics

### 7.1 Decoding (document value → bytes)

- metadata key → the canonical serialization (§5) of its object, as UTF-8.
- byte key, string value → the base64-decoded bytes (§4.1).
- byte key, array or object value → its canonical serialization, as
  UTF-8.

Failures (bad base64, canonicalization errors) are *decode errors*,
scoped to the key (§8.3).

### 7.2 Encoding (bytes → document value)

Writers (e.g. a store's `set`) MUST proceed:

- metadata key: strict-parse the bytes; the result MUST be a JSON object;
  store it inline. Anything else is a *codec error*, and the document
  MUST be left unchanged.
- byte key: anything that losslessly round-trips as byte-stable
  (canonical) JSON of a self-describing type is written inline — if the
  bytes strict-parse to a JSON **array or object** whose canonical
  serialization is byte-identical to the input, store that value
  (*lossless inlining*); otherwise store the canonical base64 of the
  bytes. (A top-level string never inlines; see §4.2.)

In pseudocode, the byte-key branch is:

```text
parsed = try strict_parse_json(bytes)  # accepts any JSON top-level type
if parsed succeeded AND parsed is array or object
                    AND utf8(canonical_serialize(parsed)) == bytes:
    return parsed
return canonical_base64(bytes)
```

(The object-only top-level check of document reading does not apply here:
the inlining branch must accept arrays.)

The inlining rule is lossless by construction: whatever the bytes were,
decoding the stored value reproduces them exactly.

### 7.3 Normal form and equivalence

A document value is in *normal form* when it is what §7.2 would produce
for its decoded bytes; a document is in normal form when every value is.
Normal form constrains each value's content, not the document's
inter-member whitespace — a normal-form document may be pretty-printed.
Writers produce normal-form values (a consequence of §7.2); a write cycle
(`get` then `set`) normalizes a key.

Two documents are **equivalent** when they have the same key set, every
key decodes in both, and the decoded bytes agree per key. Equivalence,
not textual equality, is the round-trip guarantee. Documents with an
undecodable key have no equivalents.

## 8. Validity and errors

A document is **valid** when every key satisfies R1 (§3.1) and every
value satisfies R2 (§4). That is all: validity does not require a root
`zarr.json`, does not forbid orphan chunks, and does not check that the
document forms a coherent Zarr hierarchy — a Zarr store is valid while
empty or partially populated, so a document under construction is valid
throughout. The empty document `{}` is valid.

Validators SHOULD report at most one issue per key, checking R1 first and
reporting R2 only for keys that pass R1.

### 8.1 Modes

Implementations SHOULD offer a **strict** mode (any validity issue
rejects the document) and a **lenient** mode (issues are diagnostics;
offending entries are skipped and behave as absent, and all remaining
entries stay fully usable, including listing operations). Lenient is the
RECOMMENDED default for readers.

### 8.2 Store behavior

- `set` with a key violating R1 MUST be rejected without mutating the
  document, so a store driven through its API always produces a valid
  document. A failed `set` of any kind MUST leave the document unchanged.
- `get` of an absent key (including entries skipped in lenient mode)
  yields the host store interface's key-not-found condition.
- `delete` of any key, present or not, is permitted; deleting the last
  key leaves the valid empty document.
- Stores SHOULD offer a `set_json(key, value)` convenience defined as
  `set(key, canonical_serialization(value))`, restricted to the value type
  R2 permits at the key (object at metadata keys, array or object at
  byte keys).
  Because canonical bytes always satisfy the inlining check, the value is
  guaranteed to land in the document as its inline JSON representation —
  callers get the legible form without producing canonical text
  themselves.

For example, a lenient store constructed from
`{"bad/c/0":1,"ok/c/0":"AAEC"}` MUST report the R2 issue for
`bad/c/0`; `get("bad/c/0")` is not-found, `exists("bad/c/0")` is false,
and every listing omits it. The invalid entry may remain in the serialized
document. After `set("bad/c/0", b"[1,2]")`, it is live, decodes to those
five bytes, and its document value is the inline array `[1,2]`.

### 8.3 Error classes

| class | trigger | scope |
|---|---|---|
| document error | text not strict-parseable; top level not an object | whole document |
| validity issue | R1 or R2 violation | per key; document in strict mode |
| decode error | base64 grammar failure; canonicalization failure on read | per key |
| codec error | `json`-codec encode/decode failure (§9); metadata bytes not an object (§7.2) | per operation |

Decode errors are per-key: they MUST NOT affect access to other keys and
MUST NOT cause document rejection in either mode.

## 9. The `json` array→bytes codec

An array→bytes codec (Zarr v3 "serializer") whose metadata is exactly
`{"name": "json"}`; a `configuration` member MUST be absent or an empty
object, and readers SHOULD reject unrecognized configuration members.
Arrays encoded with it appear in the document as inline JSON arrays of
their decoded values.

*(Registration note: `json` is not yet a registered Zarr v3 extension
name; registration with the zarr-extensions registry is intended. Until
then, stock Zarr implementations without this codec cannot read such
arrays — though they can read the rest of the document.)*

### 9.1 Encoding

A chunk of rank ≥ 1 encodes as the canonical serialization (§5) of a
nested JSON array: the chunk's elements in C (row-major) order, nested by
the chunk shape, each element serialized with the **Zarr v3 `fill_value`
scalar convention** for the array's data type:

| data type family | element JSON |
|---|---|
| bool | `true` / `false` |
| integers (any width) | integer (exact digits) |
| floats | float64 per §5.4; non-finite as the strings `"NaN"`, `"Infinity"`, `"-Infinity"` |
| complex | two-element array `[re, im]`, each per the float rule |
| fixed-length bytes / raw | base64 string |
| strings | JSON string |

Encoders MUST NOT emit the bit-pattern hex-string float forms that Zarr
v3 permits for `fill_value` (e.g. `"0x7fc00000"`); decoder acceptance of
those forms is implementation-defined, so documents containing them are
not portable (§10). Lossiness is confined to float bit patterns: the sign
of negative zero is not preserved (§5.4), and NaN payload/signaling bits
are not preserved — decoders produce a quiet NaN.

Because every Zarr v3 data type must define a `fill_value` serialization
to be representable in metadata at all, this codec's encoding is defined
for every data type by construction; a given implementation supports the
data types its host Zarr library supports.

### 9.2 Decoding

Chunk bytes MUST be strict-parsed (§6). Decoding is then shape-driven:
recurse through the nested arrays exactly `rank` levels (a scalar's JSON
form may itself be an array — complex — so recursion depth comes from the
chunk shape, never from the values), and the nesting MUST match the chunk
shape exactly.

Element parsing MUST be strict, by the number sorts of §5.1:

- integer types: the element MUST be an integer within the type's range;
  a float64 element (e.g. the token `1.0`) is a codec error even when
  integral.
- float types: integer and float64 elements are both accepted (the
  integer converted to the nearest float64), plus the three non-finite
  strings.
- all types: out-of-range values and malformed scalars are codec errors,
  never coerced. For float types, *range* means the type's finite range: a
  finite JSON number whose conversion to the target type is not finite
  (e.g. `1e39` for `float32`, or an integer token beyond float64) is out of
  range; non-finite values are representable only through the three
  strings.

### 9.3 Composition and restrictions

- The `json` codec SHOULD be the only codec in the chain. `bytes→bytes`
  codecs after it (compression) produce opaque chunks, defeating the
  purpose; `array→array` codecs before it (e.g. `transpose`) are
  **implementation-defined** and currently not interoperable.
- The codec does not support partial (sub-chunk) decoding; combining it
  with sharding is legal per Zarr v3 but produces illegible shards and is
  NOT RECOMMENDED.
- A **rank-0** chunk encodes as its element's scalar JSON form alone
  (not nested). When that form is not an array or object (every family
  except complex), §7.2 stores the chunk base64-encoded; a rank-0 complex
  chunk's `[re, im]` form is itself an array and is inlined.

### 9.4 Conformance vectors

These vectors summarize §§9.1–9.2. A conforming codec MUST pass them.
“Values” are typed host-array values; “bytes” are the array→bytes codec
output before §7.2 decides whether to inline it.

| dtype | chunk shape | values | encoded bytes |
|---|---:|---|---|
| `bool` | `[2]` | `[true,false]` | `[true,false]` |
| `uint8` | `[2,2]` | `[[0,1],[254,255]]` | `[[0,1],[254,255]]` |
| `int64` | `[2]` | `[-9223372036854775808,9223372036854775807]` | same JSON text |
| `float64` | `[4]` | `[1.5, NaN, +Infinity, -Infinity]` | `[1.5,"NaN","Infinity","-Infinity"]` |
| `complex128` | `[1]` | `[1+2i]` | `[[1,2]]` |
| two-byte raw | `[2]` | `[0x6162,0x00ff]` | `["YWI=","AP8="]` |
| UTF-8 string | `[2]` | `["é","x"]` | `["é","x"]` |
| `int32` | `[]` | `7` | `7` |
| `complex128` | `[]` | `1+2i` | `[1,2]` |

A decoder smoke suite SHOULD separately reject `[1.0]`, `[true]`, and
`["1"]` for `int32`; `[1]` for `bool`; `["nan"]` for `float64`;
`[1e39]` for `float32`; `[[1e39,0]]` for `complex64`; and any nesting or
length that does not match the chunk shape. Encoding MUST perform the same
dtype scalar conversion as Zarr v3 `fill_value` serialization; merely
canonicalizing the host values without dtype-aware conversion is incorrect.

## 10. Portability

A *portable* document additionally satisfies (violations are
implementation-defined, not invalid):

- Nesting depth at most 100, counting one level per object or array
  opened within a single member value (the top-level document object and
  member names are not counted; the value of a key is depth ≥ 1).
- No lone surrogates in any string; no leading BOM.
- No hex-string float forms in chunk data (§9.1).
- Object member names within metadata SHOULD NOT be integer-like strings
  (`"0"`, `"42"`): JavaScript's native object semantics reorder such
  names, and an implementation built on them cannot preserve §5.2 member
  order for those documents. §5's determinism guarantee holds for
  portable documents.

Numbers carry no portability constraints: integers of any size and the
full float64 range round-trip exactly.

Interchange notes: the RECOMMENDED file extension is `.zarr.json`; where
a media type is needed, `application/zarr-json+json` is suggested. A
document does not self-identify — there is no version or magic member;
whether JSON text is a zarr-json document is established by context.
Filesystems that normalize Unicode filenames (e.g. APFS) can collide
distinct keys if a document is ever exploded into files; keys are
code-point-exact (§3.1).

## 11. Security considerations

Documents may come from untrusted sources. Implementations SHOULD bound
input size and parser recursion, and MUST NOT assume hierarchy coherence
(orphan keys, dangling metadata, and mismatched chunk shapes are all
representable). Decode and codec errors MUST surface as errors, never as
silently corrupted data. A zarr-json document contains no executable
content.

## 12. Conformance (non-normative)

Three reference implementations (Python/zarr-python,
TypeScript/zarrita — requires Node ≥ 21 for §6's integer preservation —
and Rust/zarrs) live in this repository, with shared fixtures in
`examples/` (verdicts in `MANIFEST.json`), a conformance-harness
protocol, a property-based cross-implementation test, an array-level
crosscheck matrix, and JSON operation traces that create arrays and write or
read regions across chunk boundaries; see [DESIGN.md](DESIGN.md) §6.

## 13. References

- Zarr v3 core specification (stores, keys, metadata, codecs, fill_value).
- RFC 8259 (JSON), RFC 4648 §§3.5, 4 (base64), RFC 8785 §3.2.2.3 (float64
  serialization), RFC 2119 (key words).
- ECMA-262, `Number::toString`.
- OME-NGFF 0.5 (the example in `examples/valid/ome_zarr_0.5_image.json`).
