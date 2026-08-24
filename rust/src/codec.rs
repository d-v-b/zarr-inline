//! Pure functions for classifying keys and encoding/decoding values.
//!
//! A zarr-inline value is one of:
//!
//! - metadata key (`zarr.json` or `*/zarr.json`) -> inline JSON object
//! - byte key -> base64 string (opaque bytes), or a JSON array/object (inline
//!   canonical JSON; arrays are produced by the `json` array->bytes codec)
//!
//! Inline arrays and objects use a canonical JSON serialization (no whitespace, no NaN /
//! Infinity tokens) so that parse -> re-serialize is byte-identical. That
//! makes the inlining rule in [`encode_value`] lossless by construction: a
//! byte value is inlined only if its bytes are exactly the canonical
//! serialization of a JSON array or object, so [`decode_value`] reproduces the original
//! bytes no matter what they actually were.

use base64::alphabet;
use base64::engine::general_purpose::GeneralPurposeConfig;
use base64::engine::{DecodePaddingMode, GeneralPurpose};
use base64::Engine as _;
use serde_json::Value;

/// The Zarr v3 metadata document name.
pub const METADATA_SUFFIX: &str = "zarr.json";

/// Strict standard-alphabet base64 with required canonical padding.
///
/// `decode_allow_trailing_bits(true)` mirrors Python's
/// `base64.b64decode(value, validate=True)`, which validates the alphabet and
/// padding but does not reject non-zero bits trailing the final symbol.
pub(crate) const BASE64_STANDARD_STRICT: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_allow_trailing_bits(true)
        .with_decode_padding_mode(DecodePaddingMode::RequireCanonical),
);

/// Error raised by [`decode_value`] / [`encode_value`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZarrJsonError(pub String);

impl std::fmt::Display for ZarrJsonError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ZarrJsonError {}

/// Return true if the key names a Zarr v3 metadata document.
///
/// Whole-segment matching: `zarr.json` or `*/zarr.json`. A key such as
/// `xyzarr.json` is NOT a metadata key.
pub fn is_metadata_key(key: &str) -> bool {
    key == METADATA_SUFFIX || key.ends_with("/zarr.json")
}

/// Format a finite float per ECMAScript `Number::toString`, as required by
/// RFC 8785 (JCS) section 3.2.2.3. This is what makes canonical number text
/// identical across Python, JavaScript, and Rust: integral floats print
/// without a decimal point (`1.0` -> `"1"`), negative zero prints `"0"`, and
/// exponents are unpadded (`"1e-7"`, not `"1e-07"`), switching to exponential
/// form only outside [1e-6, 1e21).
///
/// # Panics
/// Panics if `value` is NaN or infinite: canonical JSON cannot represent
/// non-finite numbers (and `serde_json::Number` can never hold one).
#[must_use]
pub fn es_number_str(value: f64) -> String {
    assert!(
        value.is_finite(),
        "canonical JSON cannot represent non-finite numbers"
    );
    if value == 0.0 {
        // Covers -0.0 too: ES ToString prints negative zero as "0".
        return "0".to_string();
    }
    if value < 0.0 {
        return format!("-{}", es_number_str(-value));
    }

    // Shortest round-trip digits from ryu (e.g. "1.5", "1e300", "5e-324"),
    // re-expressed as significant digits d1..dk and an exponent n with
    // value = 0.d1..dk * 10^n.
    let mut buffer = ryu::Buffer::new();
    let shortest = buffer.format_finite(value);
    let (mantissa, exp_part) = match shortest.split_once(['e', 'E']) {
        Some((mantissa, exp)) => (mantissa, exp.parse::<i32>().expect("ryu exponent")),
        None => (shortest, 0),
    };
    let (int_part, frac_part) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let mut exp = exp_part - i32::try_from(frac_part.len()).expect("ryu digit count");
    let mut digits: Vec<u8> = int_part.bytes().chain(frac_part.bytes()).collect();
    while digits.last() == Some(&b'0') {
        digits.pop();
        exp += 1;
    }
    let leading_zeros = digits.iter().take_while(|&&d| d == b'0').count();
    digits.drain(..leading_zeros);
    let digits = String::from_utf8(digits).expect("ASCII digits");
    let k = i32::try_from(digits.len()).expect("ryu digit count");
    let n = exp + k;

    // ECMA-262 Number::toString(10) for a positive finite value.
    if k <= n && n <= 21 {
        return format!("{digits}{}", "0".repeat((n - k) as usize));
    }
    if 0 < n && n <= 21 {
        let (int_digits, frac_digits) = digits.split_at(n as usize);
        return format!("{int_digits}.{frac_digits}");
    }
    if -6 < n && n <= 0 {
        return format!("0.{}{digits}", "0".repeat((-n) as usize));
    }
    let mantissa = if digits.len() > 1 {
        format!("{}.{}", &digits[..1], &digits[1..])
    } else {
        digits
    };
    let e = n - 1;
    format!("{mantissa}e{}{}", if e >= 0 { '+' } else { '-' }, e.abs())
}

