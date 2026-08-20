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
 * (plain JSON.parse cannot round-trip integers beyond 2^53 either).
 *
 * Register with zarrita via `registerJsonCodec()`, then create arrays with
 * `codecs: [{ name: "json", configuration: {} }]`.
 */

import { BoolArray, registry } from "zarrita";
import type { Chunk, CodecMetadata, DataType, TypedArray } from "zarrita";
import { canonicalStringify } from "./codec.js";

type ChunkMeta = {
	dataType: DataType;
	shape: number[];
	codecs: CodecMetadata[];
	fillValue: unknown;
};

function cStrides(shape: number[]): number[] {
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
function toJsonScalar(value: unknown, dataType: string): unknown {
	if (typeof value === "bigint") {
		if (
			value > BigInt(Number.MAX_SAFE_INTEGER) ||
			value < -BigInt(Number.MAX_SAFE_INTEGER)
		) {
			throw new Error(
				`json codec: ${dataType} value ${value} exceeds Number.MAX_SAFE_INTEGER ` +
					"and cannot be represented exactly in a JavaScript JSON document " +
					"(known int64-in-JS limitation, inherited from the fill_value convention)",
			);
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

/** Parse one element per the Zarr v3 fill_value scalar convention. */
function fromJsonScalar(value: unknown, dataType: string): unknown {
	if (isFloatType(dataType) && typeof value === "string") {
		if (value === "NaN") return Number.NaN;
		if (value === "Infinity") return Number.POSITIVE_INFINITY;
		if (value === "-Infinity") return Number.NEGATIVE_INFINITY;
		throw new Error(`json codec: invalid ${dataType} scalar ${JSON.stringify(value)}`);
	}
	if (isBigintType(dataType)) {
		if (typeof value === "number" || typeof value === "string") {
			return BigInt(value);
		}
		throw new Error(`json codec: invalid ${dataType} scalar ${JSON.stringify(value)}`);
	}
	return value;
}

/** Nest a flat C-order scalar list by shape. */
function nest(flat: unknown[], shape: number[]): unknown {
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

function makeTypedArray(dataType: string, scalars: unknown[]): TypedArray<DataType> {
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

/** Array->bytes codec encoding chunks as canonical UTF-8 JSON arrays. */
export class JsonSerializer {
	readonly kind = "array_to_bytes" as const;
	#dataType: DataType;
	#shape: number[];

	constructor(meta: ChunkMeta) {
		this.#dataType = meta.dataType;
		this.#shape = meta.shape;
	}

	static fromConfig(_config: unknown, meta: ChunkMeta): JsonSerializer {
		return new JsonSerializer(meta);
	}

	encode(chunk: Chunk<DataType>): Uint8Array {
		// chunk.data is C-contiguous when handed to an array->bytes codec
		// (same assumption zarrita's own bytes codec makes).
		const flat = Array.from(
			chunk.data as Iterable<unknown>,
			(v) => toJsonScalar(v, this.#dataType),
		);
		const text = canonicalStringify(nest(flat, chunk.shape));
		return UTF8_ENCODER.encode(text);
	}

	decode(bytes: Uint8Array): Chunk<DataType> {
		const nested: unknown = JSON.parse(UTF8_DECODER.decode(bytes));
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
