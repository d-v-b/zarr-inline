import assert from "node:assert/strict";
import { test } from "node:test";

import * as zarr from "zarrita";

import { MemoryBacking } from "../backing.js";
import {
	JsonSerializer,
	fromJsonScalar,
	registerJsonCodec,
} from "../serializer.js";
import { ZarrJsonStore } from "../store.js";

registerJsonCodec();

const JSON_CODECS = [{ name: "json", configuration: {} }];

test("uint8 chunks appear as inline JSON arrays and round-trip", async () => {
	const backing = new MemoryBacking({});
	const store = new ZarrJsonStore(backing);
	const root = zarr.root(store);
	await zarr.create(root);
	const arr = await zarr.create(root.resolve("data"), {
		shape: [2, 4],
		chunkShape: [2, 4],
		dtype: "uint8",
		codecs: JSON_CODECS,
	});
	const values = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
	await zarr.set(arr, null, { data: values, shape: [2, 4], stride: [4, 1] });

	const doc = backing.load();
	// The chunk is a real JSON array in the document, nested by shape.
	assert.deepEqual(doc["data/c/0/0"], [
		[0, 1, 2, 3],
		[4, 5, 6, 7],
	]);
	assert.deepEqual((doc["data/zarr.json"] as { codecs: unknown }).codecs, JSON_CODECS);

	// Read back through a JSON round-trip of the whole document.
	const store2 = new ZarrJsonStore(
		new MemoryBacking(JSON.parse(JSON.stringify(doc))),
	);
	const arr2 = await zarr.open(zarr.root(store2).resolve("data"), {
		kind: "array",
	});
	const out = await zarr.get(arr2);
	assert.deepEqual(new Uint8Array(out.data as Uint8Array), values);
});

test("float64 chunks serialize NaN/Infinity as strings and round-trip", async () => {
	const backing = new MemoryBacking({});
	const store = new ZarrJsonStore(backing);
	const root = zarr.root(store);
	await zarr.create(root);
	const arr = await zarr.create(root.resolve("data"), {
		shape: [4],
		chunkShape: [4],
		dtype: "float64",
		codecs: JSON_CODECS,
	});
	const values = Float64Array.from([1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]);
	await zarr.set(arr, null, { data: values, shape: [4], stride: [1] });

	const doc = backing.load();
	assert.deepEqual(doc["data/c/0"], [1.5, "NaN", "Infinity", "-Infinity"]);

	const store2 = new ZarrJsonStore(
		new MemoryBacking(JSON.parse(JSON.stringify(doc))),
	);
	const arr2 = await zarr.open(zarr.root(store2).resolve("data"), {
		kind: "array",
	});
	const out = await zarr.get(arr2);
	const got = new Float64Array(out.data as Float64Array);
	assert.equal(got[0], 1.5);
	assert.ok(Number.isNaN(got[1]));
	assert.equal(got[2], Number.POSITIVE_INFINITY);
	assert.equal(got[3], Number.NEGATIVE_INFINITY);
});

test("int64 chunks round-trip within Number.MAX_SAFE_INTEGER", async () => {
	const backing = new MemoryBacking({});
	const store = new ZarrJsonStore(backing);
	const root = zarr.root(store);
	await zarr.create(root);
	const arr = await zarr.create(root.resolve("data"), {
		shape: [2],
		chunkShape: [2],
		dtype: "int64",
		codecs: JSON_CODECS,
	});
	const values = BigInt64Array.from([123456789012345n, -1n]);
	await zarr.set(arr, null, { data: values, shape: [2], stride: [1] });

	const doc = backing.load();
	assert.deepEqual(doc["data/c/0"], [123456789012345, -1]);

	const store2 = new ZarrJsonStore(
		new MemoryBacking(JSON.parse(JSON.stringify(doc))),
	);
	const arr2 = await zarr.open(zarr.root(store2).resolve("data"), {
		kind: "array",
	});
	const out = await zarr.get(arr2);
	assert.deepEqual(new BigInt64Array(out.data as BigInt64Array), values);
});

test("bool chunks appear as true/false and round-trip", async () => {
	const backing = new MemoryBacking({});
	const store = new ZarrJsonStore(backing);
	const root = zarr.root(store);
	await zarr.create(root);
	const arr = await zarr.create(root.resolve("data"), {
		shape: [2],
		chunkShape: [2],
		dtype: "bool",
		codecs: JSON_CODECS,
	});
	await zarr.set(arr, null, {
		data: new zarr.BoolArray([true, false]),
		shape: [2],
		stride: [1],
	});

	const doc = backing.load();
	assert.deepEqual(doc["data/c/0"], [true, false]);

	const store2 = new ZarrJsonStore(
		new MemoryBacking(JSON.parse(JSON.stringify(doc))),
	);
	const arr2 = await zarr.open(zarr.root(store2).resolve("data"), {
		kind: "array",
	});
	const out = await zarr.get(arr2);
	assert.deepEqual(Array.from(out.data as zarr.BoolArray), [true, false]);
});

