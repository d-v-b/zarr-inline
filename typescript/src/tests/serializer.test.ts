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

test("encode emits exact digits for int64 values beyond 2^53", () => {
	const codec = JsonSerializer.fromConfig(
		{},
		{ dataType: "int64", shape: [3], codecs: [], fillValue: null },
	);
	const bytes = codec.encode({
		data: BigInt64Array.from([-(2n ** 63n), 2n ** 63n - 1n, 5n]),
		shape: [3],
		stride: [1],
	});
	assert.equal(
		new TextDecoder().decode(bytes),
		"[-9223372036854775808,9223372036854775807,5]",
	);
	// and it round-trips exactly through decode
	const back = codec.decode(bytes);
	assert.deepEqual(
		[...(back.data as BigInt64Array)],
		[-(2n ** 63n), 2n ** 63n - 1n, 5n],
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
	// Integer types take integer tokens (bigint from integersAsBigInt parsing).
	assert.equal(fromJsonScalar(-128n, "int8"), -128);
	assert.equal(fromJsonScalar(255n, "uint8"), 255);
	assert.equal(fromJsonScalar(-2147483648n, "int32"), -2147483648);
	assert.equal(fromJsonScalar(9007199254740991n, "int64"), 9007199254740991n);
	assert.equal(fromJsonScalar(-5n, "int64"), -5n);
	assert.equal(fromJsonScalar(1.5, "float32"), 1.5);
	// Float types accept integer tokens too, as the nearest float64.
	assert.equal(fromJsonScalar(9007199254740993n, "float64"), 9007199254740992);
	assert.ok(Number.isNaN(fromJsonScalar("NaN", "float64")));
	assert.equal(fromJsonScalar("Infinity", "float64"), Infinity);
	assert.equal(fromJsonScalar("-Infinity", "float64"), -Infinity);
	assert.equal(fromJsonScalar(true, "bool"), true);
});

test("fromJsonScalar accepts integer tokens of any size for int64/uint64", () => {
	assert.equal(fromJsonScalar(9007199254740993n, "int64"), 9007199254740993n);
	assert.equal(fromJsonScalar(2n ** 64n - 1n, "uint64"), 2n ** 64n - 1n);
	assert.equal(fromJsonScalar(7n, "int64"), 7n);
});

test("fromJsonScalar rejects float tokens for integer types even when integral", () => {
	// SPEC §9.2: the token 1.0 is a float64 and is an error for int types.
	// A JS number reaching here means a float token (integersAsBigInt).
	assert.throws(() => fromJsonScalar(1, "int32"), /invalid int32/);
	assert.throws(() => fromJsonScalar(7, "int64"), /must be an integer token/);
});

test("fromJsonScalar rejects unsafe plain numbers for int64", () => {
	// A plain number that is integral but unsafe can only mean a lossy parse
	// upstream (strictParse would have produced a bigint).
	assert.throws(() => fromJsonScalar(2 ** 53, "int64"), /invalid int64/);
	assert.throws(() => fromJsonScalar(1.5, "int64"), /invalid int64/);
	assert.throws(() => fromJsonScalar("7", "int64"), /invalid int64/);
});

test("fromJsonScalar rejects out-of-range int64/uint64 values", () => {
	assert.throws(() => fromJsonScalar(-1n, "uint64"), /out of range/);
	assert.throws(() => fromJsonScalar(2n ** 64n, "uint64"), /out of range/);
	assert.throws(() => fromJsonScalar(2n ** 63n, "int64"), /out of range/);
	assert.throws(() => fromJsonScalar(-(2n ** 63n) - 1n, "int64"), /out of range/);
});

test("fromJsonScalar rejects out-of-range int scalars", () => {
	assert.throws(() => fromJsonScalar(300n, "int8"), /invalid int8/);
	assert.throws(() => fromJsonScalar(-1n, "uint8"), /invalid uint8/);
	assert.throws(() => fromJsonScalar(2147483648n, "int32"), /invalid int32/);
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
	// A peer's 9007199254740993 now parses losslessly as bigint; a
	// fractional element is still a loud error.
	const ok = codec.decode(new TextEncoder().encode("[9007199254740993]"));
	assert.deepEqual([...(ok.data as BigInt64Array)], [9007199254740993n]);
	assert.throws(
		() => codec.decode(new TextEncoder().encode("[1.5]")),
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

test("decode keeps the JSON number sort: 1.0 is an error for int32, big ints round to float64", () => {
	const int32 = JsonSerializer.fromConfig(
		{},
		{ dataType: "int32", shape: [1], codecs: [], fillValue: null },
	);
	assert.throws(
		() => int32.decode(new TextEncoder().encode("[1.0]")),
		/invalid int32/,
	);
	assert.deepEqual([...(int32.decode(new TextEncoder().encode("[1]")).data as Int32Array)], [1]);
	const f64 = JsonSerializer.fromConfig(
		{},
		{ dataType: "float64", shape: [1], codecs: [], fillValue: null },
	);
	assert.deepEqual(
		[...(f64.decode(new TextEncoder().encode("[9007199254740993]")).data as Float64Array)],
		[9007199254740992],
	);
});

test("decode rejects numbers that overflow the target float type", () => {
	const f32 = JsonSerializer.fromConfig(
		{},
		{ dataType: "float32", shape: [1], codecs: [], fillValue: null },
	);
	assert.throws(() => f32.decode(new TextEncoder().encode("[1e39]")), /out of range/);
	// 3.4e38 is within float32 range; the explicit string form still works.
	assert.deepEqual([...(f32.decode(new TextEncoder().encode("[3.4e38]")).data as Float32Array)].map(Number.isFinite), [true]);
	assert.equal((f32.decode(new TextEncoder().encode('["Infinity"]')).data as Float32Array)[0], Infinity);
	const f64 = JsonSerializer.fromConfig(
		{},
		{ dataType: "float64", shape: [1], codecs: [], fillValue: null },
	);
	const hugeInt = "[1" + "0".repeat(400) + "]";
	assert.throws(() => f64.decode(new TextEncoder().encode(hugeInt)), /out of range/);
});
