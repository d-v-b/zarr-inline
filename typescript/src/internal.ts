/**
 * Unstable internals for the zarr-inline conformance/crosscheck harnesses.
 *
 * Everything here is implementation detail: no semver guarantees. The
 * public API is the package root.
 */

export {
	JsonSerializer,
	cStrides,
	chunkElements,
	makeTypedArray,
	registerJsonCodec,
} from "./serializer.js";
