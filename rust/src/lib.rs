//! zarr-inline: store a Zarr v3 hierarchy as a single JSON object.
//!
//! Rust reference implementation. See
//! `../SPEC.md` and `../DESIGN.md`.

pub mod codec;
pub mod validator;

#[cfg(feature = "zarrs")]
pub mod serializer;
#[cfg(feature = "zarrs")]
pub mod store;

pub use codec::{
    canonical_to_string, decode_value, encode_value, es_number_str, is_metadata_key,
    strict_from_slice, strict_from_str, ZarrJsonError,
};
pub use validator::{check_key, validate, ValidationError, ValidationIssue};

#[cfg(feature = "zarrs")]
pub use serializer::JsonCodec;
#[cfg(feature = "zarrs")]
pub use store::{Document, ZarrInlineStore};
