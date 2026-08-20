//! `ZarrJsonStore`: a read-write zarrs store backed by a JSON object.
//!
//! Implements zarrs's [`ReadableStorageTraits`], [`WritableStorageTraits`],
//! and [`ListableStorageTraits`] (and, via zarrs's blanket impls, the
//! `ReadableWritableListableStorageTraits` supertrait), so it can back the
//! zarrs `Array` / `Group` APIs. The entire store contents live in one
//! `serde_json::Map` document guarded by an `RwLock`; `list_dir` /
//! `list_prefix` derive hierarchy by splitting the flat keys on `/`.

use std::sync::RwLock;

use serde_json::{Map, Value};
use zarrs::storage::byte_range::{ByteRangeIterator, InvalidByteRangeError};
use zarrs::storage::{
    Bytes, ListableStorageTraits, MaybeBytes, MaybeBytesIterator, OffsetBytesIterator,
    ReadableStorageTraits, StorageError, StoreKey, StoreKeys, StoreKeysPrefixes, StorePrefix,
    WritableStorageTraits,
};

use crate::codec::{canonical_to_string, decode_value, encode_value};
use crate::validator::{validate, ValidationError, ValidationIssue};

/// A zarr-json document: one JSON object holding a whole Zarr hierarchy.
///
/// `serde_json::Map` preserves member order (`preserve_order` feature), so
/// documents round-trip losslessly.
pub type Document = Map<String, Value>;

/// A Zarr v3 store whose entire contents live in one JSON object.
#[derive(Debug, Default)]
pub struct ZarrJsonStore {
    document: RwLock<Document>,
}

impl ZarrJsonStore {
    /// Create a store over an empty document.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Create a store over an existing document, validating it strictly.
    ///
    /// # Errors
    /// Returns [`ValidationError`] if the document violates a validity rule
    /// (R1 well-formed keys, R2 per-value type).
    pub fn from_document(document: Document) -> Result<Self, ValidationError> {
        crate::validator::validate_strict(&document)?;
        Ok(Self {
            document: RwLock::new(document),
        })
    }

    /// Create a store over an existing document leniently: validation issues
    /// are returned as diagnostics instead of failing construction.
    #[must_use]
    pub fn from_document_lenient(document: Document) -> (Self, Vec<ValidationIssue>) {
        let issues = validate(&document);
        (
            Self {
                document: RwLock::new(document),
            },
            issues,
        )
    }

    /// Return a snapshot of the current document.
    ///
    /// # Panics
    /// Panics if the internal lock is poisoned.
    #[must_use]
    pub fn document(&self) -> Document {
        self.document.read().unwrap().clone()
    }

    /// Serialize the current document canonically (compact, UTF-8).
    ///
    /// # Panics
    /// Panics if the internal lock is poisoned.
    #[must_use]
    pub fn to_json_string(&self) -> String {
        canonical_to_string(&Value::Object(self.document.read().unwrap().clone()))
    }

    fn get_bytes(&self, key: &StoreKey) -> Result<Option<Vec<u8>>, StorageError> {
        let document = self.document.read().unwrap();
        match document.get(key.as_str()) {
            None => Ok(None),
            Some(value) => decode_value(key.as_str(), value)
                .map(Some)
                .map_err(|e| StorageError::Other(e.to_string())),
        }
    }

    fn sorted_keys(&self) -> Vec<String> {
        let document = self.document.read().unwrap();
        let mut keys: Vec<String> = document.keys().cloned().collect();
        keys.sort();
        keys
    }
}

impl ReadableStorageTraits for ZarrJsonStore {
    fn get(&self, key: &StoreKey) -> Result<MaybeBytes, StorageError> {
        Ok(self.get_bytes(key)?.map(Bytes::from))
    }

    fn get_partial_many<'a>(
        &'a self,
        key: &StoreKey,
        byte_ranges: ByteRangeIterator<'a>,
    ) -> Result<MaybeBytesIterator<'a>, StorageError> {
        let Some(data) = self.get_bytes(key)? else {
            return Ok(None);
        };
        let data = Bytes::from(data);
        let out = Box::new(byte_ranges.map(move |byte_range| {
            let start = usize::try_from(byte_range.start(data.len() as u64)).unwrap();
            let end = usize::try_from(byte_range.end(data.len() as u64)).unwrap();
            if start > data.len() || end > data.len() || start > end {
                Err(InvalidByteRangeError::new(byte_range, data.len() as u64).into())
            } else {
                Ok(data.slice(start..end))
            }
        }));
        Ok(Some(out))
    }

    fn size_key(&self, key: &StoreKey) -> Result<Option<u64>, StorageError> {
        Ok(self.get_bytes(key)?.map(|data| data.len() as u64))
    }

    fn supports_get_partial(&self) -> bool {
        // Every read decodes the whole stored value.
        false
    }
}

