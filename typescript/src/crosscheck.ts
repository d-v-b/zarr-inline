/**
 * Cross-language array crosscheck harness (zarrita side).
 *
 * See DESIGN.md section 6.2 (write/read) and 6.3 (trace). All conversions
 * between payload JSON and native arrays go through the json codec itself
 * (JsonSerializer.encode / decode), so what this harness accepts is
 * definitionally what the codec accepts: strict scalar sorts, finite ranges,
 * exact nesting. Harness-level rules (in-bounds regions, valid initial
 * documents, group-only parents, explicit zero fill, supported dtypes)
 * follow the trace input contract in DESIGN.md section 6.3.
 *
 * Run: node dist/crosscheck.js write|read|trace  (reads stdin, writes stdout)
 */

import { pathToFileURL } from "node:url";

import * as zarr from "zarrita";
import type { Chunk, CodecMetadata, DataType, Scalar } from "zarrita";

import { MemoryBacking, type Document } from "./backing.js";
import {
	METADATA_SUFFIX,
	canonicalStringify,
	compareCodePoints,
	isMetadataKey,
	strictParse,
} from "./document.js";
import {
	JsonSerializer,
	cStrides,
	chunkElements,
	makeTypedArray,
	registerJsonCodec,
} from "./serializer.js";
import { ZarrInlineStore } from "./store.js";

registerJsonCodec();

interface ArraySpec {
	path: string;
	dtype: string;
	shape: number[];
	chunks: number[];
	shards?: number[][];
	data: unknown;
}

interface Payload {
	arrays: ArraySpec[];
}

interface TraceOperation {
	op: "create_array" | "write_region" | "read_region";
	path: string;
	dtype?: string;
	shape: unknown;
	chunks?: unknown;
	shards?: unknown;
	origin?: unknown;
	data?: unknown;
}

interface TracePayload {
	document?: Document;
	operations: TraceOperation[];
}

/**
 * Zarr v3 fill_value written into metadata for each supported dtype: the
 * dtype's zero value, explicitly, for every array this harness creates.
 * Creating an array of any other dtype is an error (never a null fill).
 */
const ZERO_FILL: Record<string, unknown> = {
	bool: false,
	int32: 0,
	int64: 0,
	uint8: 0,
	float32: 0,
	float64: 0,
};

const PORTABLE_DTYPES = new Set(Object.keys(ZERO_FILL));
const MAX_SAFE_DIMENSION = BigInt(Number.MAX_SAFE_INTEGER);

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

type ShardingConfiguration = {
	chunk_shape: number[];
	codecs: CodecMetadata[];
	index_codecs: CodecMetadata[];
	index_location?: "start" | "end";
};

type ShardingMeta = {
	dataType: DataType;
	shape: number[];
	codecs: CodecMetadata[];
	fillValue: unknown;
};

const MAX_UINT64 = 2n ** 64n - 1n;

function product(shape: number[]): number {
	return shape.reduce((value, extent) => value * extent, 1);
}

function unravel(linear: number, shape: number[]): number[] {
	const coordinates = new Array<number>(shape.length);
	for (let axis = shape.length - 1; axis >= 0; axis--) {
		coordinates[axis] = linear % shape[axis];
		linear = Math.floor(linear / shape[axis]);
	}
	return coordinates;
}

function decodeNestedCodec(
	bytes: Uint8Array,
	shape: number[],
	codecs: CodecMetadata[],
	dataType: DataType,
	fillValue: unknown,
): Chunk<DataType> {
	if (codecs.length !== 1) {
		throw new Error("nested sharding conformance supports one inner codec per level");
	}
	const [codec] = codecs;
	const meta: ShardingMeta = { dataType, shape, codecs, fillValue };
	if (codec.name === "json") {
		return JsonSerializer.fromConfig(codec.configuration, meta).decode(bytes);
	}
	if (codec.name === "sharding_indexed") {
		return NestedShardingDecoder.fromConfig(codec.configuration, meta).decode(bytes);
	}
	throw new Error(`unsupported nested sharding codec ${JSON.stringify(codec.name)}`);
}

