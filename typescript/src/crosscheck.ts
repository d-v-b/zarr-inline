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
import type { Chunk, DataType, Scalar } from "zarrita";

import { MemoryBacking, type Document } from "./backing.js";
import {
	METADATA_SUFFIX,
	canonicalStringify,
	compareCodePoints,
	isMetadataKey,
	strictParse,
} from "./codec.js";
import {
	JsonSerializer,
	cStrides,
	chunkElements,
	makeTypedArray,
	registerJsonCodec,
} from "./serializer.js";
import { ZarrJsonStore } from "./store.js";

registerJsonCodec();

interface ArraySpec {
	path: string;
	dtype: string;
	shape: number[];
	chunks: number[];
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
	int8: 0,
	int16: 0,
	int32: 0,
	int64: 0,
	uint8: 0,
	uint16: 0,
	uint32: 0,
	uint64: 0,
	float32: 0,
	float64: 0,
};

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

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
	arr: zarr.Array<DataType, ZarrJsonStore>,
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
	arr: zarr.Array<DataType, ZarrJsonStore>,
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
	root: zarr.Location<ZarrJsonStore>,
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
	root: zarr.Location<ZarrJsonStore>,
	path: string,
	dtype: string,
	shape: number[],
	chunks: number[],
): Promise<zarr.Array<DataType, ZarrJsonStore>> {
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

/** Validate a list of integers (bigint or number) with a lower bound. */
function intList(value: unknown, what: string, minValue: number): number[] {
	if (
		!Array.isArray(value) ||
		!value.every(
			(v) =>
				(typeof v === "bigint" && v >= BigInt(minValue)) ||
				(typeof v === "number" && Number.isInteger(v) && v >= minValue),
		)
	) {
		throw new Error(`${what} must be a list of integers >= ${minValue}`);
	}
	return value.map(Number);
}

async function write(payload: Payload): Promise<Document> {
	const backing = new MemoryBacking({});
	const store = new ZarrJsonStore(backing);
	const root = zarr.root(store);
	for (const spec of payload.arrays) {
		const shape = intList(spec.shape, `array ${spec.path}: shape`, 0);
		const chunks = intList(spec.chunks, `array ${spec.path}: chunks`, 1);
		const arr = await createArray(backing, root, spec.path, spec.dtype, shape, chunks);
		await setRegion(arr, null, spec.data, shape, spec.dtype);
	}
	return backing.load();
}

async function read(document: Document): Promise<Payload> {
	const store = new ZarrJsonStore(new MemoryBacking(document), {
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
		const chunks = [...arr.chunks];
		const data = await getRegion(arr, null, shape, dtype);
		arrays.push({ path, dtype, shape, chunks, data });
	}
	return { arrays };
}

/**
 * Validate a region against the array (DESIGN 6.3): same rank, every extent
 * >= 1, and origin + shape within the array shape.
 */
function region(
	operation: TraceOperation,
	arr: zarr.Array<DataType, ZarrJsonStore>,
	index: number,
): { shape: number[]; selection: zarr.Slice[] | null } {
	const origin = intList(operation.origin, `operation ${index}: origin`, 0);
	const shape = intList(operation.shape, `operation ${index}: shape`, 1);
	if (origin.length !== arr.shape.length || shape.length !== arr.shape.length) {
		throw new Error(`operation ${index}: region dimensionality mismatch`);
	}
	for (let axis = 0; axis < shape.length; axis++) {
		const end = origin[axis] + shape[axis];
		if (end > arr.shape[axis]) {
			throw new Error(
				`operation ${index}: region [${origin[axis]}, ${end}) exceeds array ` +
					`extent ${arr.shape[axis]} on axis ${axis}`,
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
	let store: ZarrJsonStore;
	try {
		// The initial document MUST be valid (DESIGN 6.3).
		store = new ZarrJsonStore(backing, { strict: true });
	} catch (err) {
		throw new Error(`invalid initial document: ${String(err)}`);
	}
	const root = zarr.root(store);
	const reads: unknown[] = [];

	for (let index = 0; index < payload.operations.length; index++) {
		const operation = payload.operations[index];
		if (!operation || typeof operation.path !== "string" || operation.path.length === 0) {
			throw new Error(`operation ${index}: path must be a non-empty string`);
		}
		if (operation.op === "create_array") {
			if (typeof operation.dtype !== "string") {
				throw new Error(`operation ${index}: create_array needs dtype`);
			}
			const shape = intList(operation.shape, `operation ${index}: shape`, 0);
			const chunks = intList(operation.chunks, `operation ${index}: chunks`, 1);
			await createArray(backing, root, operation.path, operation.dtype, shape, chunks);
			continue;
		}
		if (operation.op !== "write_region" && operation.op !== "read_region") {
			throw new Error(`operation ${index}: unknown op ${String(operation.op)}`);
		}
		const arr = await zarr.open.v3(root.resolve(operation.path), { kind: "array" });
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
