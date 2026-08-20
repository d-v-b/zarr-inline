//! The `json` array->bytes codec: chunks as canonical JSON arrays.
//!
//! Encoding is the Zarr v3 fill_value scalar serialization, applied
//! elementwise and nested by shape in C order. Every Zarr v3 data type must
//! define a JSON scalar serialization to be representable in the `fill_value`
//! metadata field, so this codec covers every fixed-size dtype by
//! construction: NaN/Infinity become the strings "NaN"/"Infinity", complex
//! values become [re, im] pairs, and so on. zarrs exposes the serialization
//! as `DataTypeTraits::metadata_fill_value` / `fill_value_v3`.
//!
//! Output is canonical JSON (see [`crate::codec::canonical_to_string`]),
//! which is what lets [`crate::ZarrJsonStore`] inline these chunks as real
//! JSON arrays in the document.
//!
//! A rank-0 chunk serializes to a bare JSON scalar; the store only inlines
//! arrays, so rank-0 chunks are stored base64-encoded.
//!
//! The codec registers itself with zarrs's compile-time plugin registry
//! (inventory) under the name `json`, so arrays whose metadata names the
//! codec can be opened without further setup.

use std::borrow::Cow;
use std::num::NonZeroU64;
use std::sync::Arc;

use serde_json::Value;
use zarrs::array::codec::api::{
    ArrayCodecTraits, ArrayToBytesCodecTraits, Codec, CodecError, CodecMetadataOptions,
    CodecOptions, CodecPluginV3, CodecTraits, CodecTraitsV3, PartialDecoderCapability,
    PartialEncoderCapability, RecommendedConcurrency,
};
use zarrs::array::{
    ArrayBytes, ArrayBytesRaw, BytesRepresentation, DataType, FillValue, FillValueMetadata,
};
use zarrs::metadata::v3::MetadataV3;
use zarrs::metadata::Configuration;
use zarrs::plugin::{PluginCreateError, ZarrVersion};

use crate::codec::canonical_to_string;

/// The `json` array->bytes codec: encodes chunks as canonical UTF-8 JSON
/// arrays using the Zarr v3 fill_value scalar serialization elementwise.
#[derive(Debug, Clone, Copy, Default)]
pub struct JsonCodec;

impl JsonCodec {
    /// Create a new `json` codec.
    #[must_use]
    pub const fn new() -> Self {
        Self
    }
}

zarrs::plugin::impl_extension_aliases!(JsonCodec, v3: "json");

// Compile-time registration with zarrs's V3 codec plugin registry.
inventory::submit! {
    CodecPluginV3::new::<JsonCodec>()
}

impl CodecTraitsV3 for JsonCodec {
    fn create(_metadata: &MetadataV3) -> Result<Codec, PluginCreateError> {
        // The json codec has no configuration.
        Ok(Codec::ArrayToBytes(Arc::new(JsonCodec)))
    }
}

/// Nest a flat C-order list of scalars by `shape`.
fn nest(flat: &[Value], shape: &[u64]) -> Value {
    match shape {
        [] => flat[0].clone(),
        [_] => Value::Array(flat.to_vec()),
        [dim, rest @ ..] => {
            let step = flat.len() / usize::try_from(*dim).unwrap();
            Value::Array(
                (0..usize::try_from(*dim).unwrap())
                    .map(|i| nest(&flat[i * step..(i + 1) * step], rest))
                    .collect(),
            )
        }
    }
}

/// Shape-driven flattening: a scalar's JSON form may itself be an array
/// (complex -> [re, im]), so recursion must stop at the last dimension, not
/// at non-array values.
fn flatten(nested: &Value, shape: &[u64], out: &mut Vec<Value>) -> Result<(), CodecError> {
    let mismatch = || CodecError::Other(format!("json codec: chunk JSON does not match chunk shape {shape:?}"));
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
                Ok(())
            } else {
                for sub in items {
                    flatten(sub, rest, out)?;
                }
                Ok(())
            }
        }
    }
}

fn fixed_size(data_type: &DataType) -> Result<usize, CodecError> {
    data_type.fixed_size().ok_or_else(|| {
        CodecError::UnsupportedDataType(data_type.clone(), "json".to_string())
    })
}

impl CodecTraits for JsonCodec {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn configuration(
        &self,
        _version: ZarrVersion,
        _options: &CodecMetadataOptions,
    ) -> Option<Configuration> {
        Some(Configuration::default())
    }

    fn partial_decoder_capability(&self) -> PartialDecoderCapability {
        PartialDecoderCapability {
            partial_read: false,
            partial_decode: false,
        }
    }

