import assert from "node:assert/strict";
import { test } from "node:test";

import * as zarr from "zarrita";

import { MemoryBacking, StringBacking } from "../backing.js";
import { isMetadataKey } from "../codec.js";
import { ZarrJsonStore } from "../store.js";
import { ValidationError } from "../validator.js";

test("create group and array, write and read back through zarrita", async () => {
	const backing = new MemoryBacking({});
	const store = new ZarrJsonStore(backing);
	const root = zarr.root(store);

	await zarr.create(root, { attributes: { title: "demo" } });
	const arr = await zarr.create(root.resolve("data"), {
		shape: [8],
		chunkShape: [4],
		dtype: "uint8",
	});
	const values = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
	await zarr.set(arr, null, { data: values, shape: [8], stride: [1] });

	// Read back through a fresh store over the same document.
	const store2 = new ZarrJsonStore(new MemoryBacking(backing.load()));
	const arr2 = await zarr.open(zarr.root(store2).resolve("data"), {
		kind: "array",
	});
	const out = await zarr.get(arr2);
	assert.deepEqual(new Uint8Array(out.data as Uint8Array), values);
});

test("document shape: metadata objects and base64 chunk strings", async () => {
	const backing = new MemoryBacking({});
	const store = new ZarrJsonStore(backing);
	const root = zarr.root(store);
	await zarr.create(root);
	const arr = await zarr.create(root.resolve("data"), {
		shape: [4],
		chunkShape: [4],
		dtype: "uint8",
	});
	await zarr.set(arr, null, {
		data: Uint8Array.from([9, 8, 7, 6]),
		shape: [4],
		stride: [1],
	});

	const doc = backing.load();
	assert.ok("zarr.json" in doc);
	assert.ok("data/zarr.json" in doc);
	assert.ok("data/c/0" in doc);
	for (const [key, value] of Object.entries(doc)) {
		if (isMetadataKey(key)) {
			assert.equal(typeof value, "object", `${key} should be a JSON object`);
			assert.ok(!Array.isArray(value), `${key} should be a JSON object`);
		} else {
			assert.equal(typeof value, "string", `${key} should be a base64 string`);
		}
	}
});

test("round trip through string backing", async () => {
	const backing = new MemoryBacking({});
	const store = new ZarrJsonStore(backing);
	const root = zarr.root(store);
	await zarr.create(root);
	const arr = await zarr.create(root.resolve("data"), {
		shape: [4],
		chunkShape: [2],
		dtype: "int32",
	});
	await zarr.set(arr, null, {
		data: Int32Array.from([10, 20, 30, 40]),
		shape: [4],
		stride: [1],
	});

	// Serialize the whole hierarchy to a JSON string, then reload it.
	const text = JSON.stringify(backing.load());
	const store2 = new ZarrJsonStore(new StringBacking(text));
	const arr2 = await zarr.open(zarr.root(store2).resolve("data"), {
		kind: "array",
	});
	const out = await zarr.get(arr2);
	assert.deepEqual(new Int32Array(out.data as Int32Array), Int32Array.from([10, 20, 30, 40]));
});

test("get returns undefined for a missing key", async () => {
	const store = new ZarrJsonStore(new MemoryBacking({}));
	assert.equal(await store.get("/nope"), undefined);
});

test("getRange applies offset/length and suffixLength to decoded bytes", async () => {
	const store = new ZarrJsonStore(
		new MemoryBacking({ "a/c/0": Buffer.from([0, 1, 2, 3, 4, 5]).toString("base64") }),
	);
	assert.deepEqual(
		await store.getRange("/a/c/0", { offset: 1, length: 3 }),
		new Uint8Array([1, 2, 3]),
	);
	assert.deepEqual(
		await store.getRange("/a/c/0", { suffixLength: 2 }),
		new Uint8Array([4, 5]),
	);
	assert.deepEqual(
		await store.getRange("/a/c/0", { suffixLength: 0 }),
		new Uint8Array([]),
	);
	assert.equal(await store.getRange("/missing", { offset: 0, length: 1 }), undefined);
});

test("delete removes a key and persists", async () => {
	const backing = new MemoryBacking({ "a/c/0": "AAEC" });
	const store = new ZarrJsonStore(backing);
	await store.delete("/a/c/0");
	// Documents are null-prototype objects; spread to compare contents.
	assert.deepEqual({ ...backing.load() }, {});
});