impl WritableStorageTraits for ZarrJsonStore {
    fn set(&self, key: &StoreKey, value: Bytes) -> Result<(), StorageError> {
        let encoded = encode_value(key.as_str(), &value)
            .map_err(|e| StorageError::Other(e.to_string()))?;
        let mut document = self.document.write().unwrap();
        document.insert(key.as_str().to_string(), encoded);
        Ok(())
    }

    fn set_partial_many(
        &self,
        key: &StoreKey,
        offset_values: OffsetBytesIterator,
    ) -> Result<(), StorageError> {
        // Read-modify-write: partial writes are not supported natively.
        zarrs::storage::store_set_partial_many(self, key, offset_values)
    }

    fn erase(&self, key: &StoreKey) -> Result<(), StorageError> {
        let mut document = self.document.write().unwrap();
        document.remove(key.as_str());
        Ok(())
    }

    fn erase_prefix(&self, prefix: &StorePrefix) -> Result<(), StorageError> {
        let mut document = self.document.write().unwrap();
        // StorePrefix is "" (root) or ends in '/', so a plain starts_with
        // matches exactly the keys within the prefix directory.
        document.retain(|key, _| !key.starts_with(prefix.as_str()));
        Ok(())
    }

    fn supports_set_partial(&self) -> bool {
        false
    }
}

impl ListableStorageTraits for ZarrJsonStore {
    fn list(&self) -> Result<StoreKeys, StorageError> {
        self.sorted_keys()
            .into_iter()
            .map(|key| StoreKey::new(key).map_err(StorageError::from))
            .collect()
    }

    fn list_prefix(&self, prefix: &StorePrefix) -> Result<StoreKeys, StorageError> {
        self.sorted_keys()
            .into_iter()
            .filter(|key| key.starts_with(prefix.as_str()))
            .map(|key| StoreKey::new(key).map_err(StorageError::from))
            .collect()
    }

    fn list_dir(&self, prefix: &StorePrefix) -> Result<StoreKeysPrefixes, StorageError> {
        let mut keys: StoreKeys = vec![];
        let mut prefixes: Vec<StorePrefix> = vec![];
        for key in self.sorted_keys() {
            let Some(remainder) = key.strip_prefix(prefix.as_str()) else {
                continue;
            };
            match remainder.split_once('/') {
                Some((child, _)) => {
                    let child_prefix =
                        StorePrefix::new(format!("{}{}/", prefix.as_str(), child))?;
                    if prefixes.last() != Some(&child_prefix) {
                        prefixes.push(child_prefix);
                    }
                }
                None => keys.push(StoreKey::new(key)?),
            }
        }
        Ok(StoreKeysPrefixes::new(keys, prefixes))
    }

