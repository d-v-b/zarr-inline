/**
 * The `json` array->bytes codec for zarrita: chunks as canonical JSON arrays.
 *
 * Encoding is the Zarr v3 fill_value scalar serialization, applied elementwise
 * and nested by shape in C order: numbers as JSON numbers, NaN/Infinity as the
 * strings "NaN"/"Infinity"/"-Infinity", booleans as true/false. Output is
 * canonical JSON (see codec.canonicalStringify), which is what lets
 * ZarrJsonStore inline these chunks as real JSON arrays in the document.
 *
 * int64/uint64 caveat: JS represents these as BigInt. Values within
 * Number.MAX_SAFE_INTEGER are emitted as JSON numbers; larger values throw —
 * the known int64-in-JS limitation, inherited from the fill_value convention
 * Integers beyond 2^53 round-trip losslessly as bigint via strictParse.
 *
 * Register with zarrita via `registerJsonCodec()`, then create arrays with
 * `codecs: [{ name: "json", configuration: {} }]`.
 */

import { BoolArray, registry } from "zarrita";
import type { Chunk, CodecMetadata, DataType, TypedArray } from "zarrita";
import { canonicalStringify, strictParse } from "./codec.js";

type ChunkMeta = {
	dataType: DataType;
	shape: number[];
	codecs: CodecMetadata[];
	fillValue: unknown;
};

export function cStrides(shape: number[]): number[] {
	const stride = new Array<number>(shape.length);
	let step = 1;
	for (let i = shape.length - 1; i >= 0; i--) {
		stride[i] = step;
		step *= shape[i];
	}
	return stride;
}

function isFloatType(dataType: string): boolean {
	return (
		dataType === "float16" || dataType === "float32" || dataType === "float64"
	);
}

function isBigintType(dataType: string): boolean {
	return dataType === "int64" || dataType === "uint64";
}

/** Serialize one element per the Zarr v3 fill_value scalar convention. */
export function toJsonScalar(value: unknown, dataType: string): unknown {
	if (typeof value === "bigint") {
		// Safe values serialize as plain numbers (matching the other
		// implementations' output for small ints); larger values stay bigint
		// and canonicalStringify emits their exact digits.
		if (
			value > BigInt(Number.MAX_SAFE_INTEGER) ||
			value < -BigInt(Number.MAX_SAFE_INTEGER)
		) {
			return value;
		}
		return Number(value);
	}
	if (typeof value === "number") {
		if (Number.isNaN(value)) return "NaN";
		if (value === Number.POSITIVE_INFINITY) return "Infinity";
		if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
		return value;
	}
	if (typeof value === "boolean" || typeof value === "string") {
		return value;
	}
	throw new Error(
		`json codec: cannot serialize ${dataType} scalar ${String(value)}`,
	);
}

const INT_RANGES: Record<string, [number, number]> = {
	int8: [-128, 127],
	int16: [-32768, 32767],
	int32: [-2147483648, 2147483647],
	uint8: [0, 255],
	uint16: [0, 65535],
	uint32: [0, 4294967295],
};

/**
 * Parse one element per the Zarr v3 fill_value scalar convention.
 *
 * Strict, like zarr-python's from_json_scalar: coercing silently would be
 * corruption. int64/uint64 accept bigint (strictParse yields it for integer
 * literals beyond 2^53) or safe-integer numbers, range-checked against the
 * dtype bounds; a plain number that is integral but unsafe is rejected (it
 * can only mean a lossy parse upstream). Other int dtypes reject
 * non-integers and out-of-range values; floats accept numbers plus the
 * "NaN"/"Infinity"/"-Infinity" strings; bool requires a JSON boolean.
 */