/// True for a JSON integer literal: `-?[0-9]+` (no fraction, no exponent).
fn is_integer_literal(text: &str) -> bool {
    let digits = text.strip_prefix('-').unwrap_or(text);
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

/// serde_json `Formatter` for the canonical zarr-inline form: compact output
/// with numbers per RFC 8785. With `arbitrary_precision`, every
/// `serde_json::Number` carries its raw token text and serializes through
/// `write_number_str`: integer literals pass through as exact digits at any
/// size (`-0` normalized to `0`, the one non-canonical integer token JSON's
/// grammar admits), and everything else re-formats through
/// [`es_number_str`] (so a document's `1.0` canonicalizes to `1`, like
/// Python and JavaScript). Number tokens that overflow float64 (e.g.
/// `1e999`) are an error here; [`strict_from_str`] rejects them at parse
/// time so canonical serialization of a strictly-parsed value cannot fail.
struct CanonicalFormatter;

fn write_canonical_number<W>(writer: &mut W, value: &str) -> std::io::Result<()>
where
    W: ?Sized + std::io::Write,
{
    if is_integer_literal(value) {
        let text = if value == "-0" { "0" } else { value };
        return writer.write_all(text.as_bytes());
    }
    let parsed: f64 = value.parse().map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("invalid JSON number token {value:?}"),
        )
    })?;
    if !parsed.is_finite() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("number literal {value} overflows float64"),
        ));
    }
    writer.write_all(es_number_str(parsed).as_bytes())
}

impl serde_json::ser::Formatter for CanonicalFormatter {
    fn write_number_str<W>(&mut self, writer: &mut W, value: &str) -> std::io::Result<()>
    where
        W: ?Sized + std::io::Write,
    {
        write_canonical_number(writer, value)
    }

    fn write_f64<W>(&mut self, writer: &mut W, value: f64) -> std::io::Result<()>
    where
        W: ?Sized + std::io::Write,
    {
        // Unreachable with arbitrary_precision (numbers go through
        // write_number_str), but kept for defense in depth.
        if !value.is_finite() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "canonical JSON cannot represent non-finite numbers",
            ));
        }
        writer.write_all(es_number_str(value).as_bytes())
    }
}

/// Reject numbers no other implementation can represent: tokens that are
/// not integer literals and overflow float64 (e.g. `1e999`). Python's
/// strict_loads rejects these at parse time; with `arbitrary_precision`
/// serde_json accepts any number token, so the check runs as a post-parse
/// walk. Integer literals are exact at any size in all implementations
/// (Python natively, TypeScript via BigInt, Rust via the raw token).
fn check_numbers(value: &Value) -> Result<(), ZarrJsonError> {
    match value {
        Value::Number(n) => {
            let text = n.to_string();
            if !is_integer_literal(&text) {
                let parsed: f64 = text.parse().map_err(|_| {
                    ZarrJsonError(format!("invalid JSON number token {text:?}"))
                })?;
                if !parsed.is_finite() {
                    return Err(ZarrJsonError(format!(
                        "number literal {text} overflows float64"
                    )));
                }
            }
            Ok(())
        }
        Value::Array(items) => items.iter().try_for_each(check_numbers),
        Value::Object(members) => members.values().try_for_each(check_numbers),
        _ => Ok(()),
    }
}

/// Parse JSON like Python's `strict_loads`: NaN/Infinity tokens are
/// rejected by serde_json's grammar, and number literals that overflow
/// float64 are rejected by [`check_numbers`].
pub fn strict_from_str(text: &str) -> Result<Value, ZarrJsonError> {
    strict_from_slice(text.as_bytes())
}

/// Byte-slice form of [`strict_from_str`].
pub fn strict_from_slice(data: &[u8]) -> Result<Value, ZarrJsonError> {
    let parsed: Value = serde_json::from_slice(data)
        .map_err(|e| ZarrJsonError(format!("invalid JSON: {e}")))?;
    check_numbers(&parsed)?;
    Ok(parsed)
}

