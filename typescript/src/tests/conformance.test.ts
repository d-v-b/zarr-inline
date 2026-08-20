import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { run } from "../conformance.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "../conformance.js");
const EXAMPLES = path.resolve(HERE, "../../../examples");

test("run() reports issues, decoded, reencoded, and errors", () => {
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
	assert.deepEqual(report.errors, []);
});

test("per-key decode failures land in sorted errors without aborting", () => {
	const report = run({
		"b/c/0": "not base64!",
		"a/c/0": "also not base64!",
		"ok/c/0": "AAEC",
	});
	assert.deepEqual(report.issues, []);
	assert.deepEqual(report.errors, ["a/c/0", "b/c/0"]);
	assert.deepEqual(report.decoded, { "ok/c/0": "AAEC" });
	assert.deepEqual(report.reencoded, { "ok/c/0": "AAEC" });
});

test("issues are sorted by (key, rule)", () => {
	const report = run({ "b/": "x", "/a": "x", "zarr.json": 1 });
	assert.deepEqual(report.issues, [
		{ rule: "R1", key: "/a" },
		{ rule: "R1", key: "b/" },
		{ rule: "R2", key: "zarr.json" },
	]);
});

test("issue keys sort by code points, not UTF-16 code units", () => {
	// "😀" is U+1F600; its UTF-16 surrogate pair (0xD83D 0xDE00) would sort
	// before "￿" under code-unit order, but Python's sorted() puts it
	// after. Both keys are R1-invalid (trailing "/").
	const report = run({ "￿/": "x", "😀/": "x" });
	assert.deepEqual(
		report.issues.map((i) => i.key),
		["￿/", "😀/"],
	);
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
		errors: [],
	});
});

test("CLI reports base64 decode failure in errors with exit 0", () => {
	const stdout = execFileSync("node", [CLI], {
		input: '{"a/c/0": "not base64!", "b/c/0": "AAEC"}',
		encoding: "utf-8",
	});
	assert.deepEqual(JSON.parse(stdout), {
		issues: [],
		decoded: { "b/c/0": "AAEC" },
		reencoded: { "b/c/0": "AAEC" },
		errors: ["a/c/0"],
	});
});

test("CLI matches the Python report for the inline-json fixture shape", () => {
	// The shipped fixture contains a -0.0 inline element; RFC 8785 numbers
	// serialize negative zero as "0" in every implementation, so the decoded
	// base64 is byte-identical across implementations.
	const fixture = fs.readFileSync(
		path.join(EXAMPLES, "valid", "array_with_inline_json_chunk.json"),
		"utf-8",
	);
	const stdout = execFileSync("node", [CLI], {
		input: fixture,
		encoding: "utf-8",
	});
	const report = JSON.parse(stdout) as {
		decoded: Record<string, string>;
		errors: string[];
	};
	assert.deepEqual(report.errors, []);
	assert.equal(
		Buffer.from(report.decoded["myarray/c/0"], "base64").toString("utf-8"),
		'[1.5,"NaN","Infinity",0]',
	);
});

test("CLI rejects non-object input with exit code 1", () => {
	assert.throws(() =>
		execFileSync("node", [CLI], { input: "[1,2]", encoding: "utf-8", stdio: "pipe" }),
	);
	assert.throws(() =>
		execFileSync("node", [CLI], { input: "not json", encoding: "utf-8", stdio: "pipe" }),
	);
});

test("CLI rejects documents with overflowing number literals", () => {
	// JSON.parse silently turns 1e400 into Infinity; Python and Rust reject
	// the document, so the harness must exit 1.
	assert.throws(() =>
		execFileSync("node", [CLI], {
			input: '{"zarr.json": {"a": 1e400}}',
			encoding: "utf-8",
			stdio: "pipe",
		}),
	);
});

test("CLI exits 1 when the report cannot be encoded (lone surrogate key)", () => {
	// JSON escapes can produce a lone surrogate in a key; "a\ud800" passes
	// R1 and decodes fine, so it lands in the report — whose serialization
	// must then fail loudly, matching Python's "cannot encode report".
	let stderr = "";
	try {
		execFileSync("node", [CLI], {
			input: '{"a\\ud800": "AAEC"}',
			encoding: "utf-8",
			stdio: "pipe",
		});
		assert.fail("expected exit code 1");
	} catch (err) {
		stderr = (err as { stderr: string }).stderr;
	}
	assert.match(stderr, /cannot encode report/);
});