export function fromJsonScalar(value: unknown, dataType: string): unknown {
	if (isFloatType(dataType)) {
		if (typeof value === "number") {
			return value;
		}
		if (typeof value === "bigint") {
			// An integer token for a float type: the nearest float64 (SPEC §9.2).
			return Number(value);
		}
		if (value === "NaN") return Number.NaN;
		if (value === "Infinity") return Number.POSITIVE_INFINITY;
		if (value === "-Infinity") return Number.NEGATIVE_INFINITY;
		throw new Error(`json codec: invalid ${dataType} scalar ${JSON.stringify(value)}`);
	}
	if (isBigintType(dataType)) {
		// Integer types require an INTEGER token. Callers parse chunk JSON
		// with integersAsBigInt so every integer literal arrives as bigint;
		// a JS number here therefore means a float token like 1.0, which
		// SPEC §9.2 forbids for integer types even when integral.
		if (typeof value !== "bigint") {
			throw new Error(
				`json codec: invalid ${dataType} scalar ${String(value)}: ` +
					"must be an integer token",
			);
		}
		const big = value;
		const [lo, hi] =
			dataType === "int64"
				? [-(2n ** 63n), 2n ** 63n - 1n]
				: [0n, 2n ** 64n - 1n];
		if (big < lo || big > hi) {
			throw new Error(
				`json codec: ${dataType} scalar ${big} is out of range [${lo}, ${hi}]`,
			);
		}
		return big;
	}
	if (dataType === "bool") {
		if (typeof value !== "boolean") {
			throw new Error(`json codec: invalid ${dataType} scalar ${JSON.stringify(value)}`);
		}
		return value;
	}
	const range = INT_RANGES[dataType];
	if (range !== undefined) {
		// As for int64/uint64: an integer token (bigint) is required.
		if (
			typeof value !== "bigint" ||
			value < BigInt(range[0]) ||
			value > BigInt(range[1])
		) {
			throw new Error(`json codec: invalid ${dataType} scalar ${String(value)}`);
		}
		return Number(value);
	}
	return value;
}

/** Nest a flat C-order scalar list by shape. */
export function nest(flat: unknown[], shape: number[]): unknown {
	if (shape.length === 0) {
		return flat[0];
	}
	if (shape.length === 1) {
		return flat;
	}
	const step = flat.length / shape[0];
	const out: unknown[] = [];
	for (let i = 0; i < shape[0]; i++) {
		out.push(nest(flat.slice(i * step, (i + 1) * step), shape.slice(1)));
	}
	return out;
}

/**
 * Flatten nested chunk JSON to a C-order scalar list, driven by shape.
 *
 * Shape-driven: a scalar's JSON form may itself be an array (a complex scalar
 * is a [re, im] pair), so recursion must stop at the last dimension, not at
 * non-array values.
 */
function flatten(nested: unknown, shape: number[]): unknown[] {
	if (shape.length === 0) {
		return [nested];
	}
	if (!Array.isArray(nested) || nested.length !== shape[0]) {
		throw new Error(
			`json codec: chunk JSON does not match chunk shape [${shape.join(",")}]`,
		);
	}
	if (shape.length === 1) {
		return [...nested];
	}
	const out: unknown[] = [];
	for (const sub of nested) {
		out.push(...flatten(sub, shape.slice(1)));
	}
	return out;
}

type NumberArrayCtor = {
	from(values: Iterable<number>): TypedArray<DataType>;
};

const NUMBER_CTORS: Record<string, NumberArrayCtor> = {
	int8: Int8Array as unknown as NumberArrayCtor,
	int16: Int16Array as unknown as NumberArrayCtor,
	int32: Int32Array as unknown as NumberArrayCtor,
	uint8: Uint8Array as unknown as NumberArrayCtor,
	uint16: Uint16Array as unknown as NumberArrayCtor,
	uint32: Uint32Array as unknown as NumberArrayCtor,
	float32: Float32Array as unknown as NumberArrayCtor,
	float64: Float64Array as unknown as NumberArrayCtor,
};

