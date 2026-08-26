//! zarr-inline: store a Zarr v3 hierarchy as a single JSON object.
//!
//! Rust reference implementation. See the project
//! [specification](https://github.com/d-v-b/zarr-inline/blob/main/docs/specification.md) and
//! [design guide](https://github.com/d-v-b/zarr-inline/blob/main/docs/how-it-works.md).

pub mod document;
pub mod validator;

#[cfg(feature = "zarrs")]
pub mod serializer;
#[cfg(feature = "zarrs")]
pub mod store;

pub use document::{
    canonical_to_string, decode_value, encode_value, es_number_str, is_metadata_key,
    strict_from_slice, strict_from_str, ZarrInlineError,
};
pub use validator::{check_key, validate, ValidationError, ValidationIssue};

#[cfg(feature = "zarrs")]
pub use serializer::JsonCodec;
#[cfg(feature = "zarrs")]
pub use store::{Document, ZarrInlineStore};
