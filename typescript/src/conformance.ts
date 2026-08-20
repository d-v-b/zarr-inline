/**
 * Conformance harness: shared cross-implementation behavior as a CLI.
 *
 * Reads a zarr-json document (a JSON object) on stdin and writes a JSON
 * report on stdout:
 *
 * - "issues": validator issues, sorted by (key, rule).
 * - "decoded": for every issue-free key, base64 of the bytes decodeValue
 *   returns (the bytes a Zarr library would see).
 * - "reencoded": encodeValue(key, decoded_bytes) for every decoded key.
 *
 * The Python and Rust implementations ship the same harness; the Python
 * property test generates documents and requires the reports to agree. See
 * docs/superpowers/specs/2026-08-20-conformance-protocol.md.
 *
 * Run: node dist/conformance.js  (reads stdin)
 */

import { pathToFileURL } from "node:url";

import { base64Encode, decodeValue, encodeValue } from "./codec.js";
import { validate } from "./validator.js";

export interface ConformanceReport {
	issues: { rule: string; key: string }[];
	decoded: Record<string, string>;
	reencoded: Record<string, unknown>;
}

export function run(document: Record<string, unknown>): ConformanceReport {
	const issues = validate(document);
	const issueKeys = new Set(issues.map((i) => i.key));
	const decoded: Record<string, string> = {};
	const reencoded: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(document)) {
		if (issueKeys.has(key)) {
			continue;
		}
		const data = decodeValue(key, value);
		decoded[key] = base64Encode(data);
		reencoded[key] = encodeValue(key, data);
	}
	const sortedIssues = issues
		.map((i) => ({ rule: i.rule as string, key: i.key }))
		.sort((a, b) =>
			a.key < b.key ? -1 : a.key > b.key ? 1 : a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0,
		);
	return { issues: sortedIssues, decoded, reencoded };
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf-8");
}

async function main(): Promise<number> {
	const text = await readStdin();
	let document: unknown;
	try {
		document = JSON.parse(text);
	} catch (err) {
		process.stderr.write(`input is not valid JSON: ${String(err)}\n`);
		return 1;
	}
	if (typeof document !== "object" || document === null || Array.isArray(document)) {
		process.stderr.write("input must be a JSON object\n");
		return 1;
	}
	process.stdout.write(JSON.stringify(run(document as Record<string, unknown>)));
	return 0;
}

// Only run the CLI when executed directly (not when imported by tests).
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
	main().then((code) => {
		process.exitCode = code;
	});
}