export function makeTypedArray(dataType: string, scalars: unknown[]): TypedArray<DataType> {
	if (isBigintType(dataType)) {
		const Ctor = dataType === "int64" ? BigInt64Array : BigUint64Array;
		return Ctor.from(scalars as bigint[]) as unknown as TypedArray<DataType>;
	}
	if (dataType === "bool") {
		return new BoolArray(scalars as boolean[]) as unknown as TypedArray<DataType>;
	}
	const Ctor = NUMBER_CTORS[dataType];
	if (Ctor === undefined) {
		throw new Error(`json codec: unsupported data type ${JSON.stringify(dataType)}`);
	}
	return Ctor.from(scalars as number[]);
}

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** Indexed element access covering both TypedArrays and BoolArray-likes. */
function elementAt(data: unknown, index: number): unknown {
	if (typeof (data as { get?: unknown }).get === "function") {
		return (data as { get(i: number): unknown }).get(index);
	}
	return (data as ArrayLike<unknown>)[index];
}

/**
 * Read a chunk's elements in C order of `shape`, honoring `stride`.
 *
 * zarrita's Chunk carries an explicit stride: an array->array codec earlier
 * in the chain (e.g. transpose) hands the array->bytes codec a chunk whose
 * memory is not C-contiguous. Walking raw memory order would emit JSON that
 * nests wrongly by shape (verified divergence against zarr-python/zarrs), so
 * elements are gathered by logical index.
 */
export function chunkElements(chunk: {
	data: unknown;
	shape: number[];
	stride: number[];
}): unknown[] {
	const { data, shape, stride } = chunk;
	const rank = shape.length;
	const size = shape.reduce((a, b) => a * b, 1);
	const out = new Array<unknown>(size);
	const index = new Array<number>(rank).fill(0);
	for (let n = 0; n < size; n++) {
		let offset = 0;
		for (let dim = 0; dim < rank; dim++) {
			offset += index[dim] * stride[dim];
		}
		out[n] = elementAt(data, offset);
		for (let dim = rank - 1; dim >= 0; dim--) {
			index[dim] += 1;
			if (index[dim] < shape[dim]) {
				break;
			}
			index[dim] = 0;
		}
	}
	return out;
}

/** Array->bytes codec encoding chunks as canonical UTF-8 JSON arrays. */
export class JsonSerializer {
	readonly kind = "array_to_bytes" as const;
	#dataType: DataType;
	#shape: number[];

	constructor(meta: ChunkMeta) {
		this.#dataType = meta.dataType;
		this.#shape = meta.shape;
	}

	static fromConfig(config: unknown, meta: ChunkMeta): JsonSerializer {
		if (
			config !== undefined &&
			config !== null &&
			(typeof config !== "object" || Object.keys(config).length > 0)
		) {
			throw new Error(
				`json codec takes no configuration; got ${JSON.stringify(config)}`,
			);
		}
		return new JsonSerializer(meta);
	}

	encode(chunk: Chunk<DataType>): Uint8Array {
		// Walk elements in C order of chunk.shape via chunk.stride: a
		// transpose codec earlier in the chain hands over non-C-contiguous
		// memory, and raw-order iteration would nest the JSON wrongly.
		const flat = chunkElements(chunk).map((v) => toJsonScalar(v, this.#dataType));
		const text = canonicalStringify(nest(flat, chunk.shape));
		return UTF8_ENCODER.encode(text);
	}

	decode(bytes: Uint8Array): Chunk<DataType> {
		// integersAsBigInt preserves each element's number sort: integer
		// tokens arrive as bigint (any size), float tokens as number.
		const nested: unknown = strictParse(UTF8_DECODER.decode(bytes), {
			integersAsBigInt: true,
		});
		const flat = flatten(nested, this.#shape);
		const scalars = flat.map((v) => fromJsonScalar(v, this.#dataType));
		return {
			data: makeTypedArray(this.#dataType, scalars),
			shape: this.#shape,
			stride: cStrides(this.#shape),
		};
	}
}

type Registry = typeof registry;
type RegistryValue = Parameters<Registry["set"]>[1];

/**
 * Register the `json` codec with a zarrita codec registry (the global
 * `zarrita.registry` by default), under the codec name "json".
 */
export function registerJsonCodec(reg: Registry = registry): void {
	reg.set("json", (async () => JsonSerializer) as unknown as RegistryValue);
}
