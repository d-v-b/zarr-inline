/**
 * Cross-language array crosscheck harness (zarrita side).
 *
 * See DESIGN.md section 6.2. `write` turns
 * a payload of arrays into a zarr-json document by driving zarrita with the
 * json codec; `read` opens every array in a document and reports its values
 * using the fill_value scalar serialization, so payloads compare exactly
 * across languages (non-finite floats are the strings "NaN" etc.).
 * `trace` executes the operation-trace protocol from DESIGN.md section 6.3.
 *
 * Run: node dist/crosscheck.js write|read|trace  (reads stdin, writes stdout)
 */

import { pathToFileURL } from "node:url";

import * as zarr from "zarrita";
import type { DataType, Scalar } from "zarrita";

import { MemoryBacking, type Document } from "./backing.js";
import {
	METADATA_SUFFIX,
	canonicalStringify,
	compareCodePoints,
	isMetadataKey,
	strictParse,
} from "./codec.js";
import {
	cStrides,
	chunkElements,
	fromJsonScalar,
	makeTypedArray,
	nest,
	registerJsonCodec,
	toJsonScalar,
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
	shape: number[];
	chunks?: number[];
	origin?: number[];
	data?: unknown;
}

interface TracePayload {
	document?: Document;
	operations: TraceOperation[];
}

/** Zarr v3 fill_value written into metadata for each portable dtype. */
const METADATA_FILL: Record<string, unknown> = {
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

/** Flatten nested payload data to a C-order scalar list, driven by shape. */
function flattenPayload(nested: unknown, shape: number[]): unknown[] {
	if (shape.length === 0) {
		return [nested];
	}
	if (!Array.isArray(nested) || nested.length !== shape[0]) {
		throw new Error(`payload data does not match shape [${shape.join(",")}]`);
	}
	if (shape.length === 1) {
		return [...nested];
	}
	const out: unknown[] = [];
	for (const sub of nested) {
		out.push(...flattenPayload(sub, shape.slice(1)));
	}
	return out;
}

/** Group paths (excluding the root) that must exist for `path` to nest. */
function ancestorGroups(paths: string[]): string[] {
	const groups = new Set<string>();
	for (const path of paths) {
		const segments = path.split("/");
		for (let i = 1; i < segments.length; i++) {
			groups.add(segments.slice(0, i).join("/"));
		}
	}
	return [...groups].sort(compareCodePoints);
}

async function write(payload: Payload): Promise<Document> {
	const backing = new MemoryBacking({});
	const store = new ZarrJsonStore(backing);
	const root = zarr.root(store);
	await zarr.create(root);
	// Explicit metadata for intermediate groups (e.g. "grp" for "grp/i64"),
	// matching what zarr-python and zarrs write.
	for (const group of ancestorGroups(payload.arrays.map((a) => a.path))) {
		await zarr.create(root.resolve(group));
	}
	for (const rawSpec of payload.arrays) {
		// shape/chunks were parsed as bigint (integersAsBigInt); zarrita wants numbers.
		const spec: ArraySpec = {
			...rawSpec,
			shape: rawSpec.shape.map(Number),
			chunks: rawSpec.chunks.map(Number),
		};
		const dtype = spec.dtype as DataType;
		const arr = await zarr.create(root.resolve(spec.path), {
			shape: spec.shape,
			chunkShape: spec.chunks,
			dtype,
			codecs: [{ name: "json", configuration: {} }],
			fillValue: METADATA_FILL[spec.dtype] as Scalar<DataType>,
		});
		// Payload data is harness input, not chunk bytes: integer-valued JS
		// numbers (from literal payloads) are promoted to integer tokens for
		// integer dtypes; CLI input already arrives sort-preserved.
		const isIntType = !/^(float|bool)/.test(spec.dtype);
		const scalars = flattenPayload(spec.data, spec.shape).map((v) =>
			fromJsonScalar(
				isIntType && typeof v === "number" && Number.isInteger(v) ? BigInt(v) : v,
				spec.dtype,
			),
		);
		if (spec.shape.length === 0) {
			await zarr.set(arr, null, scalars[0] as Scalar<DataType>);
		} else {
			await zarr.set(arr, null, {
				data: makeTypedArray(spec.dtype, scalars),
				shape: spec.shape,
				stride: cStrides(spec.shape),
			});
		}
	}
	return backing.load();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
		let data: unknown;
		if (shape.length === 0) {
			data = toJsonScalar(await zarr.get(arr), dtype);
		} else {
			const out = await zarr.get(arr);
			const flat = chunkElements(out).map((v) => toJsonScalar(v, dtype));
			data = nest(flat, shape);
		}
		arrays.push({ path, dtype, shape, chunks, data });
	}
	return { arrays };
}

