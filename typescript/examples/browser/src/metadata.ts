/**
 * Semantic checks for `zarr.json` values, via the zarr-metadata package:
 * structural validation (required keys, value shapes, literals) plus the
 * cross-field rules the Zarr v3 spec states in prose (chunk-grid arity,
 * transpose permutations, sharding divisibility, fill_value vs data type),
 * plus this viewer's own support rules (what zarrita can display).
 *
 * zarr-inline itself never validates hierarchy coherence - a document
 * with a broken zarr.json is still a valid document - so these are
 * *flags*, shown next to the edit, never a reason to refuse it.
 */

import {
	flattenTree,
	validateMetadataV3,
	validateSemanticsV3,
	type PathedIssue,
} from "zarr-metadata";

export type MetadataIssue = PathedIssue;

/**
 * Every structural, semantic, and viewer-support problem in a zarr.json
 * value. All layers run even when structure is broken: a half-finished
 * edit (say, shape reduced from 3-D to 2-D) should list everything still
 * to fix - dimension_names arity *and* chunk_shape arity - not one at a
 * time. Identical (path, message) pairs are reported once. A validator
 * crash becomes an issue of its own: a lint must never take the page down.
 */
export function metadataIssues(value: unknown): MetadataIssue[] {
	const seen = new Set<string>();
	const issues: MetadataIssue[] = [];
	const add = (issue: MetadataIssue): void => {
		const id = `${issue.path.join(" ")}|${issue.message}`;
		if (seen.has(id)) return;
		seen.add(id);
		issues.push(issue);
	};
	for (const validate of [validateMetadataV3, validateSemanticsV3]) {
		try {
			for (const issue of flattenTree(validate(value))) add(issue);
		} catch (error) {
			add({
				path: [],
				kind: "invalid_value",
				message: `validator failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}
	// Viewer rules yield to the spec's: where zarr-metadata already reports
	// a location (since 0.6 it requires the known grids' configuration
	// keys), the viewer's phrasing of the same problem would only repeat it.
	const reported = new Set(issues.map((issue) => issue.path.join(" ")));
	for (const issue of viewerIssues(value)) {
		if (!reported.has(issue.path.join(" "))) add(issue);
	}
	return issues;
}

/**
 * Rules of this viewer rather than of the spec: what zarrita can display.
 * The spec's chunk-grid configuration is an open extension point, so
 * zarr-metadata does not judge its contents - but this app reads arrays
 * with zarrita, which supports only the `regular` grid and would crash on
 * anything else.
 */
export function viewerIssues(value: unknown): MetadataIssue[] {
	if (value === null || typeof value !== "object") return [];
	const meta = value as Record<string, unknown>;
	if (meta["node_type"] !== "array") return [];
	const grid = meta["chunk_grid"];
	if (grid === null || typeof grid !== "object") return []; // structural layer's job
	const name = (grid as Record<string, unknown>)["name"];
	if (name !== "regular") {
		return [
			{
				path: ["chunk_grid", "name"],
				kind: "invalid_value",
				message: `chunk grid ${JSON.stringify(name)} cannot be displayed by this viewer (zarrita reads only "regular")`,
			},
		];
	}
	const config = (grid as Record<string, unknown>)["configuration"];
	const shape =
		config !== null && typeof config === "object"
			? (config as Record<string, unknown>)["chunk_shape"]
			: undefined;
	if (
		!Array.isArray(shape) ||
		!shape.every((n) => Number.isInteger(n) && (n as number) > 0)
	) {
		return [
			{
				path: ["chunk_grid", "configuration", "chunk_shape"],
				kind: "missing_key",
				message: 'the "regular" chunk grid needs "chunk_shape": an array of positive integers',
			},
		];
	}
	return [];
}

export function formatIssue(issue: MetadataIssue): string {
	const where = issue.path.length === 0 ? "document" : issue.path.join(".");
	return `${where}: ${issue.message}`;
}

export function issueSummary(issues: MetadataIssue[]): string {
	return `${issues.length} metadata issue${issues.length === 1 ? "" : "s"}`;
}