    fn partial_encoder_capability(&self) -> PartialEncoderCapability {
        PartialEncoderCapability {
            partial_encode: false,
        }
    }
}

impl ArrayCodecTraits for JsonCodec {
    fn recommended_concurrency(
        &self,
        _shape: &[NonZeroU64],
        _data_type: &DataType,
    ) -> Result<RecommendedConcurrency, CodecError> {
        Ok(RecommendedConcurrency::new_maximum(1))
    }
}

impl ArrayToBytesCodecTraits for JsonCodec {
    fn into_dyn(self: Arc<Self>) -> Arc<dyn ArrayToBytesCodecTraits> {
        self as Arc<dyn ArrayToBytesCodecTraits>
    }

    fn encoded_representation(
        &self,
        _shape: &[NonZeroU64],
        _data_type: &DataType,
        _fill_value: &FillValue,
    ) -> Result<BytesRepresentation, CodecError> {
        Ok(BytesRepresentation::UnboundedSize)
    }

    fn encode<'a>(
        &self,
        bytes: ArrayBytes<'a>,
        shape: &[NonZeroU64],
        data_type: &DataType,
        _fill_value: &FillValue,
        _options: &CodecOptions,
    ) -> Result<ArrayBytesRaw<'a>, CodecError> {
        let element_size = fixed_size(data_type)?;
        let num_elements = shape.iter().map(|d| d.get()).product::<u64>();
        bytes.validate(num_elements, data_type)?;
        let raw = bytes.into_fixed()?;

        // Elementwise fill_value scalar serialization.
        let mut flat = Vec::with_capacity(usize::try_from(num_elements).unwrap());
        for element in raw.chunks_exact(element_size) {
            let fill_value = FillValue::new(element.to_vec());
            let metadata = data_type
                .metadata_fill_value(&fill_value)
                .map_err(|e| CodecError::Other(format!("json codec: {e}")))?;
            let value = serde_json::to_value(&metadata)
                .map_err(|e| CodecError::Other(format!("json codec: {e}")))?;
            flat.push(value);
        }

        let shape_u64: Vec<u64> = shape.iter().map(|d| d.get()).collect();
        let text = canonical_to_string(&nest(&flat, &shape_u64));
        Ok(Cow::Owned(text.into_bytes()))
    }

    fn decode<'a>(
        &self,
        bytes: ArrayBytesRaw<'a>,
        shape: &[NonZeroU64],
        data_type: &DataType,
        _fill_value: &FillValue,
        _options: &CodecOptions,
    ) -> Result<ArrayBytes<'a>, CodecError> {
        let element_size = fixed_size(data_type)?;
        let nested: Value = crate::codec::strict_from_slice(&bytes)
            .map_err(|e| CodecError::Other(format!("json codec: chunk is not JSON: {e}")))?;

        let shape_u64: Vec<u64> = shape.iter().map(|d| d.get()).collect();
        let mut flat = Vec::new();
        flatten(&nested, &shape_u64, &mut flat)?;

        let mut out = Vec::with_capacity(flat.len() * element_size);
        for value in flat {
            let metadata: FillValueMetadata = serde_json::from_value(value)
                .map_err(|e| CodecError::Other(format!("json codec: {e}")))?;
            let fill_value = data_type
                .fill_value_v3(&metadata)
                .map_err(|e| CodecError::Other(format!("json codec: {e}")))?;
            let element = fill_value.as_ne_bytes();
            if element.len() != element_size {
                return Err(CodecError::Other(format!(
                    "json codec: scalar decoded to {} bytes, expected {element_size}",
                    element.len()
                )));
            }
            out.extend_from_slice(element);
        }
        Ok(ArrayBytes::new_flen(out))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use zarrs::array::data_type;

    fn shape(dims: &[u64]) -> Vec<NonZeroU64> {
        dims.iter().map(|d| NonZeroU64::new(*d).unwrap()).collect()
    }

    fn encode_to_string(
        codec: &JsonCodec,
        elements: Vec<u8>,
        chunk_shape: &[NonZeroU64],
        dt: &DataType,
    ) -> String {
        let encoded = codec
            .encode(
                ArrayBytes::new_flen(elements),
                chunk_shape,
                dt,
                &FillValue::new(vec![0; dt.fixed_size().unwrap()]),
                &CodecOptions::default(),
            )
            .unwrap();
        String::from_utf8(encoded.into_owned()).unwrap()
    }

    #[test]
    fn encode_decode_round_trip_uint8_2d() {
        let codec = JsonCodec;
        let dt = data_type::uint8();
        let chunk_shape = shape(&[2, 4]);
        let elements: Vec<u8> = (0..8).collect();
        let text = encode_to_string(&codec, elements.clone(), &chunk_shape, &dt);
        assert_eq!(text, "[[0,1,2,3],[4,5,6,7]]");

        let decoded = codec
            .decode(
                Cow::Owned(text.into_bytes()),
                &chunk_shape,
                &dt,
                &FillValue::new(vec![0]),
                &CodecOptions::default(),
            )
            .unwrap();
        assert_eq!(decoded.into_fixed().unwrap().into_owned(), elements);
    }

    #[test]
    fn encode_float64_nonfinite_uses_fill_value_strings() {
        let codec = JsonCodec;
        let dt = data_type::float64();
        let values = [1.5f64, f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -0.0];
        let elements: Vec<u8> = values.iter().flat_map(|v| v.to_ne_bytes()).collect();
        let chunk_shape = shape(&[5]);
        let text = encode_to_string(&codec, elements.clone(), &chunk_shape, &dt);
        // ES number formatting (RFC 8785): -0.0 prints "0", losing its sign.
        assert_eq!(text, r#"[1.5,"NaN","Infinity","-Infinity",0]"#);

        // Decode reproduces the bit patterns, except -0.0 which comes back
        // as +0.0 (canonical numbers do not preserve the sign of zero).
        let expected: Vec<u8> = [1.5f64, f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 0.0]
            .iter()
            .flat_map(|v| v.to_ne_bytes())
            .collect();
        let decoded = codec
            .decode(
                Cow::Owned(text.into_bytes()),
                &chunk_shape,
                &dt,
                &FillValue::new(vec![0; 8]),
                &CodecOptions::default(),
            )
            .unwrap();
        assert_eq!(decoded.into_fixed().unwrap().into_owned(), expected);
    }

    #[test]
    fn complex_scalars_stop_recursion_at_last_dimension() {
        let codec = JsonCodec;
        let dt = data_type::complex128();
        // One complex element: JSON form is itself a 2-element array.
        let elements: Vec<u8> = [1.5f64, -2.5f64]
            .iter()
            .flat_map(|v| v.to_ne_bytes())
            .collect();
        let chunk_shape = shape(&[1]);
        let text = encode_to_string(&codec, elements.clone(), &chunk_shape, &dt);
        assert_eq!(text, "[[1.5,-2.5]]");

        let decoded = codec
            .decode(
                Cow::Owned(text.into_bytes()),
                &chunk_shape,
                &dt,
                &FillValue::new(vec![0; 16]),
                &CodecOptions::default(),
            )
            .unwrap();
        assert_eq!(decoded.into_fixed().unwrap().into_owned(), elements);
    }

    #[test]
    fn bool_and_int_round_trip() {
        let codec = JsonCodec;
        let dt = data_type::bool();
        let chunk_shape = shape(&[2]);
        let text = encode_to_string(&codec, vec![1, 0], &chunk_shape, &dt);
        assert_eq!(text, "[true,false]");

        let dt = data_type::int32();
        let elements: Vec<u8> = [-5i32, 7].iter().flat_map(|v| v.to_ne_bytes()).collect();
        let text = encode_to_string(&codec, elements, &chunk_shape, &dt);
        assert_eq!(text, "[-5,7]");
    }

    #[test]
    fn decode_shape_mismatch_errors() {
        let codec = JsonCodec;
        let dt = data_type::uint8();
        let result = codec.decode(
            Cow::Borrowed(b"[1,2,3]".as_slice()),
            &shape(&[2]),
            &dt,
            &FillValue::new(vec![0]),
            &CodecOptions::default(),
        );
        assert!(result.is_err());
    }

    #[test]
    fn decode_non_json_errors() {
        let codec = JsonCodec;
        let dt = data_type::uint8();
        let result = codec.decode(
            Cow::Borrowed(b"[NaN]".as_slice()),
            &shape(&[1]),
            &dt,
            &FillValue::new(vec![0]),
            &CodecOptions::default(),
        );
        assert!(result.is_err());
    }

    #[test]
    fn registered_with_zarrs_plugin_registry() {
        let metadata = MetadataV3::new("json");
        let codec = Codec::from_metadata(&metadata).unwrap();
        assert!(matches!(codec, Codec::ArrayToBytes(_)));
    }

    #[test]
    fn nest_and_flatten_are_inverses() {
        let flat: Vec<Value> = (0..24).map(|i| json!(i)).collect();
        for dims in [vec![24], vec![4, 6], vec![2, 3, 4], vec![24, 1]] {
            let nested = nest(&flat, &dims);
            let mut back = Vec::new();
            flatten(&nested, &dims, &mut back).unwrap();
            assert_eq!(back, flat, "shape {dims:?}");
        }
    }
}