async function trace(
	payload: TracePayload,
): Promise<{ document: Document; reads: unknown[] }> {
	const backing = new MemoryBacking(payload.document ?? {});
	const store = new ZarrJsonStore(backing);
	const root = zarr.root(store);
	const reads: unknown[] = [];

	for (let index = 0; index < payload.operations.length; index++) {
		const operation = payload.operations[index];
		if (!operation || typeof operation.path !== "string" || operation.path.length === 0) {
			throw new Error(`operation ${index}: path must be a non-empty string`);
		}
		if (operation.op === "create_array") {
			if (!(await store.has(`/${METADATA_SUFFIX}`))) {
				await zarr.create(root);
			}
			for (const group of ancestorGroups([operation.path])) {
				if (!(await store.has(`/${group}/${METADATA_SUFFIX}`))) {
					await zarr.create(root.resolve(group));
				}
			}
			if (!operation.dtype || !operation.chunks) {
				throw new Error(`operation ${index}: create_array needs dtype and chunks`);
			}
			const dtype = operation.dtype as DataType;
			await zarr.create(root.resolve(operation.path), {
				shape: operation.shape.map(Number),
				chunkShape: operation.chunks.map(Number),
				dtype,
				codecs: [{ name: "json", configuration: {} }],
				fillValue: METADATA_FILL[operation.dtype] as Scalar<DataType>,
			});
			continue;
		}

		if (operation.op !== "write_region" && operation.op !== "read_region") {
			throw new Error(`operation ${index}: unknown op ${String(operation.op)}`);
		}
		if (!operation.origin) {
			throw new Error(`operation ${index}: region needs origin`);
		}
		const arr = await zarr.open.v3(root.resolve(operation.path), { kind: "array" });
		const shape = operation.shape.map(Number);
		const origin = operation.origin.map(Number);
		if (shape.length !== arr.shape.length || origin.length !== arr.shape.length) {
			throw new Error(`operation ${index}: region dimensionality mismatch`);
		}
		const selection = origin.map((start, axis) =>
			zarr.slice(start, start + shape[axis]),
		);
		const dtype = arr.dtype as string;
		if (operation.op === "write_region") {
			const isIntType = !/^(float|bool)/.test(dtype);
			const scalars = flattenPayload(operation.data, shape).map((value) =>
				fromJsonScalar(
					isIntType && typeof value === "number" && Number.isInteger(value)
						? BigInt(value)
						: value,
					dtype,
				),
			);
			if (shape.length === 0) {
				await zarr.set(arr, null, scalars[0] as Scalar<DataType>);
			} else {
				await zarr.set(arr, selection, {
					data: makeTypedArray(dtype, scalars),
					shape,
					stride: cStrides(shape),
				});
			}
		} else if (shape.length === 0) {
			reads.push({ operation: index, data: toJsonScalar(await zarr.get(arr), dtype) });
		} else {
			const out = await zarr.get(arr, selection);
			const flat = chunkElements(out).map((value) => toJsonScalar(value, dtype));
			reads.push({ operation: index, data: nest(flat, shape) });
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
		if (mode === "write" || mode === "trace") {
			// integersAsBigInt so payload data elements carry their number
			// sort for fromJsonScalar (integer tokens -> bigint); shape and
			// chunks are converted back to plain numbers in write().
			const input = strictParse(text, { integersAsBigInt: true });
			if (!isPlainObject(input)) {
				throw new Error("input must be a JSON object");
			}
			result =
				mode === "write"
					? await write(input as unknown as Payload)
					: await trace(input as unknown as TracePayload);
		} else {
			const input = strictParse(text);
			if (!isPlainObject(input)) {
				throw new Error("input must be a JSON object");
			}
			result = await read(input);
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
