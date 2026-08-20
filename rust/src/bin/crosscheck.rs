//! Cross-language array crosscheck harness (zarrs side).
//!
//! See `docs/superpowers/specs/2026-08-20-crosscheck-protocol.md`. `write`
//! turns a payload of arrays into a zarr-json document by driving zarrs with
//! the `json` codec through [`ZarrJsonStore`]; `read` opens every array in a
//! document and reports its values using the fill_value scalar serialization,
//! so payloads compare exactly across languages (non-finite floats are the
//! strings `"NaN"` etc.).
//!
//! Errors: message on stderr, exit code 1.

use std::collections::HashSet;
use std::io::Read as _;
use std::process::ExitCode;
use std::sync::Arc;

use serde_json::{Map, Value};
use zarrs::array::{
    Array, ArrayBuilder, ArrayBytes, ArrayMetadata, DataType, FillValue, FillValueMetadata,
};
use zarrs::group::GroupBuilder;
use zarrs::metadata::v3::MetadataV3;
use zarrs::storage::ReadableWritableListableStorage;

use zarr_json::{is_metadata_key, Document, JsonCodec, ZarrJsonStore};

/// Nest a flat C-order list of scalars by `shape`.
fn nest(flat: &[Value], shape: &[u64]) -> Result<Value, String> {
    match shape {
        [] => flat
            .first()
            .cloned()
            .ok_or_else(|| "empty array cannot be nested".to_string()),
        [_] => Ok(Value::Array(flat.to_vec())),
        [dim, rest @ ..] => {
            let dim = usize::try_from(*dim).map_err(|_| "dimension overflows usize".to_string())?;
            if dim == 0 || !flat.len().is_multiple_of(dim) {
                return Err("data length does not match shape".to_string());
            }
            let step = flat.len() / dim;
            let items: Result<Vec<Value>, String> = (0..dim)
                .map(|i| nest(&flat[i * step..(i + 1) * step], rest))
                .collect();
            Ok(Value::Array(items?))
        }
    }
}

/// Shape-driven flattening of a payload `data` value (C order). Recursion
/// stops at the last dimension, so scalar JSON forms that are themselves
/// arrays (e.g. complex `[re, im]`) survive intact.
fn flatten(nested: &Value, shape: &[u64], out: &mut Vec<Value>) -> Result<(), String> {
    let mismatch = || format!("payload data does not match shape {shape:?}");
    match shape {
        [] => {
            out.push(nested.clone());
            Ok(())
        }
        [dim, rest @ ..] => {
            let Value::Array(items) = nested else {
                return Err(mismatch());
            };
            if items.len() as u64 != *dim {
                return Err(mismatch());
            }
            if rest.is_empty() {
                out.extend(items.iter().cloned());
            } else {
                for sub in items {
                    flatten(sub, rest, out)?;
                }
            }
            Ok(())
        }
    }
}

fn u64_list(value: &Value, what: &str) -> Result<Vec<u64>, String> {
    let Value::Array(items) = value else {
        return Err(format!("{what} must be an array of non-negative integers"));
    };
    items
        .iter()
        .map(|v| {
            v.as_u64()
                .ok_or_else(|| format!("{what} must contain non-negative integers"))
        })
        .collect()
}