/**
 * Zarrita handles the outer sharding layer itself. This codec supplies the
 * missing recursive array-to-bytes step when another sharding_indexed codec
 * appears inside it, decoding a complete inner shard from the bytes returned
 * by the outer layer.
 */
class NestedShardingDecoder {
	readonly kind = "array_to_bytes" as const;
	#configuration: ShardingConfiguration;
	#meta: ShardingMeta;

	constructor(configuration: ShardingConfiguration, meta: ShardingMeta) {
		this.#configuration = configuration;
		this.#meta = meta;
	}

	static fromConfig(configuration: unknown, meta: ShardingMeta): NestedShardingDecoder {
		if (!isPlainObject(configuration)) {
			throw new Error("sharding_indexed configuration must be an object");
		}
		return new NestedShardingDecoder(
			configuration as unknown as ShardingConfiguration,
			meta,
		);
	}

	encode(): never {
		throw new Error("zarrita does not support writing sharded arrays");
	}

	decode(bytes: Uint8Array): Chunk<DataType> {
		const { chunk_shape: innerShape, codecs, index_codecs: indexCodecs } =
			this.#configuration;
		const shardShape = this.#meta.shape;
		if (
			!Array.isArray(innerShape) ||
			innerShape.length !== shardShape.length ||
			innerShape.some(
				(extent, axis) =>
					!Number.isSafeInteger(extent) ||
					extent < 1 ||
					shardShape[axis] % extent !== 0,
			)
		) {
			throw new Error("nested sharding chunk_shape must evenly divide its shard");
		}
		if (this.#configuration.index_location !== "end") {
			throw new Error("nested sharding conformance requires index_location=end");
		}
		if (
			!Array.isArray(indexCodecs) ||
			indexCodecs.length < 1 ||
			indexCodecs[0].name !== "bytes" ||
			indexCodecs.slice(1).some((codec) => codec.name !== "crc32c")
		) {
			throw new Error("nested sharding conformance requires bytes + optional crc32c index codecs");
		}

		const gridShape = shardShape.map((extent, axis) => extent / innerShape[axis]);
		const entryCount = product(gridShape);
		const indexSize = entryCount * 16 + 4 * (indexCodecs.length - 1);
		if (bytes.byteLength < indexSize) {
			throw new Error("nested shard is shorter than its index");
		}
		const indexOffset = bytes.byteLength - indexSize;
		const index = new DataView(
			bytes.buffer,
			bytes.byteOffset + indexOffset,
			entryCount * 16,
		);
		const fill = this.#meta.fillValue ?? ZERO_FILL[this.#meta.dataType];
		const output = new Array<unknown>(product(shardShape)).fill(fill);
		const outputStride = cStrides(shardShape);

		for (let entry = 0; entry < entryCount; entry++) {
			const offset = index.getBigUint64(entry * 16, true);
			const length = index.getBigUint64(entry * 16 + 8, true);
			if (offset === MAX_UINT64 && length === MAX_UINT64) continue;
			if (offset > BigInt(Number.MAX_SAFE_INTEGER) || length > BigInt(Number.MAX_SAFE_INTEGER)) {
				throw new Error("nested shard index exceeds JavaScript's safe byte range");
			}
			const start = Number(offset);
			const end = start + Number(length);
			if (start < 0 || end > indexOffset) {
				throw new Error("nested shard index points outside the data section");
			}
			const inner = decodeNestedCodec(
				bytes.subarray(start, end),
				innerShape,
				codecs,
				this.#meta.dataType,
				fill,
			);
			const chunkCoordinate = unravel(entry, gridShape);
			const elements = chunkElements(inner);
			for (let element = 0; element < elements.length; element++) {
				const local = unravel(element, innerShape);
				let outputOffset = 0;
				for (let axis = 0; axis < shardShape.length; axis++) {
					outputOffset +=
						(chunkCoordinate[axis] * innerShape[axis] + local[axis]) *
						outputStride[axis];
				}
				output[outputOffset] = elements[element];
			}
		}

		return {
			data: makeTypedArray(this.#meta.dataType, output),
			shape: shardShape,
			stride: outputStride,
		};
	}
}

type RegistryValue = Parameters<typeof zarr.registry.set>[1];
zarr.registry.set(
	"sharding_indexed",
	(async () => NestedShardingDecoder) as unknown as RegistryValue,
);

/**
 * Serialize payload JSON SORT-PRESERVING for the codec's decoder: bigint
 * (integer tokens, from integersAsBigInt parsing) as digits, and every JS
 * number as a FLOAT token (integral numbers get a ".0"), so a payload float
 * like 1.0 is still rejected for integer dtypes (SPEC 9.2). Canonical
 * serialization would launder 1.0 into the integer token 1.
 */
function payloadStringify(value: unknown): string {
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error("payload numbers must be finite (use the string forms)");
		}
		const text = String(value);
		return /^-?\d+$/.test(text) ? `${text}.0` : text;
	}
	if (Array.isArray(value)) {
		return `[${value.map(payloadStringify).join(",")}]`;
	}
	if (value === null || typeof value === "boolean" || typeof value === "string") {
		return JSON.stringify(value);
	}
	throw new Error(`unsupported payload value: ${String(value)}`);
}