test("encode throws for int64 values beyond Number.MAX_SAFE_INTEGER", () => {
	const codec = JsonSerializer.fromConfig(
		{},
		{ dataType: "int64", shape: [1], codecs: [], fillValue: null },
	);
	assert.throws(
		() =>
			codec.encode({
				data: BigInt64Array.from([2n ** 60n + 1n]),
				shape: [1],
				stride: [1],
			}),
		/MAX_SAFE_INTEGER/,
	);
});

test("decode rejects JSON not matching chunk shape", () => {
	const codec = JsonSerializer.fromConfig(
		{},
		{ dataType: "uint8", shape: [2, 2], codecs: [], fillValue: null },
	);
	assert.throws(
		() => codec.decode(new TextEncoder().encode("[1,2,3]")),
		/chunk shape/,
	);
});

test("encode walks chunk.stride in C order of chunk.shape", () => {
	// A transpose codec earlier in the chain hands the array->bytes codec a
	// non-C-contiguous chunk; the emitted JSON must nest the logical
	// (shape-ordered) values, or peers cannot read the chunk back.
	const codec = JsonSerializer.fromConfig(
		{},
		{ dataType: "uint8", shape: [2, 3], codecs: [], fillValue: null },
	);
	const bytes = codec.encode({
		data: Uint8Array.from([1, 2, 3, 4, 5, 6]),
		shape: [2, 3],
		stride: [1, 2], // F-order memory: element (i, j) lives at i + 2*j
	});
	assert.equal(
		new TextDecoder().decode(bytes),
		"[[1,3,5],[2,4,6]]",
	);
});

test("fromJsonScalar accepts in-range scalars per dtype", () => {
	assert.equal(fromJsonScalar(-128, "int8"), -128);
	assert.equal(fromJsonScalar(255, "uint8"), 255);
	assert.equal(fromJsonScalar(-2147483648, "int32"), -2147483648);
	assert.equal(fromJsonScalar(9007199254740991, "int64"), 9007199254740991n);
	assert.equal(fromJsonScalar(-5, "int64"), -5n);
	assert.equal(fromJsonScalar(1.5, "float32"), 1.5);
	assert.ok(Number.isNaN(fromJsonScalar("NaN", "float64")));
	assert.equal(fromJsonScalar("Infinity", "float64"), Infinity);
	assert.equal(fromJsonScalar("-Infinity", "float64"), -Infinity);
	assert.equal(fromJsonScalar(true, "bool"), true);
});

test("fromJsonScalar rejects unsafe int64 values", () => {
	// JSON.parse of a peer's 9007199254740993 has already rounded to
	// ...992 (2^53, not a safe integer): BigInt of that would be silent
	// corruption, so it must throw instead.
	assert.throws(() => fromJsonScalar(2 ** 53, "int64"), /invalid int64/);
	assert.throws(() => fromJsonScalar(1.5, "int64"), /invalid int64/);
	assert.throws(() => fromJsonScalar("7", "int64"), /invalid int64/);
});

test("fromJsonScalar rejects negative uint64 values", () => {
	assert.throws(() => fromJsonScalar(-1, "uint64"), /invalid uint64/);
});

test("fromJsonScalar rejects out-of-range int scalars", () => {
	assert.throws(() => fromJsonScalar(300, "int8"), /invalid int8/);
	assert.throws(() => fromJsonScalar(-1, "uint8"), /invalid uint8/);
	assert.throws(() => fromJsonScalar(2147483648, "int32"), /invalid int32/);
});

test("fromJsonScalar rejects non-integer int scalars", () => {
	assert.throws(() => fromJsonScalar(1.7, "int32"), /invalid int32/);
	assert.throws(() => fromJsonScalar("NaN", "int32"), /invalid int32/);
});

test("fromJsonScalar rejects invalid float strings", () => {
	assert.throws(() => fromJsonScalar("nan", "float64"), /invalid float64/);
});

test("fromJsonScalar rejects non-boolean bool scalars", () => {
	assert.throws(() => fromJsonScalar(1, "bool"), /invalid bool/);
});

test("decode surfaces strict scalar errors", () => {
	const codec = JsonSerializer.fromConfig(
		{},
		{ dataType: "int64", shape: [1], codecs: [], fillValue: null },
	);
	// A peer writing 9007199254740993 parses as the rounded double 2^53;
	// decoding must be a loud error, not 9007199254740992n.
	assert.throws(
		() => codec.decode(new TextEncoder().encode("[9007199254740993]")),
		/invalid int64/,
	);
});

test("decode is shape-driven and rebuilds nested C-order chunks", () => {
	// Flattening is driven by the chunk shape (recursion stops at the last
	// dimension — a complex scalar's JSON form is itself a 2-element array,
	// so value-driven recursion would descend too far).
	const f64 = JsonSerializer.fromConfig(
		{},
		{ dataType: "float64", shape: [2, 2], codecs: [], fillValue: null },
	);
	const out = f64.decode(new TextEncoder().encode("[[1,2],[3,4]]"));
	assert.deepEqual(
		new Float64Array(out.data as Float64Array),
		Float64Array.from([1, 2, 3, 4]),
	);
	assert.deepEqual(out.shape, [2, 2]);
	assert.deepEqual(out.stride, [2, 1]);
});
