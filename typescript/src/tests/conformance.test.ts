import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { run } from "../conformance.js";

const CLI = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../conformance.js",
);

test("run() reports issues, decoded, and reencoded", () => {
	const report = run({
		"zarr.json": { a: 1 },
		"x/c/0": [1, 2],
		"b/c/0": "AAEC",
		"/bad": "x",
	});
	assert.deepEqual(report.issues, [{ rule: "R1", key: "/bad" }]);
	assert.deepEqual(report.decoded, {
		"zarr.json": "eyJhIjoxfQ==",
		"x/c/0": "WzEsMl0=",
		"b/c/0": "AAEC",
	});
	assert.deepEqual(report.reencoded, {
		"zarr.json": { a: 1 },
		"x/c/0": [1, 2],
		"b/c/0": "AAEC",
	});
});

test("issues are sorted by (key, rule)", () => {
	const report = run({ "b/": "x", "/a": "x", "zarr.json": 1 });
	assert.deepEqual(report.issues, [
		{ rule: "R1", key: "/a" },
		{ rule: "R1", key: "b/" },
		{ rule: "R2", key: "zarr.json" },
	]);
});

test("CLI smoke test matches the protocol", () => {
	const stdout = execFileSync("node", [CLI], {
		input: '{"zarr.json": {"a": 1}, "x/c/0": [1,2], "b/c/0": "AAEC", "/bad": "x"}',
		encoding: "utf-8",
	});
	assert.deepEqual(JSON.parse(stdout), {
		issues: [{ rule: "R1", key: "/bad" }],
		decoded: {
			"zarr.json": "eyJhIjoxfQ==",
			"x/c/0": "WzEsMl0=",
			"b/c/0": "AAEC",
		},
		reencoded: { "zarr.json": { a: 1 }, "x/c/0": [1, 2], "b/c/0": "AAEC" },
	});
});

test("CLI rejects non-object input with exit code 1", () => {
	assert.throws(() =>
		execFileSync("node", [CLI], { input: "[1,2]", encoding: "utf-8", stdio: "pipe" }),
	);
	assert.throws(() =>
		execFileSync("node", [CLI], { input: "not json", encoding: "utf-8", stdio: "pipe" }),
	);
});
