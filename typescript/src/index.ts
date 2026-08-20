/** zarr-json public API (TypeScript reference implementation). */

export {
	base64Decode,
	base64Encode,
	canonicalStringify,
	decodeValue,
	encodeValue,
	isMetadataKey,
	METADATA_SUFFIX,
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
	type Backing,
	type Document,
} from "./backing.js";
export { ZarrJsonStore, type ZarrJsonStoreOptions } from "./store.js";
export { JsonSerializer, registerJsonCodec } from "./serializer.js";
export { run as runConformance, type ConformanceReport } from "./conformance.js";
