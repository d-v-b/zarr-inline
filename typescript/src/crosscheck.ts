/**
 * Cross-language array crosscheck harness (zarrita side).
 *
 * See docs/superpowers/specs/2026-08-20-crosscheck-protocol.md. `write` turns
 * a payload of arrays into a zarr-json document by driving zarrita with the
 * json codec; `read` opens every array in a document and reports its values
 * using the fill_value scalar serialization, so payloads compare exactly
 * across languages (non-finite floats are the strings "NaN" etc.).
 *
 * Run: node dist/crosscheck.js write|read  (reads stdin, writes stdout)
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
	for (const spec of payload.arrays) {
		const dtype = spec.dtype as DataType;
		const arr = await zarr.create(root.resolve(spec.path), {
			shape: spec.shape,
			chunkShape: spec.chunks,
			dtype,
			codecs: [{ name: "json", configuration: {} }],
			fillValue: METADATA_FILL[spec.dtype] as Scalar<DataType>,
		});
		const scalars = flattenPayload(spec.data, spec.shape).map((v) =>
			fromJsonScalar(v, spec.dtype),
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

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf-8");
}

async function main(): Promise<number> {
	const mode = process.argv[2];
	if (process.argv.length !== 3 || (mode !== "write" && mode !== "read")) {
		process.stderr.write("usage: node crosscheck.js write|read\n");
		return 1;
	}
	let result: unknown;
	try {
		const input = strictParse(await readStdin());
		if (!isPlainObject(input)) {
			throw new Error("input must be a JSON object");
		}
		result =
			mode === "write"
				? await write(input as unknown as Payload)
				: await read(input);
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

export { read, write, type ArraySpec, type Payload };
