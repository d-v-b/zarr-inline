import assert from "node:assert/strict";
import { test } from "node:test";

import {
	base64Decode,
	canonicalStringify,
	decodeValue,
	encodeValue,
	isMetadataKey,
} from "../codec.js";

const UTF8 = new TextEncoder();

test("root zarr.json is a metadata key", () => {
	assert.equal(isMetadataKey("zarr.json"), true);
});

test("nested zarr.json is a metadata key", () => {
	assert.equal(isMetadataKey("myarray/zarr.json"), true);
});

test("chunk key is not a metadata key", () => {
	assert.equal(isMetadataKey("myarray/c/0/0"), false);
});

test("key containing but not ending zarr.json is not metadata", () => {
	assert.equal(isMetadataKey("zarr.json/c/0"), false);
});

test("key ending in zarr.json without separator is not metadata", () => {
	assert.equal(isMetadataKey("xyzarr.json"), false);
	assert.equal(isMetadataKey("a/notzarr.json"), false);
});

test("decode metadata value serializes object to JSON bytes", () => {
	const out = decodeValue("zarr.json", { zarr_format: 3, node_type: "group" });
	assert.ok(out instanceof Uint8Array);
	assert.deepEqual(JSON.parse(new TextDecoder().decode(out)), {
		zarr_format: 3,
		node_type: "group",
	});
});

test("decode byte value base64-decodes string", () => {
	assert.deepEqual(
		decodeValue("a/c/0", "AAECAwQFBgc="),
		new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
	);
});

test("decode metadata value rejects non-object", () => {
	assert.throws(() => decodeValue("zarr.json", [1, 2]), /JSON object/);
	assert.throws(() => decodeValue("zarr.json", null), /JSON object/);
});

test("decode byte value rejects non-string non-array", () => {
	assert.throws(() => decodeValue("a/c/0", 123), /base64 string or JSON array/);
});

test("decode byte value rejects invalid base64", () => {
	assert.throws(() => decodeValue("a/c/0", "not base64!"), /invalid base64/);
	// Missing padding must be rejected (Buffer.from alone would accept it).
	assert.throws(() => decodeValue("a/c/0", "AAE"), /invalid base64/);
	// Whitespace is not part of the standard alphabet.
	assert.throws(() => decodeValue("a/c/0", "AA EC"), /invalid base64/);
});

test("encode metadata value parses JSON bytes to object", () => {
	const raw = UTF8.encode('{"zarr_format": 3, "node_type": "array"}');
	assert.deepEqual(encodeValue("zarr.json", raw), {
		zarr_format: 3,
		node_type: "array",
	});
});

test("encode metadata value rejects non-object JSON", () => {
	assert.throws(
		() => encodeValue("zarr.json", UTF8.encode("[1, 2, 3]")),
		/JSON object/,
	);
});

test("encode byte value base64-encodes bytes", () => {
	assert.equal(
		encodeValue("a/c/0", new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])),
		"AAECAwQFBgc=",
	);
});

test("encode byte value inlines canonical JSON array", () => {
	const data = UTF8.encode("[[0,1,2,3],[4,5,6,7]]");
	assert.deepEqual(encodeValue("a/c/0/0", data), [
		[0, 1, 2, 3],
		[4, 5, 6, 7],
	]);
});

test("encode byte value keeps non-canonical JSON array as base64", () => {
	// Valid JSON array, but not in canonical form (whitespace) — inlining
	// would not round-trip byte-exactly, so it must stay base64.
	const data = UTF8.encode("[1, 2, 3]");
	const out = encodeValue("a/c/0", data);
	assert.equal(typeof out, "string");
	assert.deepEqual(decodeValue("a/c/0", out), data);
});

test("encode byte value keeps NaN-token array as base64", () => {
	// NaN tokens are not JSON; canonical form refuses them, so the bytes
	// must stay base64.
	const data = UTF8.encode("[NaN]");
	const out = encodeValue("a/c/0", data);
	assert.equal(typeof out, "string");
	assert.deepEqual(decodeValue("a/c/0", out), data);
});

test("decode byte value serializes inline array canonically", () => {
	assert.deepEqual(
		decodeValue("a/c/0", [1.5, "NaN", 2]),
		UTF8.encode('[1.5,"NaN",2]'),
	);
});

test("round trip metadata", () => {
	const obj = { zarr_format: 3, node_type: "group", attributes: {} };
	assert.deepEqual(encodeValue("zarr.json", decodeValue("zarr.json", obj)), obj);
});

test("round trip bytes", () => {
	const data = new Uint8Array([9, 8, 7, 0, 255, 1]);
	assert.deepEqual(decodeValue("a/c/0", encodeValue("a/c/0", data)), data);
});

test("round trip inline array", () => {
	const value = [
		[0, 1],
		[2, 3],
	];
	assert.deepEqual(encodeValue("a/c/0/0", decodeValue("a/c/0/0", value)), value);
});

test("canonicalStringify emits compact, non-ASCII-unescaped JSON", () => {
	assert.equal(canonicalStringify({ a: [1, 2], s: "héllo" }), '{"a":[1,2],"s":"héllo"}');
});

test("canonicalStringify rejects non-finite numbers", () => {
	// JSON.stringify would silently emit null; canonical form must throw.
	assert.throws(() => canonicalStringify([Number.NaN]), /non-finite/);
	assert.throws(() => canonicalStringify([Infinity]), /non-finite/);
	assert.throws(() => canonicalStringify({ a: -Infinity }), /non-finite/);
});

test("base64Decode accepts non-zero trailing padding bits like Python", () => {
	// Python's b64decode(validate=True) accepts "AB==" (decodes to 0x00);
	// all implementations agree on this leniency.
	assert.deepEqual(base64Decode("AB=="), new Uint8Array([0]));
});

test("base64Decode round-trips arbitrary bytes", () => {
	const data = new Uint8Array([0, 255, 128, 1, 2]);
	assert.deepEqual(base64Decode(Buffer.from(data).toString("base64")), data);
});

test("public API is importable from package root", async () => {
	const api = await import("../index.js");
	for (const name of [
		"ZarrJsonStore",
		"MemoryBacking",
		"StringBacking",
		"validate",
		"ValidationError",
		"JsonSerializer",
		"registerJsonCodec",
	]) {
		assert.ok(name in api, `missing export ${name}`);
	}
});