function codecFor(dtype: string, shape: number[]): JsonSerializer {
	return new JsonSerializer({
		dataType: dtype as DataType,
		shape,
		codecs: [],
		fillValue: null,
	});
}

/** Payload JSON -> native chunk, via the codec's decoder. */
function toNative(data: unknown, shape: number[], dtype: string): Chunk<DataType> {
	return codecFor(dtype, shape).decode(UTF8_ENCODER.encode(payloadStringify(data)));
}

/** Native chunk -> payload JSON, via the codec's encoder. */
function toJson(chunk: Chunk<DataType>, dtype: string): unknown {
	return strictParse(UTF8_DECODER.decode(codecFor(dtype, chunk.shape).encode(chunk)));
}

/** zarr.get result (scalar for rank 0, chunk otherwise) as a chunk. */
function asChunk(value: unknown, shape: number[], dtype: string): Chunk<DataType> {
	if (shape.length === 0) {
		return { data: makeTypedArray(dtype, [value]), shape: [], stride: [] };
	}
	return value as Chunk<DataType>;
}

async function setRegion(
	arr: zarr.Array<DataType, ZarrInlineStore>,
	selection: (number | zarr.Slice | null)[] | null,
	data: unknown,
	shape: number[],
	dtype: string,
): Promise<void> {
	const chunk = toNative(data, shape, dtype);
	if (shape.length === 0) {
		await zarr.set(arr, null, chunkElements(chunk)[0] as Scalar<DataType>);
	} else {
		await zarr.set(arr, selection, chunk);
	}
}

