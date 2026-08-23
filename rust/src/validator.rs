//! Validate a zarr-json document against the two validity rules.
//!
//! R1 — well-formed keys: every key is a non-empty string with no leading or
//!      trailing `/`, no empty segments, and no `.` or `..` segments.
//! R2 — per-value type: metadata keys map to a JSON object; byte keys map to
//!      a base64 string or an inline JSON array or object.
//!
//! At most one issue is reported per key; R1 takes precedence (the value-type
//! check on a malformed key is not meaningful).

use serde_json::{Map, Value};

use crate::codec::is_metadata_key;

/// A single validity violation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationIssue {
    /// The rule violated: `"R1"` or `"R2"`.
    pub rule: &'static str,
    /// The offending document key.
    pub key: String,
    /// Human-readable description.
    pub message: String,
}

/// Error carrying the issues of an invalid document (strict validation).
#[derive(Debug, Clone)]
pub struct ValidationError {
    /// All issues found in the document.
    pub issues: Vec<ValidationIssue>,
}

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let joined = self
            .issues
            .iter()
            .map(|i| format!("[{}] {}: {}", i.rule, i.key, i.message))
            .collect::<Vec<_>>()
            .join("; ");
        write!(f, "invalid zarr-json document: {joined}")
    }
}

impl std::error::Error for ValidationError {}

fn check_key_well_formed(key: &str) -> Option<ValidationIssue> {
    let issue = |message: &str| {
        Some(ValidationIssue {
            rule: "R1",
            key: key.to_string(),
            message: message.to_string(),
        })
    };
    if key.is_empty() {
        return issue("key must be a non-empty string");
    }
    if key.starts_with('/') || key.ends_with('/') {
        return issue("key must not have a leading or trailing '/'");
    }
    for segment in key.split('/') {
        if segment.is_empty() {
            return issue("key must not have empty segments");
        }
        if segment == "." || segment == ".." {
            return issue("key must not have '.' or '..' segments");
        }
    }
    None
}

fn check_value_type(key: &str, value: &Value) -> Option<ValidationIssue> {
    if is_metadata_key(key) {
        if !value.is_object() {
            return Some(ValidationIssue {
                rule: "R2",
                key: key.to_string(),
                message: "metadata key must map to a JSON object".to_string(),
            });
        }
    } else if !value.is_string() && !value.is_array() && !value.is_object() {
        return Some(ValidationIssue {
            rule: "R2",
            key: key.to_string(),
            message: "byte key must map to a base64 string or a JSON array or object".to_string(),
        });
    }
    None
}

/// Check a single key against R1 (well-formedness). Returns the issue, or
/// None if the key is well-formed. Used by the store to reject writes to
/// keys that would make the document invalid.
#[must_use]
pub fn check_key(key: &str) -> Option<ValidationIssue> {
    check_key_well_formed(key)
}

/// Check a zarr-json document. Returns the list of issues (empty if valid),
/// in document order.
pub fn validate(document: &Map<String, Value>) -> Vec<ValidationIssue> {
    let mut issues = Vec::new();
    for (key, value) in document {
        if let Some(issue) = check_key_well_formed(key) {
            issues.push(issue);
            continue; // R1 takes precedence; skip the value-type check
        }
        if let Some(issue) = check_value_type(key, value) {
            issues.push(issue);
        }
    }
    issues
}

/// Check a zarr-json document, failing on the first problem (strict mode).
///
/// # Errors
/// Returns [`ValidationError`] carrying every issue if the document is invalid.
pub fn validate_strict(document: &Map<String, Value>) -> Result<(), ValidationError> {
    let issues = validate(document);
    if issues.is_empty() {
        Ok(())
    } else {
        Err(ValidationError { issues })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn doc(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn valid_documents_produce_no_issues() {
        // Reasonable valid documents across both rules.
        for value in [
            json!({}),
            json!({"zarr.json": {"zarr_format": 3, "node_type": "group"}}),
            json!({"zarr.json": {}, "a/zarr.json": {}, "a/c/0": "AAEC"}),
            json!({"a/c/0/0": [1, 2, 3]}), // inline JSON array at a byte key
            json!({"xyzarr.json": "AAEC"}), // byte key despite the suffix-like name
        ] {
            assert_eq!(validate(&doc(value)), vec![]);
        }
    }

    #[test]
    fn metadata_key_with_non_object_value_reports_r2() {
        let issues = validate(&doc(json!({"zarr.json": "not an object"})));
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].rule, "R2");
        assert_eq!(issues[0].key, "zarr.json");
    }

    #[test]
    fn byte_key_with_invalid_value_reports_r2() {
        for value in [json!({"a/c/0": 3}), json!({"a/c/0": true}), json!({"a/c/0": null})] {
            let issues = validate(&doc(value));
            assert_eq!(issues.len(), 1);
            assert_eq!(issues[0].rule, "R2");
        }
    }

    #[test]
    fn byte_key_with_inline_object_is_valid() {
        assert!(validate(&doc(json!({"a/c/0": {"an": "inline object"}}))).is_empty());
    }

    #[test]
    fn malformed_keys_report_r1() {
        for value in [
            json!({"": "x"}),
            json!({"/zarr.json": {}}),
            json!({"a/zarr.json/": {}}),
            json!({"a//zarr.json": {}}),
            json!({"a/./zarr.json": {}}),
            json!({"a/../b": "x"}),
            json!({"..": "x"}),
        ] {
            let issues = validate(&doc(value.clone()));
            assert_eq!(issues.len(), 1, "value: {value}");
            assert_eq!(issues[0].rule, "R1");
        }
    }

    #[test]
    fn r1_takes_precedence_over_r2() {
        // "/zarr.json" is a malformed metadata key with a non-object value:
        // only the R1 issue is reported.
        let issues = validate(&doc(json!({"/zarr.json": "x"})));
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].rule, "R1");
    }

    #[test]
    fn multiple_bad_keys_accumulate_issues() {
        let issues = validate(&doc(json!({"/leading": "x", "trailing/": "y"})));
        assert_eq!(issues.len(), 2);
    }

    #[test]
    fn strict_mode_errors_on_invalid_document() {
        assert!(validate_strict(&doc(json!({"zarr.json": "bad"}))).is_err());
        assert!(validate_strict(&doc(json!({"zarr.json": {}}))).is_ok());
    }
}
