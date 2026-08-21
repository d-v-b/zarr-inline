//! `ZarrJsonStore`: a read-write zarrs store backed by a JSON object.
//!
//! Implements zarrs's [`ReadableStorageTraits`], [`WritableStorageTraits`],
//! and [`ListableStorageTraits`] (and, via zarrs's blanket impls, the
//! `ReadableWritableListableStorageTraits` supertrait), so it can back the
//! zarrs `Array` / `Group` APIs. The entire store contents live in one
//! `serde_json::Map` document guarded by an `RwLock`; `list_dir` /
//! `list_prefix` derive hierarchy by splitting the flat keys on `/`.

use std::collections::HashSet;
use std::sync::RwLock;

use serde_json::{Map, Value};
use zarrs::storage::byte_range::{ByteRange, ByteRangeIterator, InvalidByteRangeError};
use zarrs::storage::{
    Bytes, ListableStorageTraits, MaybeBytes, MaybeBytesIterator, OffsetBytesIterator,
    ReadableStorageTraits, StorageError, StoreKey, StoreKeys, StoreKeysPrefixes, StorePrefix,
    WritableStorageTraits,
};

use crate::codec::{canonical_to_string, decode_value, encode_value};
use crate::validator::{check_key, validate, ValidationError, ValidationIssue};

/// A zarr-json document: one JSON object holding a whole Zarr hierarchy.
///
/// `serde_json::Map` preserves member order (`preserve_order` feature), so
/// documents round-trip losslessly.
pub type Document = Map<String, Value>;