async function getRegion(
	arr: zarr.Array<DataType, ZarrInlineStore>,
	selection: (number | zarr.Slice | null)[] | null,
	shape: number[],
	dtype: string,
): Promise<unknown> {
	const out = selection === null ? await zarr.get(arr) : await zarr.get(arr, selection);
	return toJson(asChunk(out, shape, dtype), dtype);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The node_type of the metadata document at `key`, or undefined if absent. */
function nodeType(document: Document, key: string): string | undefined {
	const value = document[key];
	if (!isPlainObject(value)) {
		return undefined;
	}
	return typeof value.node_type === "string" ? value.node_type : "";
}

/**
 * Create the root and every ancestor group of `path` that does not exist,
 * refusing (like zarr-python) to place a node beneath an array or to
 * overwrite an existing node.
 */
async function ensureParents(
	backing: MemoryBacking,
	root: zarr.Location<ZarrInlineStore>,
	path: string,
): Promise<void> {
	const document = backing.load();
	const check = (key: string, label: string): boolean => {
		const type = nodeType(document, key);
		if (type === undefined) {
			return false;
		}
		if (type !== "group") {
			throw new Error(`cannot create ${path}: ${label} is not a group`);
		}
		return true;
	};
	if (!check(METADATA_SUFFIX, "the root")) {
		await zarr.create(root);
	}
	const segments = path.split("/");
	for (let depth = 1; depth < segments.length; depth++) {
		const ancestor = segments.slice(0, depth).join("/");
		if (!check(`${ancestor}/${METADATA_SUFFIX}`, `parent ${ancestor}`)) {
			await zarr.create(root.resolve(ancestor));
		}
	}
	if (nodeType(document, `${path}/${METADATA_SUFFIX}`) !== undefined) {
		throw new Error(`cannot create ${path}: a node already exists there`);
	}
}

async function createArray(
	backing: MemoryBacking,
	root: zarr.Location<ZarrInlineStore>,
	path: string,
	dtype: string,
	shape: number[],
	chunks: number[],
): Promise<zarr.Array<DataType, ZarrInlineStore>> {
	if (!(dtype in ZERO_FILL)) {
		throw new Error(`unsupported dtype ${JSON.stringify(dtype)} for this harness`);
	}
	await ensureParents(backing, root, path);
	return zarr.create(root.resolve(path), {
		shape,
		chunkShape: chunks,
		dtype: dtype as DataType,
		codecs: [{ name: "json", configuration: {} }],
		fillValue: ZERO_FILL[dtype] as Scalar<DataType>,
	});
}

/** Validate exact integer tokens before converting them to host-safe numbers. */
function intList(value: unknown, what: string, minValue: number): number[] {
	if (
		!Array.isArray(value) ||
		!value.every(
			(v) =>
				typeof v === "bigint" &&
				v >= BigInt(minValue) &&
				v <= MAX_SAFE_DIMENSION,
		)
	) {
		throw new Error(
			`${what} must be a list of integer tokens in ` +
				`[${minValue}, ${MAX_SAFE_DIMENSION}]`,
		);
	}
	return value.map(Number);
}

function shardShapes(value: unknown, chunks: number[], what: string): number[][] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new Error(`${what} must be a list of shard shapes`);
	}
	const result: number[][] = [];
	let inner = chunks;
	for (let level = 0; level < value.length; level++) {
		const shard = intList(value[level], `${what}[${level}]`, 1);
		if (
			shard.length !== inner.length ||
			shard.some((extent, axis) => extent % inner[axis] !== 0)
		) {
			throw new Error(
				`${what}[${level}] must match the rank of and be evenly divisible by ` +
					"the preceding chunk shape",
			);
		}
		result.push(shard);
		inner = shard;
	}
	return result;
}

function arrayLayout(document: Document, path: string): {
	chunks: number[];
	shards: number[][];
} {
	const metadata = document[`${path}/${METADATA_SUFFIX}`];
	if (!isPlainObject(metadata)) throw new Error(`array ${path}: invalid metadata`);
	const chunkGrid = metadata.chunk_grid;
	if (!isPlainObject(chunkGrid) || !isPlainObject(chunkGrid.configuration)) {
		throw new Error(`array ${path}: invalid chunk grid`);
	}
	let current = (chunkGrid.configuration.chunk_shape as unknown[]).map(Number);
	let codecs = metadata.codecs as unknown[];
	const outerToInner: number[][] = [];
	while (
		Array.isArray(codecs) &&
		codecs.length === 1 &&
		isPlainObject(codecs[0]) &&
		codecs[0].name === "sharding_indexed"
	) {
		outerToInner.push(current);
		const configuration = codecs[0].configuration;
		if (!isPlainObject(configuration) || !Array.isArray(configuration.chunk_shape)) {
			throw new Error(`array ${path}: invalid sharding configuration`);
		}
		current = configuration.chunk_shape.map(Number);
		codecs = configuration.codecs as unknown[];
	}
	return { chunks: current, shards: outerToInner.reverse() };
}