/// Write mode: payload in, zarr-json document out.
fn write(payload: &Value) -> Result<String, String> {
    let specs = payload
        .get("arrays")
        .and_then(Value::as_array)
        .ok_or_else(|| "payload must be an object with an \"arrays\" array".to_string())?;

    // Maximally standard metadata: no zarrs-specific "_zarrs" attribute.
    zarrs::config::global_config_mut().set_include_zarrs_metadata(false);

    let store = Arc::new(ZarrJsonStore::new());
    let storage: ReadableWritableListableStorage = store.clone();

    let mut groups: HashSet<String> = HashSet::new();
    GroupBuilder::new()
        .build(storage.clone(), "/")
        .map_err(|e| format!("cannot create root group: {e}"))?
        .store_metadata()
        .map_err(|e| format!("cannot store root group metadata: {e}"))?;
    groups.insert(String::new());

    for spec in specs {
        let path = spec
            .get("path")
            .and_then(Value::as_str)
            .filter(|p| !p.is_empty())
            .ok_or_else(|| "array spec needs a non-empty \"path\" string".to_string())?;
        let dtype_name = spec
            .get("dtype")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("array {path}: missing \"dtype\""))?;
        let shape = u64_list(
            spec.get("shape").unwrap_or(&Value::Null),
            &format!("array {path}: \"shape\""),
        )?;
        let chunks = u64_list(
            spec.get("chunks").unwrap_or(&Value::Null),
            &format!("array {path}: \"chunks\""),
        )?;
        let data = spec
            .get("data")
            .ok_or_else(|| format!("array {path}: missing \"data\""))?;

        // Create intermediate groups ("grp/i64" needs a group at "grp"),
        // matching what zarr-python produces.
        let segments: Vec<&str> = path.split('/').collect();
        for depth in 1..segments.len() {
            let ancestor = segments[..depth].join("/");
            if groups.insert(ancestor.clone()) {
                GroupBuilder::new()
                    .build(storage.clone(), &format!("/{ancestor}"))
                    .map_err(|e| format!("cannot create group {ancestor}: {e}"))?
                    .store_metadata()
                    .map_err(|e| format!("cannot store group {ancestor} metadata: {e}"))?;
            }
        }

        let data_type = DataType::from_metadata(&MetadataV3::new(dtype_name))
            .map_err(|e| format!("array {path}: unsupported dtype {dtype_name}: {e}"))?;
        let element_size = data_type
            .fixed_size()
            .ok_or_else(|| format!("array {path}: dtype {dtype_name} is not fixed-size"))?;
        // Sensible per-dtype default fill value: all-zero bytes are
        // 0 / false / 0.0 for the portable dtypes. The payload always
        // writes every element, so the fill value never shows in data.
        let fill_value = FillValue::new(vec![0u8; element_size]);

        let array = ArrayBuilder::new(shape.clone(), chunks, data_type.clone(), fill_value)
            .array_to_bytes_codec(Arc::new(JsonCodec::new()))
            .build(storage.clone(), &format!("/{path}"))
            .map_err(|e| format!("array {path}: cannot create: {e}"))?;
        array
            .store_metadata()
            .map_err(|e| format!("array {path}: cannot store metadata: {e}"))?;

        // Convert nested payload data to native bytes elementwise via the
        // fill_value-from-JSON machinery (the same machinery the json codec
        // uses to decode chunks).
        let mut flat = Vec::new();
        flatten(data, &shape, &mut flat).map_err(|e| format!("array {path}: {e}"))?;
        let mut bytes = Vec::with_capacity(flat.len() * element_size);
        for value in flat {
            let metadata: FillValueMetadata = serde_json::from_value(value.clone())
                .map_err(|e| format!("array {path}: bad scalar {value}: {e}"))?;
            let scalar = data_type
                .fill_value_v3(&metadata)
                .map_err(|e| format!("array {path}: bad scalar {value}: {e}"))?;
            let element = scalar.as_ne_bytes();
            if element.len() != element_size {
                return Err(format!(
                    "array {path}: scalar {value} decoded to {} bytes, expected {element_size}",
                    element.len()
                ));
            }
            bytes.extend_from_slice(element);
        }
        array
            .store_array_subset(&array.subset_all(), ArrayBytes::new_flen(bytes))
            .map_err(|e| format!("array {path}: cannot write data: {e}"))?;
    }

    Ok(store.to_json_string())
}

/// Read mode: zarr-json document in, payload out.
fn read(document_value: &Value) -> Result<String, String> {
    let Value::Object(document) = document_value else {
        return Err("input must be a JSON object".to_string());
    };

    // Discover array paths from the raw document: keys "<path>/zarr.json"
    // whose object value has "node_type": "array" (excluding the root).
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

    let document: Document = document.clone();
    let store = Arc::new(
        ZarrJsonStore::from_document(document).map_err(|e| format!("invalid document: {e}"))?,
    );

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

        let data_type = array.data_type().clone();
        let element_size = data_type
            .fixed_size()
            .ok_or_else(|| format!("array {path}: dtype {dtype_name} is not fixed-size"))?;

        let bytes: ArrayBytes = array
            .retrieve_array_subset(&array.subset_all())
            .map_err(|e| format!("array {path}: cannot read data: {e}"))?;
        let raw = bytes
            .into_fixed()
            .map_err(|e| format!("array {path}: variable-length data unsupported: {e}"))?;

        // Elementwise fill_value scalar serialization.
        let mut flat = Vec::with_capacity(raw.len() / element_size.max(1));
        for element in raw.chunks_exact(element_size) {
            let scalar = FillValue::new(element.to_vec());
            let metadata = data_type
                .metadata_fill_value(&scalar)
                .map_err(|e| format!("array {path}: cannot serialize scalar: {e}"))?;
            let value = serde_json::to_value(&metadata)
                .map_err(|e| format!("array {path}: cannot serialize scalar: {e}"))?;
            flat.push(value);
        }
        let data = nest(&flat, &shape).map_err(|e| format!("array {path}: {e}"))?;

        let mut entry = Map::new();
        entry.insert("path".to_string(), Value::String(path));
        entry.insert("dtype".to_string(), Value::String(dtype_name));
        entry.insert(
            "shape".to_string(),
            Value::Array(shape.into_iter().map(Value::from).collect()),
        );
        entry.insert(
            "chunks".to_string(),
            Value::Array(chunk_shape.into_iter().map(Value::from).collect()),
        );
        entry.insert("data".to_string(), data);
        arrays.push(Value::Object(entry));
    }

    let mut payload = Map::new();
    payload.insert("arrays".to_string(), Value::Array(arrays));
    serde_json::to_string(&Value::Object(payload)).map_err(|e| format!("cannot serialize: {e}"))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let mode = match args.as_slice() {
        [_, mode] if mode == "write" || mode == "read" => mode.clone(),
        _ => {
            eprintln!("usage: crosscheck write|read");
            return ExitCode::from(1);
        }
    };

    let mut input = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut input) {
        eprintln!("failed to read stdin: {e}");
        return ExitCode::from(1);
    }
    let parsed: Value = match serde_json::from_str(&input) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("input must be JSON: {e}");
            return ExitCode::from(1);
        }
    };

    let result = if mode == "write" {
        write(&parsed)
    } else {
        read(&parsed)
    };
    match result {
        Ok(output) => {
            // Compact, UTF-8 (non-ASCII unescaped).
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
}