/// A Zarr v3 store whose entire contents live in one JSON object.
#[derive(Debug, Default)]
pub struct ZarrJsonStore {
    document: RwLock<Document>,
    /// Lenient mode: keys with validation issues behave as absent (SPEC 8.1)
    /// while staying in the document text, so values this version does not
    /// understand are never destroyed by a re-export. A successful write or
    /// erase clears the key's skip. Lock order: `document` before `skipped`.
    skipped: RwLock<HashSet<String>>,
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
            skipped: RwLock::new(HashSet::new()),
        })
    }

    /// Create a store over an existing document leniently: validation issues
    /// are returned as diagnostics instead of failing construction.
    #[must_use]
    pub fn from_document_lenient(document: Document) -> (Self, Vec<ValidationIssue>) {
        let issues = validate(&document);
        let skipped: HashSet<String> = issues.iter().map(|i| i.key.clone()).collect();
        (
            Self {
                document: RwLock::new(document),
                skipped: RwLock::new(skipped),
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
        if self.skipped.read().unwrap().contains(key.as_str()) {
            return Ok(None);
        }
        match document.get(key.as_str()) {
            None => Ok(None),
            Some(value) => decode_value(key.as_str(), value)
                .map(Some)
                .map_err(|e| StorageError::Other(e.to_string())),
        }
    }

    /// Reject writes to keys that fail the validator's R1 rule.
    ///
    /// zarrs's `StoreKey` is laxer than R1 (it accepts `a/./b` and `..`), so
    /// writable methods re-validate the key string themselves before
    /// mutating: a set through zarrs must never make the document invalid.
    fn check_write_key(key: &StoreKey) -> Result<(), StorageError> {
        match check_key(key.as_str()) {
            None => Ok(()),
            Some(issue) => Err(StorageError::Other(format!(
                "invalid store key {:?}: {}",
                key.as_str(),
                issue.message
            ))),
        }
    }

    /// Sorted document keys, excluding lenient-mode skipped entries.
    fn sorted_keys(&self) -> Vec<String> {
        let document = self.document.read().unwrap();
        let skipped = self.skipped.read().unwrap();
        let mut keys: Vec<String> = document
            .keys()
            .filter(|k| !skipped.contains(k.as_str()))
            .cloned()
            .collect();
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
            let len = data.len() as u64;
            // Checked arithmetic: ByteRange::start/end use unchecked u64
            // arithmetic that panics in debug builds on out-of-range
            // requests (e.g. Suffix longer than the value).
            let bounds = match byte_range {
                ByteRange::FromStart(offset, None) => Some((offset, len)),
                ByteRange::FromStart(offset, Some(length)) => {
                    offset.checked_add(length).map(|end| (offset, end))
                }
                ByteRange::Suffix(length) => len.checked_sub(length).map(|start| (start, len)),
            };
            match bounds {
                Some((start, end)) if start <= end && end <= len => {
                    // start <= end <= len == data.len() (a usize), so these
                    // casts cannot truncate.
                    Ok(data.slice(start as usize..end as usize))
                }
                _ => Err(InvalidByteRangeError::new(byte_range, len).into()),
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
        Self::check_write_key(key)?;
        let encoded = encode_value(key.as_str(), &value)
            .map_err(|e| StorageError::Other(e.to_string()))?;
        let mut document = self.document.write().unwrap();
        document.insert(key.as_str().to_string(), encoded);
        self.skipped.write().unwrap().remove(key.as_str());
        Ok(())
    }

    fn set_partial_many(
        &self,
        key: &StoreKey,
        offset_values: OffsetBytesIterator,
    ) -> Result<(), StorageError> {
        // set_partial_many also creates keys, so it gets the same R1 guard.
        Self::check_write_key(key)?;
        // Read-modify-write under a single write-lock acquisition, so a
        // concurrent set_partial_many cannot observe (and clobber) a stale
        // value between the read and the write.
        let mut document = self.document.write().unwrap();
        let mut bytes = match document.get(key.as_str()) {
            None => Vec::new(),
            Some(value) => decode_value(key.as_str(), value)
                .map_err(|e| StorageError::Other(e.to_string()))?,
        };
        for (offset, value) in offset_values {
            let offset = usize::try_from(offset).map_err(|_| {
                StorageError::Other(format!("partial write offset {offset} overflows usize"))
            })?;
            let end = offset.checked_add(value.len()).ok_or_else(|| {
                StorageError::Other("partial write end offset overflows usize".to_string())
            })?;
            if bytes.len() < end {
                // Zero-fill extension for missing/short values, matching
                // zarrs's MemoryStore semantics.
                bytes.resize(end, 0);
            }
            bytes[offset..end].copy_from_slice(&value);
        }
        let encoded = encode_value(key.as_str(), &bytes)
            .map_err(|e| StorageError::Other(e.to_string()))?;
        document.insert(key.as_str().to_string(), encoded);
        self.skipped.write().unwrap().remove(key.as_str());
        Ok(())
    }

    fn erase(&self, key: &StoreKey) -> Result<(), StorageError> {
        let mut document = self.document.write().unwrap();
        document.remove(key.as_str());
        self.skipped.write().unwrap().remove(key.as_str());
        Ok(())
    }

    fn erase_prefix(&self, prefix: &StorePrefix) -> Result<(), StorageError> {
        let mut document = self.document.write().unwrap();
        // StorePrefix is "" (root) or ends in '/', so a plain starts_with
        // matches exactly the keys within the prefix directory.
        document.retain(|key, _| !key.starts_with(prefix.as_str()));
        self.skipped
            .write()
            .unwrap()
            .retain(|key| !key.starts_with(prefix.as_str()));
        Ok(())
    }

    fn supports_set_partial(&self) -> bool {
        false
    }
}

impl ListableStorageTraits for ZarrJsonStore {
    // Listing silently skips document keys that are not valid store keys
    // (possible only in a leniently constructed store): lenient mode
    // surfaces such entries as diagnostics at construction time, and one
    // bad entry must not make the whole hierarchy unlistable.

    fn list(&self) -> Result<StoreKeys, StorageError> {
        Ok(self
            .sorted_keys()
            .into_iter()
            .filter_map(|key| StoreKey::new(key).ok())
            .collect())
    }

    fn list_prefix(&self, prefix: &StorePrefix) -> Result<StoreKeys, StorageError> {
        Ok(self
            .sorted_keys()
            .into_iter()
            .filter(|key| key.starts_with(prefix.as_str()))
            .filter_map(|key| StoreKey::new(key).ok())
            .collect())
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
                    let Ok(child_prefix) =
                        StorePrefix::new(format!("{}{}/", prefix.as_str(), child))
                    else {
                        continue;
                    };
                    if prefixes.last() != Some(&child_prefix) {
                        prefixes.push(child_prefix);
                    }
                }
                None => {
                    if let Ok(key) = StoreKey::new(key) {
                        keys.push(key);
                    }
                }
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
    fn set_rejects_keys_failing_r1() {
        // zarrs's StoreKey is laxer than the validator's R1 rule, so the
        // store must reject such keys itself; the document stays unchanged.
        let store = ZarrJsonStore::new();
        let mut exercised = Vec::new();
        for bad in ["", "a/", "a//b", "a/./b", "a/../b", "..", "/a"] {
            let Ok(store_key) = StoreKey::new(bad) else {
                continue; // zarrs itself refuses to construct this key
            };
            exercised.push(bad);
            let err = store
                .set(&store_key, Bytes::from_static(&[1]))
                .expect_err(&format!("set must reject key {bad:?}"));
            assert!(
                err.to_string().contains("invalid store key"),
                "key {bad:?}: {err}"
            );
            let writes: OffsetBytesIterator =
                Box::new(std::iter::once((0u64, Bytes::from_static(&[1]))));
            let err = store
                .set_partial_many(&store_key, writes)
                .expect_err(&format!("set_partial_many must reject key {bad:?}"));
            assert!(
                err.to_string().contains("invalid store key"),
                "key {bad:?}: {err}"
            );
            assert!(store.document().is_empty(), "key {bad:?} mutated the document");
        }
        // zarrs 0.23 accepts at least these two R1-invalid keys, so the
        // guard is known to be doing real work.
        assert!(exercised.contains(&"a/./b"), "exercised: {exercised:?}");
        assert!(exercised.contains(&".."), "exercised: {exercised:?}");
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
    fn lenient_mode_treats_invalid_entries_as_absent_until_rewritten() {
        // SPEC 8.1: R2-invalid entries behave as absent (get -> None, not
        // listed) but survive in the document text; a successful set makes
        // the key live again.
        let (store, issues) =
            ZarrJsonStore::from_document_lenient(doc(json!({"bad/c/0": 123, "ok/c/0": "AAEC"})));
        assert_eq!(issues.len(), 1);
        assert!(store.get(&key("bad/c/0")).unwrap().is_none());
        assert_eq!(store.size_key(&key("bad/c/0")).unwrap(), None);
        let listed: Vec<String> = store.list().unwrap().iter().map(|k| k.as_str().to_string()).collect();
        assert_eq!(listed, vec!["ok/c/0"]);
        assert_eq!(store.document()["bad/c/0"], json!(123));

        store.set(&key("bad/c/0"), Bytes::from_static(&[7])).unwrap();
        assert_eq!(store.get(&key("bad/c/0")).unwrap().unwrap().as_ref(), &[7]);
        let listed: Vec<String> = store.list().unwrap().iter().map(|k| k.as_str().to_string()).collect();
        assert_eq!(listed, vec!["bad/c/0", "ok/c/0"]);
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
    fn lenient_store_with_invalid_key_is_still_listable() {
        let (store, issues) =
            ZarrJsonStore::from_document_lenient(doc(json!({"/bad": "eA==", "ok/c/0": "AAEC"})));
        assert_eq!(issues.len(), 1);

        // list() skips the invalid document key.
        let all: Vec<String> = store
            .list()
            .unwrap()
            .iter()
            .map(|k| k.as_str().to_string())
            .collect();
        assert_eq!(all, vec!["ok/c/0"]);

        // list_prefix at root skips it too.
        let at_root: Vec<String> = store
            .list_prefix(&StorePrefix::root())
            .unwrap()
            .iter()
            .map(|k| k.as_str().to_string())
            .collect();
        assert_eq!(at_root, vec!["ok/c/0"]);

        // list_dir at root works and derives only the valid hierarchy.
        let root = store.list_dir(&StorePrefix::root()).unwrap();
        assert!(root.keys().is_empty());
        assert_eq!(
            root.prefixes().iter().map(|p| p.as_str()).collect::<Vec<_>>(),
            vec!["ok/"]
        );

        // The valid entry is still readable.
        assert_eq!(
            store.get(&key("ok/c/0")).unwrap().unwrap().as_ref(),
            &[0, 1, 2]
        );
    }

    #[test]
    fn get_partial_many_out_of_range_errors_instead_of_panicking() {
        let store = ZarrJsonStore::new();
        store
            .set(&key("a/c/0"), Bytes::from_static(&[0, 1, 2, 3, 4]))
            .unwrap();

        // Suffix longer than the value: previously subtract-with-overflow
        // in debug builds.
        let ranges: ByteRangeIterator = Box::new(std::iter::once(ByteRange::Suffix(10)));
        let results: Vec<_> = store
            .get_partial_many(&key("a/c/0"), ranges)
            .unwrap()
            .unwrap()
            .collect();
        assert_eq!(results.len(), 1);
        assert!(results[0].is_err());

        // FromStart(u64::MAX, Some(1)): previously add-with-overflow.
        let ranges: ByteRangeIterator =
            Box::new(std::iter::once(ByteRange::FromStart(u64::MAX, Some(1))));
        let results: Vec<_> = store
            .get_partial_many(&key("a/c/0"), ranges)
            .unwrap()
            .unwrap()
            .collect();
        assert_eq!(results.len(), 1);
        assert!(results[0].is_err());

        // In-range requests still work alongside out-of-range ones.
        let ranges: ByteRangeIterator = Box::new(
            vec![ByteRange::FromStart(1, Some(2)), ByteRange::Suffix(2)].into_iter(),
        );
        let results: Vec<_> = store
            .get_partial_many(&key("a/c/0"), ranges)
            .unwrap()
            .unwrap()
            .collect();
        assert_eq!(results[0].as_ref().unwrap().as_ref(), &[1, 2]);
        assert_eq!(results[1].as_ref().unwrap().as_ref(), &[3, 4]);
    }

    #[test]
    fn set_partial_many_overwrites_and_zero_fills() {
        let store = ZarrJsonStore::new();
        store
            .set(&key("a/c/0"), Bytes::from_static(&[9, 9, 9]))
            .unwrap();

        // Overwrite within the existing value, extending past its end.
        let writes: OffsetBytesIterator = Box::new(
            vec![
                (1u64, Bytes::from_static(&[7, 8])),
                (5u64, Bytes::from_static(&[1])),
            ]
            .into_iter(),
        );
        store.set_partial_many(&key("a/c/0"), writes).unwrap();
        assert_eq!(
            store.get(&key("a/c/0")).unwrap().unwrap().as_ref(),
            &[9, 7, 8, 0, 0, 1]
        );

        // Partial write to a missing key zero-fills from the start.
        let writes: OffsetBytesIterator =
            Box::new(std::iter::once((2u64, Bytes::from_static(&[5]))));
        store.set_partial_many(&key("b/c/0"), writes).unwrap();
        assert_eq!(
            store.get(&key("b/c/0")).unwrap().unwrap().as_ref(),
            &[0, 0, 5]
        );
    }

    #[test]
    fn get_invalid_base64_errors() {
        let (store, _) =
            ZarrJsonStore::from_document_lenient(doc(json!({"a/c/0": "not base64!"})));
        assert!(store.get(&key("a/c/0")).is_err());
    }
}
