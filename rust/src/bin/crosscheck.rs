//! Cross-language array crosscheck harness (zarrs side).
//!
//! See `DESIGN.md` section 6.2 (write/read) and 6.3 (trace). All conversions
//! between payload JSON and native arrays go through the json codec itself
//! ([`JsonCodec`] encode / decode), so what this harness accepts is
//! definitionally what the codec accepts: strict scalar sorts, finite ranges,
//! exact nesting. Harness-level rules (in-bounds regions, valid initial
//! documents, group-only parents, explicit zero fill) follow the trace input
//! contract in `DESIGN.md` section 6.3.
//!
//! Errors: message on stderr, exit code 1.

use std::borrow::Cow;
use std::io::Read as _;
use std::num::NonZeroU64;
use std::process::ExitCode;
use std::sync::Arc;

use serde_json::{Map, Value};
use zarrs::array::codec::api::{ArrayToBytesCodecTraits, CodecOptions};
use zarrs::array::{Array, ArrayBuilder, ArrayBytes, ArrayMetadata, ArraySubset, DataType, FillValue};
use zarrs::group::GroupBuilder;
use zarrs::metadata::v3::MetadataV3;
use zarrs::storage::ReadableWritableListableStorage;

use zarr_inline::{canonical_to_string, is_metadata_key, Document, JsonCodec, ZarrInlineStore};

const PORTABLE_DTYPES: &[&str] = &["bool", "uint8", "int32", "int64", "float32", "float64"];
const MAX_SAFE_DIMENSION: u64 = 9_007_199_254_740_991;

fn u64_list(value: &Value, what: &str, min_value: u64) -> Result<Vec<u64>, String> {
    let Value::Array(items) = value else {
        return Err(format!("{what} must be a list of integers >= {min_value}"));
    };
    items
        .iter()
        .map(|v| {
            v.as_u64()
                .filter(|n| (min_value..=MAX_SAFE_DIMENSION).contains(n))
                .ok_or_else(|| {
                    format!(
                        "{what} must be a list of integer tokens in [{min_value}, {MAX_SAFE_DIMENSION}]"
                    )
                })
        })
        .collect()
}

fn portable_path<'a>(value: &'a Value, what: &str) -> Result<&'a str, String> {
    let path = value
        .as_str()
        .filter(|path| !path.is_empty())
        .ok_or_else(|| format!("{what} must be a non-empty string"))?;
    if path.split('/').any(|segment| {
        segment.is_empty()
            || segment.starts_with("__")
            || segment.chars().all(|character| character == '.')
    }) {
        return Err(format!(
            "{what} must be a portable relative Zarr node path (no empty, reserved '__', or all-period segments)"
        ));
    }
    Ok(path)
}

fn portable_dtype<'a>(value: &'a Value, what: &str) -> Result<&'a str, String> {
    value
        .as_str()
        .filter(|dtype| PORTABLE_DTYPES.contains(dtype))
        .ok_or_else(|| format!("{what} must be one of: {}", PORTABLE_DTYPES.join(", ")))
}

fn nonzero_shape(shape: &[u64], what: &str) -> Result<Vec<NonZeroU64>, String> {
    shape
        .iter()
        .map(|d| NonZeroU64::new(*d).ok_or_else(|| format!("{what}: extents must be >= 1")))
        .collect()
}

/// Payload JSON -> native bytes, via the codec's decoder. The payload is
/// re-serialized SORT-PRESERVING (serde_json keeps the raw token `1.0`), not
/// canonically: canonicalization would launder the float token `1.0` into
/// the integer token `1` that the codec must reject for integer dtypes.
fn to_native<S: ?Sized>(array: &Array<S>, data: &Value, shape: &[u64]) -> Result<Vec<u8>, String> {
    let shape = nonzero_shape(shape, "region")?;
    let text = serde_json::to_string(data).map_err(|e| format!("cannot serialize payload: {e}"))?;
    let decoded = JsonCodec::new()
        .decode(
            Cow::Owned(text.into_bytes()),
            &shape,
            array.data_type(),
            array.fill_value(),
            &CodecOptions::default(),
        )
        .map_err(|e| format!("{e}"))?;
    decoded
        .into_fixed()
        .map(Cow::into_owned)
        .map_err(|e| format!("variable-length data unsupported: {e}"))
}

