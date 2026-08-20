//! Integration tests driving zarrs itself through `ZarrJsonStore`.
#![cfg(feature = "zarrs")]

use std::sync::Arc;

use serde_json::Value;
use zarrs::array::{data_type, ArrayBuilder};
use zarrs::group::GroupBuilder;
use zarrs::storage::ReadableWritableListableStorage;

use zarr_json::{JsonCodec, ZarrJsonStore};

/// Create a group and an array with default codecs, write a chunk, read it
/// back, and check the document representation: metadata keys hold JSON
/// objects and the (opaque `bytes`-codec) chunk is a base64 string.
#[test]
fn group_and_array_with_default_codecs() {
    let store = Arc::new(ZarrJsonStore::new());
    let storage: ReadableWritableListableStorage = store.clone();

    GroupBuilder::new()
        .build(storage.clone(), "/")
        .unwrap()
        .store_metadata()
        .unwrap();

    let array = ArrayBuilder::new(
        vec![4, 4],
        vec![2, 2],
        data_type::uint16(),
        0u16,
    )
    .build(storage.clone(), "/data")
    .unwrap();
    array.store_metadata().unwrap();

    let elements: Vec<u16> = vec![1, 2, 3, 4];
    array.store_chunk(&[0, 0], elements.clone()).unwrap();

    // Read the chunk back through a freshly opened array.
    let reopened = zarrs::array::Array::open(storage.clone(), "/data").unwrap();
    let read: Vec<u16> = reopened.retrieve_chunk(&[0, 0]).unwrap();
    assert_eq!(read, elements);

    // The document holds metadata as JSON objects and the chunk as base64.
    let document = store.document();
    assert!(document["zarr.json"].is_object());
    assert!(document["data/zarr.json"].is_object());
    assert_eq!(
        document["data/zarr.json"]["node_type"],
        Value::String("array".to_string())
    );
    assert!(
        document["data/c/0/0"].is_string(),
        "bytes-codec chunk must be a base64 string, got {:?}",
        document["data/c/0/0"]
    );

    // The whole document round-trips through strict construction.
    let store2 = ZarrJsonStore::from_document(document).unwrap();
    let storage2: ReadableWritableListableStorage = Arc::new(store2);
    let reopened2 = zarrs::array::Array::open(storage2, "/data").unwrap();
    let read2: Vec<u16> = reopened2.retrieve_chunk(&[0, 0]).unwrap();
    assert_eq!(read2, elements);
}

/// An array using the `json` codec stores its chunks as real JSON arrays in
/// the document (including NaN -> "NaN"), and reads back exactly.
#[test]
fn array_with_json_codec_inlines_chunks() {
    let store = Arc::new(ZarrJsonStore::new());
    let storage: ReadableWritableListableStorage = store.clone();

    GroupBuilder::new()
        .build(storage.clone(), "/")
        .unwrap()
        .store_metadata()
        .unwrap();

    let array = ArrayBuilder::new(
        vec![4],
        vec![4],
        data_type::float64(),
        0.0f64,
    )
    .array_to_bytes_codec(Arc::new(JsonCodec::new()))
    .build(storage.clone(), "/legible")
    .unwrap();
    array.store_metadata().unwrap();

    let elements = vec![1.5f64, f64::NAN, f64::INFINITY, -0.0];
    array.store_chunk(&[0], elements.clone()).unwrap();

    // The document contains a real JSON array chunk with fill_value-style
    // scalar serialization.
    let document = store.document();
    assert_eq!(
        document["legible/c/0"],
        serde_json::json!([1.5, "NaN", "Infinity", -0.0])
    );
    // The metadata names the json codec.
    let codecs = document["legible/zarr.json"]["codecs"].as_array().unwrap();
    assert!(
        codecs.iter().any(|c| c["name"] == "json"),
        "codecs: {codecs:?}"
    );

    // Reading back through a freshly opened array reproduces the values
    // exactly (bitwise: NaN stays NaN, -0.0 stays -0.0).
    let reopened = zarrs::array::Array::open(storage.clone(), "/legible").unwrap();
    let read: Vec<f64> = reopened.retrieve_chunk(&[0]).unwrap();
    let read_bits: Vec<u64> = read.iter().map(|v| v.to_bits()).collect();
    let expected_bits: Vec<u64> = elements.iter().map(|v| v.to_bits()).collect();
    assert_eq!(read_bits, expected_bits);
}

/// The hierarchy is listable through zarrs.
#[test]
fn hierarchy_listing() {
    let store = Arc::new(ZarrJsonStore::new());
    let storage: ReadableWritableListableStorage = store.clone();

    GroupBuilder::new()
        .build(storage.clone(), "/")
        .unwrap()
        .store_metadata()
        .unwrap();
    let array = ArrayBuilder::new(vec![2], vec![2], data_type::uint8(), 0u8)
        .build(storage.clone(), "/a/b")
        .unwrap();
    array.store_metadata().unwrap();
    GroupBuilder::new()
        .build(storage.clone(), "/a")
        .unwrap()
        .store_metadata()
        .unwrap();

    let node = zarrs::node::Node::open(&storage, "/").unwrap();
    let paths: Vec<String> = node
        .hierarchy_tree()
        .lines()
        .map(str::to_string)
        .collect();
    assert!(!paths.is_empty());
    // Root, group a, array a/b all appear in the hierarchy tree
    // (hierarchy_tree prints node names, indented by depth).
    let tree = paths.join("\n");
    assert!(tree.starts_with('/'), "tree: {tree}");
    assert!(tree.contains("a"), "tree: {tree}");
    assert!(tree.contains("b [2] uint8"), "tree: {tree}");
}
