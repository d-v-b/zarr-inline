//! Run every shared conformance fixture in ../examples (relative to this
//! crate) through the validator and require the manifest's verdict.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::Value;
use zarr_json::validate;

fn examples_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../examples")
}

#[test]
fn all_manifest_fixtures_get_expected_verdict() {
    let manifest_text =
        std::fs::read_to_string(examples_dir().join("MANIFEST.json")).expect("read MANIFEST.json");
    let manifest: BTreeMap<String, Value> =
        serde_json::from_str(&manifest_text).expect("parse MANIFEST.json");
    assert!(!manifest.is_empty(), "MANIFEST.json is empty");

    for (rel_path, expected) in &manifest {
        let text = std::fs::read_to_string(examples_dir().join(rel_path))
            .unwrap_or_else(|e| panic!("read {rel_path}: {e}"));
        let document: Value =
            serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {rel_path}: {e}"));
        let document = document
            .as_object()
            .unwrap_or_else(|| panic!("{rel_path} is not a JSON object"));

        let issues = validate(document);
        let valid = expected["valid"].as_bool().expect("manifest 'valid' is a bool");
        if valid {
            assert!(issues.is_empty(), "{rel_path} should be valid: {issues:?}");
        } else {
            assert!(!issues.is_empty(), "{rel_path} should be invalid");
            let rule = expected["rule"].as_str().expect("invalid fixture needs a rule");
            assert!(
                issues.iter().any(|i| i.rule == rule),
                "{rel_path} should fail rule {rule}, got {issues:?}"
            );
        }
    }
}