/// Native bytes -> payload JSON, via the codec's encoder.
fn to_json<S: ?Sized>(array: &Array<S>, bytes: ArrayBytes, shape: &[u64]) -> Result<Value, String> {
    let shape = nonzero_shape(shape, "region")?;
    let encoded = JsonCodec::new()
        .encode(bytes, &shape, array.data_type(), array.fill_value(), &CodecOptions::default())
        .map_err(|e| format!("{e}"))?;
    zarr_inline::strict_from_slice(&encoded).map_err(|e| format!("codec output is not JSON: {e}"))
}

/// The node_type of the metadata document at `key`, if present.
fn node_type(document: &Document, key: &str) -> Option<String> {
    let value = document.get(key)?;
    Some(
        value
            .get("node_type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    )
}

/// Create the root and every ancestor group of `path` that does not exist,
/// refusing (like zarr-python) to place a node beneath an array or to
/// overwrite an existing node.
fn ensure_parents(
    store: &Arc<ZarrInlineStore>,
    storage: &ReadableWritableListableStorage,
    path: &str,
) -> Result<(), String> {
    let document = store.document();
    let ensure_group = |key: String, node_path: String, label: String| -> Result<(), String> {
        match node_type(&document, &key) {
            Some(kind) if kind == "group" => Ok(()),
            Some(_) => Err(format!("cannot create {path}: {label} is not a group")),
            None => GroupBuilder::new()
                .build(storage.clone(), &node_path)
                .map_err(|e| format!("cannot create group {label}: {e}"))?
                .store_metadata()
                .map_err(|e| format!("cannot store group {label}: {e}")),
        }
    };
    ensure_group("zarr.json".to_string(), "/".to_string(), "the root".to_string())?;
    let segments: Vec<&str> = path.split('/').collect();
    for depth in 1..segments.len() {
        let ancestor = segments[..depth].join("/");
        ensure_group(
            format!("{ancestor}/zarr.json"),
            format!("/{ancestor}"),
            format!("parent {ancestor}"),
        )?;
    }
    if node_type(&document, &format!("{path}/zarr.json")).is_some() {
        return Err(format!("cannot create {path}: a node already exists there"));
    }
    Ok(())
}

fn create_array(
    store: &Arc<ZarrInlineStore>,
    storage: &ReadableWritableListableStorage,
    path: &str,
    dtype_name: &str,
    shape: Vec<u64>,
    chunks: Vec<u64>,
) -> Result<Array<dyn zarrs::storage::ReadableWritableListableStorageTraits>, String> {
    ensure_parents(store, storage, path)?;
    let data_type = DataType::from_metadata(&MetadataV3::new(dtype_name))
        .map_err(|e| format!("array {path}: unsupported dtype {dtype_name}: {e}"))?;
    let element_size = data_type
        .fixed_size()
        .ok_or_else(|| format!("array {path}: dtype {dtype_name} is not fixed-size"))?;
    // Explicit zero fill value (0 / false / 0.0) for every dtype.
    let array = ArrayBuilder::new(shape, chunks, data_type, FillValue::new(vec![0u8; element_size]))
        .array_to_bytes_codec(Arc::new(JsonCodec::new()))
        .build(storage.clone(), &format!("/{path}"))
        .map_err(|e| format!("array {path}: cannot create: {e}"))?;
    array
        .store_metadata()
        .map_err(|e| format!("array {path}: cannot store metadata: {e}"))?;
    Ok(array)
}

fn new_store(document: Option<&Value>) -> Result<Arc<ZarrInlineStore>, String> {
    // Maximally standard metadata: no zarrs-specific "_zarrs" attribute.
    zarrs::config::global_config_mut().set_include_zarrs_metadata(false);
    match document {
        None => Ok(Arc::new(ZarrInlineStore::new())),
        // The initial document MUST be valid (DESIGN 6.3).
        Some(Value::Object(document)) => ZarrInlineStore::from_document(document.clone())
            .map(Arc::new)
            .map_err(|e| format!("invalid initial document: {e}")),
        Some(_) => Err("trace document must be an object".to_string()),
    }
}

/// Write mode: payload in, zarr-inline document out.
fn write(payload: &Value) -> Result<String, String> {
    let specs = payload
        .get("arrays")
        .and_then(Value::as_array)
        .ok_or_else(|| "payload must be an object with an \"arrays\" array".to_string())?;
    let store = new_store(None)?;
    let storage: ReadableWritableListableStorage = store.clone();

    for spec in specs {
        let path = portable_path(spec.get("path").unwrap_or(&Value::Null), "array path")?;
        let dtype_name = portable_dtype(
            spec.get("dtype").unwrap_or(&Value::Null),
            &format!("array {path}: dtype"),
        )?;
        let shape = u64_list(spec.get("shape").unwrap_or(&Value::Null), &format!("array {path}: shape"), 0)?;
        let chunks = u64_list(spec.get("chunks").unwrap_or(&Value::Null), &format!("array {path}: chunks"), 1)?;
        let data = spec
            .get("data")
            .ok_or_else(|| format!("array {path}: missing \"data\""))?;
        let array = create_array(&store, &storage, path, dtype_name, shape.clone(), chunks)?;
        let bytes = to_native(&array, data, &shape).map_err(|e| format!("array {path}: {e}"))?;
        array
            .store_array_subset(&array.subset_all(), ArrayBytes::new_flen(bytes))
            .map_err(|e| format!("array {path}: cannot write data: {e}"))?;
    }
    Ok(store.to_json_string())
}

/// Read mode: zarr-inline document in, payload out.
fn read(document_value: &Value) -> Result<String, String> {
    let Value::Object(document) = document_value else {
        return Err("input must be a JSON object".to_string());
    };
    let mut paths: Vec<String> = document
        .iter()
        .filter(|(key, value)| {
            key.as_str() != "zarr.json"
                && is_metadata_key(key)
                && value.get("node_type").and_then(Value::as_str) == Some("array")
        })
        .filter_map(|(key, _)| key.strip_suffix("/zarr.json").map(str::to_string))
        .collect();
    paths.sort();
    let store = new_store(Some(document_value)).map_err(|e| e.replace("initial document", "document"))?;

    let mut arrays: Vec<Value> = Vec::new();
    for path in paths {
        let array = Array::open(store.clone(), &format!("/{path}"))
            .map_err(|e| format!("array {path}: cannot open: {e}"))?;
        let ArrayMetadata::V3(metadata) = array.metadata() else {
            return Err(format!("array {path}: not Zarr v3 metadata"));
        };
        let dtype_name = metadata.data_type.name().to_string();
        let shape: Vec<u64> = array.shape().to_vec();
        let chunk_shape: Vec<u64> = array
            .chunk_shape(&vec![0; shape.len()])
            .map_err(|e| format!("array {path}: cannot determine chunk shape: {e}"))?
            .iter()
            .map(|d| d.get())
            .collect();
        let bytes = array
            .retrieve_array_subset(&array.subset_all())
            .map_err(|e| format!("array {path}: cannot read data: {e}"))?;
        let data = to_json(&array, bytes, &shape).map_err(|e| format!("array {path}: {e}"))?;

        let mut entry = Map::new();
        entry.insert("path".to_string(), Value::String(path));
        entry.insert("dtype".to_string(), Value::String(dtype_name));
        entry.insert("shape".to_string(), Value::Array(shape.into_iter().map(Value::from).collect()));
        entry.insert("chunks".to_string(), Value::Array(chunk_shape.into_iter().map(Value::from).collect()));
        entry.insert("data".to_string(), data);
        arrays.push(Value::Object(entry));
    }
    let mut payload = Map::new();
    payload.insert("arrays".to_string(), Value::Array(arrays));
    Ok(canonical_to_string(&Value::Object(payload)))
}

/// Validate a region against the array (DESIGN 6.3): same rank, every
/// extent >= 1, and origin + shape within the array shape.
fn region<S: ?Sized>(operation: &Value, array: &Array<S>, index: usize) -> Result<ArraySubset, String> {
    let origin = u64_list(operation.get("origin").unwrap_or(&Value::Null), &format!("operation {index}: origin"), 0)?;
    let shape = u64_list(operation.get("shape").unwrap_or(&Value::Null), &format!("operation {index}: shape"), 1)?;
    let extents = array.shape();
    if origin.len() != extents.len() || shape.len() != extents.len() {
        return Err(format!("operation {index}: region dimensionality mismatch"));
    }
    for (axis, ((start, size), extent)) in origin.iter().zip(&shape).zip(extents).enumerate() {
        let end = start.checked_add(*size).ok_or_else(|| format!("operation {index}: region overflows"))?;
        if end > *extent {
            return Err(format!(
                "operation {index}: region [{start}, {end}) exceeds array extent {extent} on axis {axis}"
            ));
        }
    }
    ArraySubset::new_with_start_shape(origin, shape).map_err(|e| format!("operation {index}: invalid region: {e}"))
}

fn trace(payload: &Value) -> Result<String, String> {
    let operations = payload
        .get("operations")
        .and_then(Value::as_array)
        .ok_or_else(|| "trace payload needs an operations array".to_string())?;
    let store = new_store(payload.get("document"))?;
    let storage: ReadableWritableListableStorage = store.clone();
    let mut reads = Vec::new();

    for (index, operation) in operations.iter().enumerate() {
        let op = operation
            .get("op")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("operation {index}: missing op"))?;
        let path = portable_path(
            operation.get("path").unwrap_or(&Value::Null),
            &format!("operation {index}: path"),
        )?;
        match op {
            "create_array" => {
                let dtype_name = portable_dtype(
                    operation.get("dtype").unwrap_or(&Value::Null),
                    &format!("operation {index}: dtype"),
                )?;
                let shape = u64_list(operation.get("shape").unwrap_or(&Value::Null), &format!("operation {index}: shape"), 0)?;
                let chunks = u64_list(operation.get("chunks").unwrap_or(&Value::Null), &format!("operation {index}: chunks"), 1)?;
                create_array(&store, &storage, path, dtype_name, shape, chunks)
                    .map_err(|e| format!("operation {index}: {e}"))?;
            }
            "write_region" | "read_region" => {
                let array = Array::open(store.clone(), &format!("/{path}"))
                    .map_err(|e| format!("operation {index}: cannot open array {path}: {e}"))?;
                let subset = region(operation, &array, index)?;
                if op == "write_region" {
                    let data = operation
                        .get("data")
                        .ok_or_else(|| format!("operation {index}: write_region needs data"))?;
                    let bytes = to_native(&array, data, subset.shape()).map_err(|e| format!("operation {index}: {e}"))?;
                    array
                        .store_array_subset(&subset, ArrayBytes::new_flen(bytes))
                        .map_err(|e| format!("operation {index}: cannot write region: {e}"))?;
                } else {
                    let bytes = array
                        .retrieve_array_subset(&subset)
                        .map_err(|e| format!("operation {index}: cannot read region: {e}"))?;
                    let data = to_json(&array, bytes, subset.shape()).map_err(|e| format!("operation {index}: {e}"))?;
                    reads.push(serde_json::json!({"operation": index, "data": data}));
                }
            }
            _ => return Err(format!("operation {index}: unknown op {op:?}")),
        }
    }

    let mut result = Map::new();
    result.insert("document".to_string(), Value::Object(store.document()));
    result.insert("reads".to_string(), Value::Array(reads));
    Ok(canonical_to_string(&Value::Object(result)))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let mode = match args.as_slice() {
        [_, mode] if mode == "write" || mode == "read" || mode == "trace" => mode.clone(),
        _ => {
            eprintln!("usage: crosscheck write|read|trace");
            return ExitCode::from(1);
        }
    };
    let mut input = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut input) {
        eprintln!("failed to read stdin: {e}");
        return ExitCode::from(1);
    }
    let parsed: Value = match zarr_inline::strict_from_str(&input) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("input must be JSON: {e}");
            return ExitCode::from(1);
        }
    };
    let result = match mode.as_str() {
        "write" => write(&parsed),
        "read" => read(&parsed),
        "trace" => trace(&parsed),
        _ => unreachable!(),
    };
    match result {
        Ok(output) => {
            print!("{output}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("crosscheck {mode} failed: {e}");
            ExitCode::from(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_write_read_round_trip() {
        let payload: Value = serde_json::from_str(
            r#"{"arrays": [
                {"path": "b", "dtype": "bool", "shape": [3], "chunks": [2],
                 "data": [true, false, true]},
                {"path": "f32", "dtype": "float32", "shape": [4], "chunks": [3],
                 "data": [0.5, -2.75, "NaN", 1.5]},
                {"path": "f64", "dtype": "float64", "shape": [5], "chunks": [2],
                 "data": [0.5, "NaN", "Infinity", "-Infinity", -2.75]},
                {"path": "grp/i64", "dtype": "int64", "shape": [2, 2], "chunks": [1, 2],
                 "data": [[1099511627776, -5], [0, 9007199254740991]]},
                {"path": "i32", "dtype": "int32", "shape": [3], "chunks": [2],
                 "data": [-2147483648, 0, 2147483647]},
                {"path": "u8", "dtype": "uint8", "shape": [2, 4], "chunks": [2, 4],
                 "data": [[0, 1, 2, 3], [4, 5, 6, 7]]}
            ]}"#,
        )
        .unwrap();

        let document_text = write(&payload).unwrap();
        let document: Value = serde_json::from_str(&document_text).unwrap();

        // The document holds standard v3 metadata (root group, intermediate
        // group, arrays) and inline JSON chunks.
        assert_eq!(document["zarr.json"]["node_type"], "group");
        assert_eq!(document["grp/zarr.json"]["node_type"], "group");
        assert_eq!(document["grp/i64/zarr.json"]["node_type"], "array");
        assert_eq!(
            document["f64/c/0"],
            serde_json::json!([0.5, "NaN"]),
            "json-codec chunks must be inline JSON arrays"
        );

        // Reading the document back reproduces the payload exactly.
        let read_back: Value = serde_json::from_str(&read(&document).unwrap()).unwrap();
        assert_eq!(read_back, payload);
    }

    #[test]
    fn write_rejects_payload_without_arrays() {
        assert!(write(&serde_json::json!({"nope": []})).is_err());
    }

    #[test]
    fn write_rejects_unknown_dtype() {
        let payload = serde_json::json!({"arrays": [
            {"path": "x", "dtype": "no-such-dtype", "shape": [1], "chunks": [1], "data": [0]}
        ]});
        assert!(write(&payload).is_err());
    }

    #[test]
    fn write_rejects_data_shape_mismatch() {
        let payload = serde_json::json!({"arrays": [
            {"path": "x", "dtype": "uint8", "shape": [3], "chunks": [3], "data": [1, 2]}
        ]});
        assert!(write(&payload).is_err());
    }

    #[test]
    fn read_rejects_non_object_input() {
        assert!(read(&serde_json::json!([1, 2])).is_err());
    }

    fn trace_payload(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn trace_round_trips_across_chunk_boundaries() {
        let result: Value = serde_json::from_str(
            &trace(&trace_payload(
                r#"{"operations": [
                    {"op": "create_array", "path": "grp/a", "dtype": "uint8", "shape": [3, 4], "chunks": [2, 2]},
                    {"op": "write_region", "path": "grp/a", "origin": [1, 1], "shape": [2, 2], "data": [[1, 2], [3, 4]]},
                    {"op": "read_region", "path": "grp/a", "origin": [0, 0], "shape": [3, 4]}]}"#,
            ))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            result["reads"][0]["data"],
            serde_json::json!([[0, 0, 0, 0], [0, 1, 2, 0], [0, 3, 4, 0]])
        );
        assert_eq!(result["document"]["grp/zarr.json"]["node_type"], "group");
    }

    #[test]
    fn trace_rejects_out_of_bounds_region() {
        let err = trace(&trace_payload(
            r#"{"operations": [
                {"op": "create_array", "path": "a", "dtype": "uint8", "shape": [3, 4], "chunks": [2, 2]},
                {"op": "read_region", "path": "a", "origin": [2, 2], "shape": [3, 4]}]}"#,
        ))
        .unwrap_err();
        assert!(err.contains("exceeds array extent"), "{err}");
    }

    #[test]
    fn trace_rejects_float_token_for_integer_dtype() {
        let err = trace(&trace_payload(
            r#"{"operations": [
                {"op": "create_array", "path": "a", "dtype": "uint8", "shape": [2], "chunks": [2]},
                {"op": "write_region", "path": "a", "origin": [0], "shape": [2], "data": [1.0, 2]}]}"#,
        ))
        .unwrap_err();
        assert!(err.contains("operation 1"), "{err}");
    }

    #[test]
    fn trace_rejects_invalid_initial_document() {
        let err = trace(&trace_payload(r#"{"document": {"bad/c/0": 123}, "operations": []}"#)).unwrap_err();
        assert!(err.contains("invalid initial document"), "{err}");
    }

    #[test]
    fn trace_refuses_to_create_under_an_array() {
        let err = trace(&trace_payload(
            r#"{"operations": [
                {"op": "create_array", "path": "a", "dtype": "uint8", "shape": [2], "chunks": [2]},
                {"op": "create_array", "path": "a/b", "dtype": "uint8", "shape": [2], "chunks": [2]}]}"#,
        ))
        .unwrap_err();
        assert!(err.contains("is not a group"), "{err}");
    }

    #[test]
    fn trace_rejects_ragged_region_data() {
        let err = trace(&trace_payload(
            r#"{"operations": [
                {"op": "create_array", "path": "a", "dtype": "uint8", "shape": [2, 2], "chunks": [2, 2]},
                {"op": "write_region", "path": "a", "origin": [0, 0], "shape": [2, 2], "data": [[1, 2, 3], [4]]}]}"#,
        ))
        .unwrap_err();
        assert!(err.contains("operation 1"), "{err}");
    }
}
