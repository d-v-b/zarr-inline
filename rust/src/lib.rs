//! zarr-json: store a Zarr v3 hierarchy as a single JSON object.
//!
//! Rust reference implementation. See
//! `../docs/superpowers/specs/2026-05-14-zarr-json-design.md` and
//! `../docs/superpowers/specs/2026-08-20-conformance-protocol.md`.

pub mod codec;
pub mod validator;

#[cfg(feature = "zarrs")]
pub mod serializer;
#[cfg(feature = "zarrs")]
pub mod store;

pub use codec::{canonical_to_string, decode_value, encode_value, is_metadata_key, ZarrJsonError};
pub use validator::{validate, ValidationError, ValidationIssue};

#[cfg(feature = "zarrs")]
pub use serializer::JsonCodec;
#[cfg(feature = "zarrs")]
pub use store::{Document, ZarrJsonStore};
