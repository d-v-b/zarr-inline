import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { validate, ValidationError } from "../validator.js";

// dist/tests/validator.test.js -> ../../.. = repository root.
const EXAMPLES_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../examples",
);

test("empty document is valid", () => {
	assert.deepEqual(validate({}), []);
});

test("valid group document passes", () => {
	const doc = {
		"zarr.json": { zarr_format: 3, node_type: "group", attributes: {} },
	};
	assert.deepEqual(validate(doc), []);
});

test("metadata key with non-object value reports R2", () => {
	const issues = validate({ "zarr.json": "not an object" });
	assert.equal(issues.length, 1);
	assert.equal(issues[0].rule, "R2");
	assert.equal(issues[0].key, "zarr.json");
});

test("metadata key with array value reports R2", () => {
	const issues = validate({ "zarr.json": [1, 2] });
	assert.equal(issues.length, 1);
	assert.equal(issues[0].rule, "R2");
});

test("metadata key with null value reports R2", () => {
	const issues = validate({ "zarr.json": null });
	assert.equal(issues.length, 1);
	assert.equal(issues[0].rule, "R2");
});

test("byte key with inline object value is valid", () => {
	assert.deepEqual(validate({ "a/c/0": { an: "inline object" } }), []);
});

test("byte key with number value reports R2", () => {
	const issues = validate({ "a/c/0": 123 });
	assert.equal(issues.length, 1);
	assert.equal(issues[0].rule, "R2");
});

test("byte key with inline JSON array is valid", () => {
	assert.deepEqual(validate({ "a/c/0": [[0, 1], [2, 3]] }), []);
});

test("leading slash key reports R1", () => {
	assert.ok(validate({ "/zarr.json": {} }).some((i) => i.rule === "R1"));
});

test("trailing slash key reports R1", () => {
	assert.ok(validate({ "a/zarr.json/": {} }).some((i) => i.rule === "R1"));
});

test("empty segment key reports R1", () => {
	assert.ok(validate({ "a//zarr.json": {} }).some((i) => i.rule === "R1"));
});

test("dot segment key reports R1", () => {
	assert.ok(validate({ "a/./zarr.json": {} }).some((i) => i.rule === "R1"));
});

test("standalone dotdot key reports R1", () => {
	assert.ok(validate({ "..": {} }).some((i) => i.rule === "R1"));
});

test("empty key reports R1", () => {
	assert.ok(validate({ "": "AAEC" }).some((i) => i.rule === "R1"));
});

test("at most one issue per key: R1 takes precedence over R2", () => {
	// "/zarr.json" is both malformed (R1) and, as a metadata key, holds a
	// non-object — only the R1 issue may be reported.
	const issues = validate({ "/zarr.json": "not an object" });
	assert.equal(issues.length, 1);
	assert.equal(issues[0].rule, "R1");
});

test("multiple bad keys accumulate issues", () => {
	const issues = validate({ "/leading": "x", "trailing/": "y" });
	assert.equal(issues.length, 2);
	assert.ok(issues.every((i) => i.rule === "R1"));
});

test("strict mode throws on invalid document", () => {
	assert.throws(
		() => validate({ "zarr.json": "not an object" }, { strict: true }),
		ValidationError,
	);
});

test("lenient mode returns issues without throwing", () => {
	const issues = validate({ "zarr.json": "not an object" });
	assert.equal(issues.length, 1);
});

test("all manifest fixtures get expected verdict", () => {
	const manifest: Record<string, { valid: boolean; rule: string | null }> =
		JSON.parse(readFileSync(path.join(EXAMPLES_DIR, "MANIFEST.json"), "utf-8"));
	const entries = Object.entries(manifest);
	assert.ok(entries.length > 0, "manifest is empty");
	for (const [relPath, expected] of entries) {
		const doc = JSON.parse(
			readFileSync(path.join(EXAMPLES_DIR, relPath), "utf-8"),
		);
		const issues = validate(doc);
		if (expected.valid) {
			assert.deepEqual(issues, [], `${relPath} should be valid`);
		} else {
			assert.ok(issues.length > 0, `${relPath} should be invalid`);
			assert.ok(
				issues.some((i) => i.rule === expected.rule),
				`${relPath} should fail rule ${expected.rule}`,
			);
		}
	}
});