test("prototype-named keys are ordinary document keys", async () => {
	// A plain object's inherited __proto__ setter would silently swallow
	// store.set of key "__proto__"; documents are null-prototype objects so
	// every key is an own property.
	const backing = new MemoryBacking({});
	const store = new ZarrJsonStore(backing);
	for (const key of ["__proto__", "constructor", "toString"] as const) {
		const path = `/${key}` as const;
		assert.equal(await store.has(path), false);
		await store.set(path, new Uint8Array([0, 1, 2]));
		assert.equal(await store.has(path), true);
		assert.deepEqual(await store.get(path), new Uint8Array([0, 1, 2]));
	}
	assert.deepEqual(
		(await store.list()).sort(),
		["__proto__", "constructor", "toString"],
	);
	assert.deepEqual({ ...backing.load() }, {
		["__proto__"]: "AAEC",
		constructor: "AAEC",
		toString: "AAEC",
	});
	for (const key of ["__proto__", "constructor", "toString"] as const) {
		await store.delete(`/${key}`);
		assert.equal(await store.has(`/${key}`), false);
	}
	assert.deepEqual(await store.list(), []);
});

test("prototype-named keys load from parsed and constructed documents", async () => {
	// JSON.parse creates "__proto__" as an own property; the backings must
	// keep it one (StringBacking) and re-key plain objects (MemoryBacking).
	const fromString = new ZarrJsonStore(
		new StringBacking('{"__proto__": "AAEC", "toString": "AAEC"}'),
	);
	assert.deepEqual(await fromString.get("/__proto__"), new Uint8Array([0, 1, 2]));
	assert.deepEqual(await fromString.get("/toString"), new Uint8Array([0, 1, 2]));
	const doc = JSON.parse('{"constructor": "AAEC"}') as Record<string, unknown>;
	const fromMemory = new ZarrJsonStore(new MemoryBacking(doc));
	assert.equal(await fromMemory.has("/constructor"), true);
	assert.deepEqual(await fromMemory.get("/constructor"), new Uint8Array([0, 1, 2]));
});

test("string backing load rejects overflowing number literals", () => {
	// 1e400 parses to Infinity under JSON.parse; Python and Rust reject the
	// document, so loading it here must fail loudly.
	assert.throws(
		() => new StringBacking('{"zarr.json": {"a": 1e400}}').load(),
		/overflow/,
	);
});

test("read-only store refuses set and delete", async () => {
	const store = new ZarrJsonStore(new MemoryBacking({ "a/c/0": "AAEC" }), {
		readOnly: true,
	});
	await assert.rejects(store.set("/x", new Uint8Array([1])), /read-only/);
	await assert.rejects(store.delete("/a/c/0"), /read-only/);
	// Reads still work.
	assert.deepEqual(await store.get("/a/c/0"), new Uint8Array([0, 1, 2]));
});

test("strict construction rejects an invalid document", () => {
	assert.throws(
		() =>
			new ZarrJsonStore(new MemoryBacking({ "zarr.json": "bad" }), {
				strict: true,
			}),
		ValidationError,
	);
});

test("lenient construction surfaces issues via onIssue and continues", () => {
	const seen: string[] = [];
	const store = new ZarrJsonStore(new MemoryBacking({ "/bad": "x" }), {
		onIssue: (issue) => seen.push(`${issue.rule}:${issue.key}`),
	});
	assert.deepEqual(seen, ["R1:/bad"]);
	assert.ok(store instanceof ZarrJsonStore);
});

test("set rejects malformed store keys per the Zarr v3 key grammar", async () => {
	const backing = new MemoryBacking({});
	const store = new ZarrJsonStore(backing);
	for (const bad of ["/a/./b", "/a//b", "/..", "/a/", "//x", "/a/../b"]) {
		await assert.rejects(
			() => store.set(bad as `/${string}`, new Uint8Array([1])),
			/invalid store key/,
		);
	}
	assert.deepEqual(Object.keys(backing.load()), []);
});