    fn size_prefix(&self, prefix: &StorePrefix) -> Result<u64, StorageError> {
        let mut size = 0;
        for key in self.list_prefix(prefix)? {
            if let Some(size_key) = self.size_key(&key)? {
                size += size_key;
            }
        }
        Ok(size)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn doc(value: Value) -> Document {
        value.as_object().unwrap().clone()
    }

    fn key(s: &str) -> StoreKey {
        StoreKey::new(s).unwrap()
    }

    #[test]
    fn get_set_round_trip() {
        let store = ZarrJsonStore::new();
        // Metadata key: stored inline as a JSON object.
        store
            .set(&key("zarr.json"), Bytes::from_static(b"{\"zarr_format\":3}"))
            .unwrap();
        // Byte key: opaque bytes stored as base64.
        store
            .set(&key("a/c/0"), Bytes::from_static(&[0, 1, 2]))
            .unwrap();
        // Byte key: canonical JSON array bytes stored inline.
        store
            .set(&key("b/c/0"), Bytes::from_static(b"[1,2]"))
            .unwrap();

        let document = store.document();
        assert_eq!(document["zarr.json"], json!({"zarr_format": 3}));
        assert_eq!(document["a/c/0"], json!("AAEC"));
        assert_eq!(document["b/c/0"], json!([1, 2]));

        assert_eq!(
            store.get(&key("zarr.json")).unwrap().unwrap().as_ref(),
            b"{\"zarr_format\":3}"
        );
        assert_eq!(
            store.get(&key("a/c/0")).unwrap().unwrap().as_ref(),
            &[0, 1, 2]
        );
        assert_eq!(store.get(&key("b/c/0")).unwrap().unwrap().as_ref(), b"[1,2]");
        assert!(store.get(&key("missing")).unwrap().is_none());
    }

    #[test]
    fn set_metadata_key_with_non_object_bytes_errors() {
        let store = ZarrJsonStore::new();
        let result = store.set(&key("zarr.json"), Bytes::from_static(b"[1,2]"));
        assert!(result.is_err());
        // No mutation happened.
        assert!(store.document().is_empty());
    }

    #[test]
    fn erase_removes_key() {
        let store = ZarrJsonStore::new();
        store.set(&key("a/c/0"), Bytes::from_static(&[1])).unwrap();
        store.erase(&key("a/c/0")).unwrap();
        assert!(store.get(&key("a/c/0")).unwrap().is_none());
        // Erasing a missing key is fine.
        store.erase(&key("a/c/0")).unwrap();
    }

    #[test]
    fn erase_prefix_removes_subtree() {
        let store = ZarrJsonStore::new();
        store.set(&key("a/c/0"), Bytes::from_static(&[1])).unwrap();
        store.set(&key("a/c/1"), Bytes::from_static(&[2])).unwrap();
        store.set(&key("b/c/0"), Bytes::from_static(&[3])).unwrap();
        store.erase_prefix(&StorePrefix::new("a/").unwrap()).unwrap();
        assert_eq!(store.document().keys().collect::<Vec<_>>(), vec!["b/c/0"]);
    }

    #[test]
    fn listing_derives_hierarchy() {
        let store = ZarrJsonStore::new();
        for k in ["zarr.json", "a/zarr.json", "a/c/0", "a/c/1", "b/zarr.json"] {
            store.set(&key(k), Bytes::from_static(b"{}")).unwrap();
        }

        let all: Vec<String> = store
            .list()
            .unwrap()
            .iter()
            .map(|k| k.as_str().to_string())
            .collect();
        assert_eq!(all, vec!["a/c/0", "a/c/1", "a/zarr.json", "b/zarr.json", "zarr.json"]);

        let under_a: Vec<String> = store
            .list_prefix(&StorePrefix::new("a/").unwrap())
            .unwrap()
            .iter()
            .map(|k| k.as_str().to_string())
            .collect();
        assert_eq!(under_a, vec!["a/c/0", "a/c/1", "a/zarr.json"]);

        let root = store.list_dir(&StorePrefix::root()).unwrap();
        assert_eq!(
            root.keys().iter().map(|k| k.as_str()).collect::<Vec<_>>(),
            vec!["zarr.json"]
        );
        assert_eq!(
            root.prefixes().iter().map(|p| p.as_str()).collect::<Vec<_>>(),
            vec!["a/", "b/"]
        );

        let dir_a = store.list_dir(&StorePrefix::new("a/").unwrap()).unwrap();
        assert_eq!(
            dir_a.keys().iter().map(|k| k.as_str()).collect::<Vec<_>>(),
            vec!["a/zarr.json"]
        );
        assert_eq!(
            dir_a.prefixes().iter().map(|p| p.as_str()).collect::<Vec<_>>(),
            vec!["a/c/"]
        );
    }

    #[test]
    fn from_document_validates_strictly() {
        assert!(ZarrJsonStore::from_document(doc(json!({"zarr.json": {}}))).is_ok());
        assert!(ZarrJsonStore::from_document(doc(json!({"/bad": "x"}))).is_err());
        assert!(ZarrJsonStore::from_document(doc(json!({"zarr.json": "bad"}))).is_err());
    }

    #[test]
    fn from_document_lenient_surfaces_issues() {
        let (store, issues) =
            ZarrJsonStore::from_document_lenient(doc(json!({"/bad": "x", "ok/c/0": "AAEC"})));
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].rule, "R1");
        assert_eq!(
            store.get(&key("ok/c/0")).unwrap().unwrap().as_ref(),
            &[0, 1, 2]
        );
    }

    #[test]
    fn get_invalid_base64_errors() {
        let (store, _) =
            ZarrJsonStore::from_document_lenient(doc(json!({"a/c/0": "not base64!"})));
        assert!(store.get(&key("a/c/0")).is_err());
    }
}