function portablePath(value: unknown, what: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${what} must be a non-empty string`);
	}
	const invalid = value
		.split("/")
		.some(
			(segment) =>
				segment.length === 0 || segment.startsWith("__") || /^\.+$/.test(segment),
		);
	if (invalid) {
		throw new Error(
			`${what} must be a portable relative Zarr node path ` +
				"(no empty, reserved '__', or all-period segments)",
		);
	}
	return value;
}

function portableDtype(value: unknown, what: string): string {
	if (typeof value !== "string" || !PORTABLE_DTYPES.has(value)) {
		throw new Error(`${what} must be one of: ${[...PORTABLE_DTYPES].sort().join(", ")}`);
	}
	return value;
}

async function write(payload: Payload): Promise<Document> {
	const backing = new MemoryBacking({});
	const store = new ZarrInlineStore(backing);
	const root = zarr.root(store);
	for (const spec of payload.arrays) {
		const path = portablePath(spec.path, "array path");
		const dtype = portableDtype(spec.dtype, `array ${path}: dtype`);
		const shape = intList(spec.shape, `array ${path}: shape`, 0);
		const chunks = intList(spec.chunks, `array ${path}: chunks`, 1);
		const shards = shardShapes(spec.shards, chunks, `array ${path}: shards`);
		if (shards.length > 0) {
			throw new Error("zarrita does not support writing sharded arrays");
		}
		const arr = await createArray(backing, root, path, dtype, shape, chunks);
		await setRegion(arr, null, spec.data, shape, dtype);
	}
	return backing.load();
}

async function read(document: Document): Promise<Payload> {
	const store = new ZarrInlineStore(new MemoryBacking(document), {
		readOnly: true,
	});
	const root = zarr.root(store);
	const suffix = "/" + METADATA_SUFFIX;
	const paths = Object.entries(document)
		.filter(
			([key, value]) =>
				key !== METADATA_SUFFIX &&
				isMetadataKey(key) &&
				isPlainObject(value) &&
				value.node_type === "array",
		)
		.map(([key]) => key.slice(0, -suffix.length))
		.sort(compareCodePoints);
	const arrays: ArraySpec[] = [];
	for (const path of paths) {
		const arr = await zarr.open.v3(root.resolve(path), { kind: "array" });
		const dtype = arr.dtype as string;
		const shape = [...arr.shape];
		const { chunks, shards } = arrayLayout(document, path);
		const data = await getRegion(arr, null, shape, dtype);
		const entry: ArraySpec = { path, dtype, shape, chunks, data };
		if (shards.length > 0) entry.shards = shards;
		arrays.push(entry);
	}
	return { arrays };
}

/**
 * Validate a region against the array (DESIGN 6.3): same rank, every extent
 * >= 1, and origin + shape within the array shape.
 */
function region(
	operation: TraceOperation,
	arr: zarr.Array<DataType, ZarrInlineStore>,
	index: number,
): { shape: number[]; selection: zarr.Slice[] | null } {
	const origin = intList(operation.origin, `operation ${index}: origin`, 0);
	const shape = intList(operation.shape, `operation ${index}: shape`, 1);
	if (origin.length !== arr.shape.length || shape.length !== arr.shape.length) {
		throw new Error(`operation ${index}: region dimensionality mismatch`);
	}
	for (let axis = 0; axis < shape.length; axis++) {
		const start = origin[axis];
		const size = shape[axis];
		const extent = arr.shape[axis];
		if (start > extent || size > extent - start) {
			throw new Error(
				`operation ${index}: region starting at ${start} with size ${size} ` +
					`exceeds array extent ${extent} on axis ${axis}`,
			);
		}
	}
	if (shape.length === 0) {
		return { shape, selection: null };
	}
	return {
		shape,
		selection: origin.map((start, axis) => zarr.slice(start, start + shape[axis])),
	};
}

async function trace(
	payload: TracePayload,
): Promise<{ document: Document; reads: unknown[] }> {
	if (payload.document !== undefined && !isPlainObject(payload.document)) {
		throw new Error("trace document must be an object");
	}
	if (!Array.isArray(payload.operations)) {
		throw new Error("trace payload needs an operations array");
	}
	const backing = new MemoryBacking(payload.document ?? {});
	let store: ZarrInlineStore;
	try {
		// The initial document MUST be valid (DESIGN 6.3).
		store = new ZarrInlineStore(backing, { strict: true });
	} catch (err) {
		throw new Error(`invalid initial document: ${String(err)}`);
	}
	const root = zarr.root(store);
	const reads: unknown[] = [];

	for (let index = 0; index < payload.operations.length; index++) {
		const operation = payload.operations[index];
		const path = portablePath(operation?.path, `operation ${index}: path`);
		if (operation.op === "create_array") {
			const dtype = portableDtype(operation.dtype, `operation ${index}: dtype`);
			const shape = intList(operation.shape, `operation ${index}: shape`, 0);
			const chunks = intList(operation.chunks, `operation ${index}: chunks`, 1);
			const shards = shardShapes(
				operation.shards,
				chunks,
				`operation ${index}: shards`,
			);
			if (shards.length > 0) {
				throw new Error("zarrita does not support writing sharded arrays");
			}
			await createArray(backing, root, path, dtype, shape, chunks);
			continue;
		}
		if (operation.op !== "write_region" && operation.op !== "read_region") {
			throw new Error(`operation ${index}: unknown op ${String(operation.op)}`);
		}
		const arr = await zarr.open.v3(root.resolve(path), { kind: "array" });
		const { shape, selection } = region(operation, arr, index);
		const dtype = arr.dtype as string;
		if (operation.op === "write_region") {
			if (!("data" in operation)) {
				throw new Error(`operation ${index}: write_region needs data`);
			}
			await setRegion(arr, selection, operation.data, shape, dtype);
		} else {
			reads.push({ operation: index, data: await getRegion(arr, selection, shape, dtype) });
		}
	}
	return { document: backing.load(), reads };
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf-8");
}

async function main(): Promise<number> {
	const mode = process.argv[2];
	if (
		process.argv.length !== 3 ||
		(mode !== "write" && mode !== "read" && mode !== "trace")
	) {
		process.stderr.write("usage: node crosscheck.js write|read|trace\n");
		return 1;
	}
	let result: unknown;
	try {
		const text = await readStdin();
		if (mode === "read") {
			const input = strictParse(text);
			if (!isPlainObject(input)) {
				throw new Error("input must be a JSON object");
			}
			result = await read(input);
		} else {
			// integersAsBigInt: payload data keeps its number sort (integer
			// tokens -> bigint) for the codec's strict decoder; shape-like
			// lists are converted back to numbers by intList.
			const input = strictParse(text, { integersAsBigInt: true });
			if (!isPlainObject(input)) {
				throw new Error("input must be a JSON object");
			}
			result =
				mode === "write"
					? await write(input as unknown as Payload)
					: await trace(input as unknown as TracePayload);
		}
	} catch (err) {
		process.stderr.write(`crosscheck ${mode} failed: ${String(err)}\n`);
		return 1;
	}
	process.stdout.write(canonicalStringify(result));
	return 0;
}

// Only run the CLI when executed directly (not when imported by tests).
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
	main().then((code) => {
		process.exitCode = code;
	});
}

export { read, trace, write, type ArraySpec, type Payload, type TracePayload };