/// Serialize a JSON value in the canonical zarr-inline form.
///
/// No whitespace (`,` / `:` separators); non-ASCII characters unescaped
/// (UTF-8 output); object member order preserved as given (member names are
/// NOT sorted — this deliberately departs from full RFC 8785; the
/// `preserve_order` feature makes `serde_json::Map` order-preserving).
/// Numbers per RFC 8785 (JCS) section 3.2.2.3: floats via ECMAScript
/// `Number::toString` ([`es_number_str`]), integers as exact digits.
/// NaN / Infinity tokens cannot occur: `serde_json::Number` can never hold a
/// non-finite value (`Number::from_f64` returns `None` for them), so
/// rejection of non-finite numbers is inherent — the fill_value convention
/// represents them as strings like `"NaN"` instead. This form is shared by
/// all zarr-inline implementations so that decoded bytes agree byte-for-byte
/// across languages.
pub fn canonical_to_string(value: &Value) -> String {
    use serde::Serialize as _;

    let mut out = Vec::new();
    let mut serializer = serde_json::Serializer::with_formatter(&mut out, CanonicalFormatter);
    value
        .serialize(&mut serializer)
        .expect("JSON value serialization cannot fail");
    String::from_utf8(out).expect("canonical JSON is UTF-8")
}

/// Convert a stored zarr-inline value into the bytes Zarr expects.
///
/// Metadata keys hold a JSON object -> serialize to UTF-8 JSON bytes.
/// Byte keys hold a base64 string -> base64-decode to raw bytes, or a JSON
/// array/object -> canonical-serialize to UTF-8 JSON bytes.
pub fn decode_value(key: &str, value: &Value) -> Result<Vec<u8>, ZarrJsonError> {
    if is_metadata_key(key) {
        if !value.is_object() {
            return Err(ZarrJsonError(format!(
                "metadata key {key:?} must map to a JSON object"
            )));
        }
        return Ok(canonical_to_string(value).into_bytes());
    }
    match value {
        Value::Array(_) | Value::Object(_) => Ok(canonical_to_string(value).into_bytes()),
        Value::String(s) => BASE64_STANDARD_STRICT
            .decode(s)
            .map_err(|e| ZarrJsonError(format!("invalid base64 for byte key {key:?}: {e}"))),
        _ => Err(ZarrJsonError(format!(
            "byte key {key:?} must map to a base64 string or a JSON array or object"
        ))),
    }
}

/// Convert Zarr's bytes into the value stored in a zarr-inline document.
///
/// Metadata keys: parse bytes as JSON, require a JSON object.
/// Byte keys: inline as a JSON array if the bytes are exactly the canonical
/// serialization of one (lossless by construction); otherwise base64-encode.
pub fn encode_value(key: &str, data: &[u8]) -> Result<Value, ZarrJsonError> {
    if is_metadata_key(key) {
        let parsed: Value = strict_from_slice(data).map_err(|e| {
            ZarrJsonError(format!("metadata key {key:?} bytes are not JSON: {e}"))
        })?;
        if !parsed.is_object() {
            return Err(ZarrJsonError(format!(
                "metadata key {key:?} requires a JSON object value"
            )));
        }
        return Ok(parsed);
    }
    if let Some(inlined) = try_inline_json(data) {
        return Ok(inlined);
    }
    Ok(Value::String(BASE64_STANDARD_STRICT.encode(data)))
}

