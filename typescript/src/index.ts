/** zarr-inline public API (TypeScript reference implementation). */

export {
	assertNumbersFinite,
	base64Decode,
	base64Encode,
	canonicalStringify,
	compareCodePoints,
	decodeValue,
	encodeValue,
	isMetadataKey,
	METADATA_SUFFIX,
	strictParse,
} from "./codec.js";
export {
	validate,
	ValidationError,
	type ValidateOptions,
	type ValidationIssue,
} from "./validator.js";
export {
	MemoryBacking,
	StringBacking,
	toNullPrototype,
	type Backing,
	type Document,
} from "./backing.js";
export { ZarrInlineStore, type ZarrInlineStoreOptions } from "./store.js";
export { JsonSerializer, registerJsonCodec } from "./serializer.js";
export { run as runConformance, type ConformanceReport } from "./conformance.js";