test("StringBacking persists integers beyond 2^53 losslessly", async () => {
	// Regression: JSON.stringify throws on bigint; persist must use the
	// canonical serializer so full int64/uint64 support holds end to end.
	const backing = new StringBacking("{}");
	const store = new ZarrJsonStore(backing);
	await store.set("/a/c/0", new TextEncoder().encode("[9007199254740993]"));
	assert.ok(backing.dumps().includes("9007199254740993"));
	const reloaded = new ZarrJsonStore(new StringBacking(backing.dumps()));
	assert.equal(
		new TextDecoder().decode(await reloaded.get("/a/c/0")),
		"[9007199254740993]",
	);
});

test("backings reject a non-object top-level document", () => {
	// Regression: an array must not be re-keyed into {"0": ...}.
	assert.throws(() => new StringBacking('["AA=="]').load(), /top-level value must be a JSON object/);
	assert.throws(() => new StringBacking("42").load(), /top-level value must be a JSON object/);
	assert.throws(
		() => new MemoryBacking(["AA=="] as unknown as Record<string, unknown>),
		/top-level value must be a JSON object/,
	);
});

test("a failed persist leaves the document unchanged (set and delete)", async () => {
	let fail = false;
	const inner = new MemoryBacking({ "keep/c/0": "AAEC" });
	const backing = {
		load: () => inner.load(),
		persist: (doc: Record<string, unknown>) => {
			if (fail) throw new Error("disk full");
			inner.persist(doc);
		},
	};
	const store = new ZarrJsonStore(backing);
	fail = true;
	await assert.rejects(() => store.set("/new/c/0", new Uint8Array([1])), /disk full/);
	assert.equal(await store.get("/new/c/0"), undefined);
	assert.equal(await store.has("/new/c/0"), false);
	await assert.rejects(() => store.set("/keep/c/0", new Uint8Array([9])), /disk full/);
	assert.deepEqual(await store.get("/keep/c/0"), new Uint8Array([0, 1, 2]));
	await assert.rejects(() => store.delete("/keep/c/0"), /disk full/);
	assert.deepEqual(await store.get("/keep/c/0"), new Uint8Array([0, 1, 2]));
	fail = false;
	await store.set("/new/c/0", new Uint8Array([1]));
	assert.deepEqual(await store.get("/new/c/0"), new Uint8Array([1]));
});

test("lenient mode treats invalid entries as absent until rewritten", async () => {
	const backing = new MemoryBacking({ "bad/c/0": 123, "ok/c/0": "AAEC" });
	const store = new ZarrJsonStore(backing, { onIssue: () => undefined });
	assert.equal(await store.has("/bad/c/0"), false);
	assert.equal(await store.get("/bad/c/0"), undefined);
	assert.deepEqual(await store.list(), ["ok/c/0"]);
	// The offending entry survives in the document text (never destroyed)...
	assert.equal(backing.load()["bad/c/0"], 123);
	// ...and a successful set makes the key live again.
	await store.set("/bad/c/0", new Uint8Array([7]));
	assert.equal(await store.has("/bad/c/0"), true);
	assert.deepEqual([...(await store.list())].sort(), ["bad/c/0", "ok/c/0"]);
});

test("setJson stores inline canonical values", async () => {
	const backing = new MemoryBacking({});
	const store = new ZarrJsonStore(backing);
	await store.setJson("/zarr.json", { zarr_format: 3, node_type: "group", x: 1.0 });
	await store.setJson("/a/c/0", [1.5, -0, 2, "NaN"]);
	const doc = backing.load();
	// Inline representations, canonicalized (1.0 -> 1, -0 -> 0).
	assert.deepEqual(doc["zarr.json"], { zarr_format: 3, node_type: "group", x: 1 });
	assert.deepEqual(doc["a/c/0"], [1.5, 0, 2, "NaN"]);
	assert.equal(
		new TextDecoder().decode(await store.get("/a/c/0")),
		'[1.5,0,2,"NaN"]',
	);
});

test("setJson rejects wrong shapes and non-canonicalizable values", async () => {
	const store = new ZarrJsonStore(new MemoryBacking({}));
	await assert.rejects(() => store.setJson("/zarr.json", [1, 2]), /takes a JSON object/);
	await assert.rejects(() => store.setJson("/a/c/0", "raw"), /takes a JSON array or object/);
	await assert.rejects(() => store.setJson("/a/c/0", [Number.NaN]), /non-finite/);
});
