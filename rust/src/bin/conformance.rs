//! Conformance harness: shared cross-implementation behavior as a CLI.
//!
//! Reads a zarr-json document (a JSON object) on stdin and writes a JSON
//! report on stdout:
//!
//! - `"issues"`: validator issues, sorted by (key, rule).
//! - `"decoded"`: for every issue-free key that decodes, base64 of the bytes
//!   decode_value returns (the bytes a Zarr library would see).
//! - `"reencoded"`: encode_value(key, decoded_bytes) for every decoded key.
//! - `"errors"`: sorted keys that passed validation but failed to decode
//!   (e.g. a byte key whose string value is not valid base64).
//!
//! The Python and TypeScript implementations ship the same harness; the
//! Python property test generates documents and requires the reports to
//! agree. See DESIGN.md section 6.1.
//!
//! This binary uses only the codec and validator modules, which are
//! independent of zarrs.

use std::collections::HashSet;
use std::io::Read;
use std::process::ExitCode;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde_json::{json, Map, Value};

use zarr_json::codec::{canonical_to_string, decode_value, encode_value};
use zarr_json::validator::validate;

fn run(document: &Map<String, Value>) -> Result<Value, String> {
    let mut issues = validate(document);
    issues.sort_by(|a, b| (&a.key, a.rule).cmp(&(&b.key, b.rule)));
    let issue_keys: HashSet<&str> = issues.iter().map(|i| i.key.as_str()).collect();

    let mut decoded = Map::new();
    let mut reencoded = Map::new();
    let mut errors: Vec<String> = Vec::new();
    for (key, value) in document {
        if issue_keys.contains(key.as_str()) {
            continue;
        }
        // A decode failure on one key must not abort the report.
        let Ok(data) = decode_value(key, value) else {
            errors.push(key.clone());
            continue;
        };
        decoded.insert(key.clone(), Value::String(STANDARD.encode(&data)));
        let revalue = encode_value(key, &data).map_err(|e| e.to_string())?;
        reencoded.insert(key.clone(), revalue);
    }
    errors.sort();

    let issues: Vec<Value> = issues
        .iter()
        .map(|i| json!({"rule": i.rule, "key": i.key}))
        .collect();
    let mut report = Map::new();
    report.insert("issues".to_string(), Value::Array(issues));
    report.insert("decoded".to_string(), Value::Object(decoded));
    report.insert("reencoded".to_string(), Value::Object(reencoded));
    report.insert(
        "errors".to_string(),
        Value::Array(errors.into_iter().map(Value::String).collect()),
    );
    Ok(Value::Object(report))
}

fn main() -> ExitCode {
    let mut input = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut input) {
        eprintln!("failed to read stdin: {e}");
        return ExitCode::from(1);
    }
    let parsed: Value = match zarr_json::strict_from_str(&input) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("input must be a JSON object: {e}");
            return ExitCode::from(1);
        }
    };
    let Value::Object(document) = parsed else {
        eprintln!("input must be a JSON object");
        return ExitCode::from(1);
    };
    match run(&document) {
        Ok(report) => {
            // Canonical output: compact, UTF-8 (non-ASCII unescaped),
            // numbers per RFC 8785 (ES Number::toString for floats).
            print!("{}", canonical_to_string(&report));
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("{e}");
            ExitCode::from(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_failure_lands_in_errors_without_aborting() {
        let document = serde_json::from_str::<Value>(
            r#"{"a/c/0": "not base64!", "b/c/0": "AAEC"}"#,
        )
        .unwrap();
        let report = run(document.as_object().unwrap()).unwrap();
        assert_eq!(
            report,
            serde_json::json!({
                "issues": [],
                "decoded": {"b/c/0": "AAEC"},
                "reencoded": {"b/c/0": "AAEC"},
                "errors": ["a/c/0"],
            })
        );
    }
}
