import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { strictParse } from "zarr-inline";
import { read, write, type Payload } from "../crosscheck.js";

const CLI = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../crosscheck.js",
);

// The portable payload from the crosscheck protocol: every portable dtype,
// edge chunks, a nested group path, and non-finite floats.
const PAYLOAD: Payload = {
	arrays: [
		{ path: "b", dtype: "bool", shape: [3], chunks: [2], data: [true, false, true] },
		{
			path: "f32",
			dtype: "float32",
			shape: [4],
			chunks: [3],
			data: [0.5, -2.75, "NaN", 1.5],
		},
		{
			path: "f64",
			dtype: "float64",
			shape: [5],
			chunks: [2],
			data: [0.5, "NaN", "Infinity", "-Infinity", -2.75],
		},
		{
			path: "grp/i64",
			dtype: "int64",
			shape: [2, 2],
			chunks: [1, 2],
			data: [
				[1099511627776, -5],
				[0, 9007199254740991],
			],
		},
		{
			path: "i32",
			dtype: "int32",
			shape: [3],
			chunks: [2],
			data: [-2147483648, 0, 2147483647],
		},
		{
			path: "u8",
			dtype: "uint8",
			shape: [2, 4],
			chunks: [2, 4],
			data: [
				[0, 1, 2, 3],
				[4, 5, 6, 7],
			],
		},
	],
};

test("write produces a document read reproduces the payload from", async () => {
	// Payload data keeps its JSON number sort via integersAsBigInt parsing,
	// exactly as the CLI does (a JS number literal would be a float token).
	const payload = strictParse(JSON.stringify(PAYLOAD), {
		integersAsBigInt: true,
	}) as Payload;
	const document = await write(payload);
	// Root group, one group per intermediate path, one metadata + chunk keys
	// per array; the json codec makes chunks real JSON arrays.
	assert.ok("zarr.json" in document);
	assert.ok("grp/zarr.json" in document);
	assert.ok("grp/i64/zarr.json" in document);
	assert.deepEqual(document["u8/c/0/0"], [
		[0, 1, 2, 3],
		[4, 5, 6, 7],
	]);
	assert.deepEqual(document["f64/c/1"], ["Infinity", "-Infinity"]);
	// Edge chunk padded with the fill value.
	assert.deepEqual(document["b/c/1"], [true, false]);
	const result = await read(JSON.parse(JSON.stringify(document)) as never);
	assert.deepEqual(result, PAYLOAD);
});

test("CLI write | read round-trips the payload", () => {
	const document = execFileSync("node", [CLI, "write"], {
		input: JSON.stringify(PAYLOAD),
		encoding: "utf-8",
	});
	const result = execFileSync("node", [CLI, "read"], {
		input: document,
		encoding: "utf-8",
	});
	assert.deepEqual(JSON.parse(result), PAYLOAD);
});

test("CLI rejects a bad mode with exit code 1", () => {
	assert.throws(() =>
		execFileSync("node", [CLI, "frobnicate"], {
			input: "{}",
			encoding: "utf-8",
			stdio: "pipe",
		}),
	);
	assert.throws(() =>
		execFileSync("node", [CLI], { input: "{}", encoding: "utf-8", stdio: "pipe" }),
	);
});

test("CLI write fails loudly on malformed payloads", () => {
	assert.throws(() =>
		execFileSync("node", [CLI, "write"], {
			input: '{"arrays": [{"path": "a", "dtype": "int32", "shape": [2], "chunks": [2], "data": [1.5, 2]}]}',
			encoding: "utf-8",
			stdio: "pipe",
		}),
	);
});
