# Adversarial Review — Findings and Dispositions

**Date:** 2026-08-20
**Scope:** the value-typing design, the canonical serialization, the three
implementations, and the conformance protocol, as committed through
"feat: Rust implementation targeting zarrs". Method: spec-level attack
analysis (Python/maintainer side) plus independent adversarial reviews of
the TypeScript and Rust implementations, every finding verified by
reproduction against the running code.

## Design-level findings

1. **Parse-layer strictness was unspecified, and the three JSON parsers
   genuinely disagree.** Python's `json` accepts bare `NaN`/`Infinity`
   tokens and overflow literals like `1e999` (→ inf); JS accepts overflow
   but not the tokens; serde_json rejects both, plus documents nested
   deeper than 128 levels and (unlike Python) UTF-8 BOMs.
   *Disposition:* Python now rejects the tokens and overflow at every text
   boundary (`strict_loads`); the remaining differences are pinned as
   "Document constraints" in the conformance protocol — a portable
   document stays inside the bounds every parser handles identically.
2. **Number identity is weaker than JSON's grammar.** Integers beyond
   ±(2^53−1) silently lose precision in JS and fall to lossy float64 in
   serde_json outside `[i64::MIN, u64::MAX]`; the literal `-0` parses as
   int 0 (Python), float −0.0 (serde_json), and an unrepresentable
   distinction in JS; exponent text differs (`1e-07` vs `1e-7`); JS cannot
   distinguish `1.0` from `1`.
   *Disposition:* RFC 8785 (JCS) number formatting ADOPTED as the
   canonical form (ES `Number::toString` in all three implementations;
   member order still preserved, unlike full JCS). This closes the
   integral-float, exponent-style, and -0 divergences (at the cost of
   the -0.0 sign, which JCS serializes as `0`). TypeScript then adopted
   lossless BigInt parsing (JSON.parse reviver source access, Node >=
   21), eliminating the >= 2^53 integer corruption class; the residual
   constraint is integers outside [i64::MIN, u64::MAX] (serde_json).
3. **Lone surrogates are a three-way split** (serde_json rejects the
   document; Python parses but cannot UTF-8-encode; JS would happily
   escape them into bytes no other implementation can produce).
   *Disposition:* constraint documented; Python's harness now fails
   cleanly instead of emitting invalid UTF-8; TS canonicalization rejects
   ill-formed strings.
4. **The harness protocol had no story for decode failures on valid
   documents** (a byte key whose string is not base64): every harness
   crashed differently.
   *Disposition:* protocol extended with a sorted `"errors"` report field;
   a decode failure on one key must not abort the report; the property
   test now generates such documents.
5. **The document has a normal form, not a unique form.** A base64 string
   whose bytes are canonical-array text re-encodes as the inline array
   after any write cycle ("arrays win"). Two textually different documents
   can denote the same byte store; the conformance `reencoded` field is
   exactly this normalization. *Disposition:* working as designed; noted.
6. **NaN payload fidelity differs by implementation.** zarrs encodes
   non-default NaN bit patterns as bit-exact hex strings (the v3
   fill_value spec allows this); zarr-python collapses every NaN to
   `"NaN"`. Each side reads the other's form. *Disposition:* known
   zarr-python-side gap; portable payloads avoid non-default payloads.
7. **`json` composed with array->array codecs is not portable.**
   zarr-python/zarrs nest chunk JSON by the codec-resolved (e.g.
   transposed) shape; zarrita cannot, because it never exposes resolved
   metadata to codecs. *Disposition:* documented composition
   constraint — portable chains use `json` alone; cross-reads of
   transpose+json fail loudly, not silently.
8. **[RESOLVED] Stores accept keys their own validator rejects** (`""`, `"a/./b"`,
   `".."` pass zarrs/zarr-python key checks but are R1-invalid), so a
   store round-trip can produce a document that fails strict reload.
   Real Zarr libraries never emit such keys. *Disposition:* fixed —
   `set` now rejects R1-malformed keys in all three stores, per the
   Zarr v3 store-key grammar, so a store built through the API always
   produces a valid document.

## Implementation findings (fixed in place)

**TypeScript** — negative zero serialized as `0`, silently changing
decoded bytes (hit the shipped inline-chunk fixture); `store.set` of key
`__proto__` silently discarded (prototype-chain assignment); `encodeValue`
threw on opaque bytes that parse to non-finite JSON (e.g. `[1e400]`)
instead of falling back to base64; json-codec decode silently rounded
int64 values above 2^53 and coerced out-of-range/fractional ints;
`transpose`+`json` chains wrote memory-order (stride-ignoring) chunk JSON
unreadable by peers; harness sorted issues by UTF-16 code units rather
than code points. All fixed: hand-rolled canonical serializer (−0.0,
unsafe-int and ill-formed-string rejection), null-prototype documents,
strict scalar decoding, stride-aware encoding, code-point sorting,
`errors` field.

**Rust** — one R1-invalid key made the entire hierarchy unlistable in
lenient mode (spec says "skip the offending entry"); debug-build
arithmetic-overflow panics on out-of-range partial-read ranges; partial
writes were a non-atomic get-then-set across two lock acquisitions;
harness aborted the whole report on one key's decode failure. All fixed:
listing skips unlistable keys, checked range arithmetic, single-lock
read-modify-write, `errors` field.

**Python** — accepted bare `NaN` tokens and overflow literals at every
parse boundary (validator then passed the document, with errors deferred
to `get`-time); harness emitted invalid UTF-8 when a lone surrogate
appeared in a key. Fixed via `strict_loads` and hardened report encoding.

## What held up under attack

Base64 edge-case agreement (empty string, `AB==` trailing-bit leniency,
malformed padding); duplicate-key semantics (last value, first position);
R1/R2 precedence and one-issue-per-key; the async mutex and byte-range
handling (TS) and lock/erase/list semantics (Rust); serializer fill_value
conventions including f32 text (`0.10000000149011612` identical in all
three), complex pairs, rank-0, and edge chunks; malicious inline chunks
through zarrs (clean errors, no panics).