/// Return the parsed JSON array if inlining `data` is lossless, else None.
/// Anything that losslessly round-trips as byte-stable (canonical) JSON of
/// a self-describing type — array or object — is written inline; a
/// top-level JSON *string* can never be inlined (the string type is the
/// base64 channel, which keeps values decodable).
fn try_inline_json(data: &[u8]) -> Option<Value> {
    // Not JSON, not UTF-8, NaN/Infinity tokens, or float64 overflow ->
    // parse error -> base64 fallback.
    let parsed: Value = strict_from_slice(data).ok()?;
    if (parsed.is_array() || parsed.is_object())
        && canonical_to_string(&parsed).as_bytes() == data
    {
        Some(parsed)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn key_classification() {
        // Reasonable combinations of inputs and their expected classification.
        for (key, expected) in [
            ("zarr.json", true),
            ("group/zarr.json", true),
            ("a/b/zarr.json", true),
            ("xyzarr.json", false), // whole-segment matching, not a suffix match
            ("a/xyzarr.json", false),
            ("zarr.json/c/0", false),
            ("c/0/0", false),
            ("", false),
        ] {
            assert_eq!(is_metadata_key(key), expected, "key: {key:?}");
        }
    }

    #[test]
    fn canonical_serialization() {
        assert_eq!(
            canonical_to_string(&json!({"a": 1, "b": [1.5, "NaN"]})),
            r#"{"a":1,"b":[1.5,"NaN"]}"#
        );
        // Non-ASCII characters are not escaped.
        assert_eq!(canonical_to_string(&json!({"k": "héllo"})), "{\"k\":\"héllo\"}");
        // Object member order is preserved, not sorted.
        let v: Value = serde_json::from_str(r#"{"b":1,"a":2}"#).unwrap();
        assert_eq!(canonical_to_string(&v), r#"{"b":1,"a":2}"#);
        // Floats use ECMAScript Number::toString (RFC 8785): integral floats
        // lose the decimal point, -0.0 loses its sign, exponents are unpadded.
        assert_eq!(
            canonical_to_string(&json!([1.0, -0.0, 1e-7, 100.0, -2.75])),
            "[1,0,1e-7,100,-2.75]"
        );
        // Integers keep exact digit output, identical to the ES float form
        // for every safe integer.
        assert_eq!(
            canonical_to_string(&json!([0, -5, 9007199254740991i64])),
            "[0,-5,9007199254740991]"
        );
    }

    #[test]
    fn integers_of_any_size_round_trip_exactly() {
        for text in [
            "18446744073709551616",                      // u64::MAX + 1
            "-9223372036854775809",                      // i64::MIN - 1
            "1000000000000000000000000000000",           // 10^30
            "-123456789012345678901234567890123456789",  // way past f64
        ] {
            let doc = format!("[{text}]");
            let parsed = strict_from_str(&doc).unwrap();
            assert_eq!(canonical_to_string(&parsed), doc, "token {text}");
        }
    }

    #[test]
    fn canonical_normalizes_number_tokens() {
        // -0 integer literal -> "0" (matching Python's int 0); float tokens
        // re-format per ES ToString ("1.0" -> "1", padded exponents unpadded).
        for (doc, want) in [
            ("[-0]", "[0]"),
            ("[1.0]", "[1]"),
            ("[1e-07]", "[1e-7]"),
            ("[100.0]", "[100]"),
            ("[-0.0]", "[0]"),
        ] {
            let parsed = strict_from_str(doc).unwrap();
            assert_eq!(canonical_to_string(&parsed), want, "doc {doc}");
        }
    }

    #[test]
    fn strict_parse_rejects_float64_overflow() {
        let err = strict_from_str("[1e999]").unwrap_err();
        assert!(err.to_string().contains("overflows float64"), "{err}");
    }

    #[test]
    fn big_integer_arrays_inline_losslessly() {
        let data = b"[18446744073709551616,9007199254740993]";
        let value = encode_value("a/c/0", data).unwrap();
        assert!(value.is_array(), "should inline, got {value:?}");
        assert_eq!(decode_value("a/c/0", &value).unwrap(), data);
    }

    #[test]
    #[allow(clippy::approx_constant)] // the spec vector is the literal digits, not PI
    fn es_number_str_mandatory_vectors() {
        for (value, expected) in [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-1.0, "-1"),
            (1.5, "1.5"),
            (100.0, "100"),
            (0.1, "0.1"),
            (1e16, "10000000000000000"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (1e-6, "0.000001"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (3.141592653589793, "3.141592653589793"),
            (0.10000000149011612, "0.10000000149011612"),
            (1e300, "1e+300"),
            (-2.75, "-2.75"),
            (123.456, "123.456"),
        ] {
            assert_eq!(es_number_str(value), expected, "value: {value:e}");
        }
    }

    #[test]
    #[should_panic(expected = "non-finite")]
    fn es_number_str_rejects_non_finite() {
        let _ = es_number_str(f64::NAN);
    }

    #[test]
    fn decode_value_expected_outputs() {
        // Metadata key -> canonical UTF-8 bytes of the object.
        assert_eq!(
            decode_value("zarr.json", &json!({"a": 1})).unwrap(),
            b"{\"a\":1}".to_vec()
        );
        // Byte key with array value -> canonical UTF-8 bytes.
        assert_eq!(decode_value("x/c/0", &json!([1, 2])).unwrap(), b"[1,2]".to_vec());
        // Byte key with base64 string -> decoded bytes.
        assert_eq!(
            decode_value("x/c/0", &json!("AAEC")).unwrap(),
            vec![0u8, 1, 2]
        );
    }

    #[test]
    fn decode_value_metadata_key_requires_object() {
        assert!(decode_value("zarr.json", &json!("string")).is_err());
        assert!(decode_value("zarr.json", &json!([1, 2])).is_err());
    }

    #[test]
    fn decode_value_byte_key_rejects_scalar_types() {
        assert!(decode_value("x/c/0", &json!(3)).is_err());
        assert!(decode_value("x/c/0", &json!(null)).is_err());
        assert!(decode_value("x/c/0", &json!(true)).is_err());
    }

    #[test]
    fn decode_value_byte_key_serializes_inline_objects_canonically() {
        assert_eq!(
            decode_value("x/c/0", &json!({"a": 1, "b": [2.5, "x"]})).unwrap(),
            br#"{"a":1,"b":[2.5,"x"]}"#.to_vec()
        );
    }

    #[test]
    fn decode_value_rejects_invalid_base64() {
        // Bad alphabet.
        assert!(decode_value("x/c/0", &json!("not base64!")).is_err());
        // Missing padding (strict decode requires it).
        assert!(decode_value("x/c/0", &json!("AAE")).is_err());
    }

    #[test]
    fn encode_value_expected_outputs() {
        // Metadata key -> parsed object.
        assert_eq!(
            encode_value("zarr.json", b"{\"a\": 1}").unwrap(),
            json!({"a": 1})
        );
        // Canonical JSON array bytes are inlined losslessly.
        assert_eq!(encode_value("x/c/0", b"[1,2]").unwrap(), json!([1, 2]));
        assert_eq!(
            encode_value("x/c/0", b"[[1.5,\"NaN\"],[0.5,3]]").unwrap(),
            serde_json::from_str::<Value>("[[1.5,\"NaN\"],[0.5,3]]").unwrap()
        );
        // "-0.0" is not canonical number text (ES ToString prints "0"), so
        // bytes containing it are stored as base64, not inlined.
        let v = encode_value("x/c/0", b"[-0.0]").unwrap();
        assert!(v.is_string());
        assert_eq!(decode_value("x/c/0", &v).unwrap(), b"[-0.0]".to_vec());
        // Opaque bytes -> padded standard base64.
        assert_eq!(encode_value("x/c/0", &[0, 1, 2]).unwrap(), json!("AAEC"));
    }

    #[test]
    fn encode_value_non_canonical_array_bytes_stay_base64() {
        // b"[1, 2]" parses as an array but is not the canonical serialization.
        let v = encode_value("x/c/0", b"[1, 2]").unwrap();
        assert_eq!(v, json!("WzEsIDJd"));
        // Round trip is byte-identical.
        assert_eq!(decode_value("x/c/0", &v).unwrap(), b"[1, 2]".to_vec());
    }

    #[test]
    fn encode_value_nan_token_bytes_stay_base64() {
        // b"[NaN]" is not JSON; it must not be inlined.
        let v = encode_value("x/c/0", b"[NaN]").unwrap();
        assert!(v.is_string());
        assert_eq!(decode_value("x/c/0", &v).unwrap(), b"[NaN]".to_vec());
    }

    #[test]
    fn encode_value_inlines_canonical_objects_never_strings() {
        // Byte-stable canonical objects inline.
        let v = encode_value("x/c/0", b"{\"a\":1}").unwrap();
        assert_eq!(v, json!({"a": 1}));
        // Non-canonical object bytes stay base64.
        let v = encode_value("x/c/0", b"{\"a\": 1}").unwrap();
        assert!(v.is_string());
        assert_eq!(decode_value("x/c/0", &v).unwrap(), b"{\"a\": 1}".to_vec());
        // A canonical top-level string is still bytes (the base64 channel).
        let v = encode_value("x/c/0", b"\"hi\"").unwrap();
        assert!(v.is_string());
        assert_eq!(decode_value("x/c/0", &v).unwrap(), b"\"hi\"".to_vec());
    }

    #[test]
    fn encode_value_metadata_key_requires_object_bytes() {
        assert!(encode_value("zarr.json", b"[1,2]").is_err());
        assert!(encode_value("zarr.json", b"not json").is_err());
    }

    #[test]
    fn xyzarr_inline_is_a_byte_key() {
        // Confirms end-to-end that xyzarr.json follows byte-key semantics.
        assert_eq!(encode_value("xyzarr.json", &[0, 1, 2]).unwrap(), json!("AAEC"));
    }
}
