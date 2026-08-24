/**
 * Conformance harness: shared cross-implementation behavior as a CLI.
 *
 * Reads a zarr-inline document (a JSON object) on stdin and writes a JSON
 * report on stdout:
 *
 * - "issues": validator issues, sorted by (key, rule).
 * - "decoded": for every issue-free key that decodes, base64 of the bytes
 *   decodeValue returns (the bytes a Zarr library would see).
 * - "reencoded": encodeValue(key, decoded_bytes) for every decoded key.
 * - "errors": sorted keys that passed validation but failed to decode (e.g.
 *   a byte key whose string value is not valid base64).
 *
 * The Python and Rust implementations ship the same harness; the Python
 * property test generates documents and requires the reports to agree. See
 * https://github.com/d-v-b/zarr-inline/blob/main/docs/how-it-works.md#61-conformance-harness-protocol
 *
 * Run: node dist/conformance.js  (reads stdin)
 */

import { pathToFileURL } from "node:url";

import {
	strictParse,
	base64Encode,
	canonicalStringify,
	compareCodePoints,
	decodeValue,
	encodeValue,
} from "./document.js";
import { validate } from "./validator.js";

export interface ConformanceReport {
	issues: { rule: string; key: string }[];
	decoded: Record<string, string>;
	reencoded: Record<string, unknown>;
	errors: string[];
}

export function run(document: Record<string, unknown>): ConformanceReport {
	const issues = validate(document);
	const issueKeys = new Set(issues.map((i) => i.key));
	const decoded: Record<string, string> = {};
	const reencoded: Record<string, unknown> = {};
	const errors: string[] = [];
	for (const [key, value] of Object.entries(document)) {
		if (issueKeys.has(key)) {
			continue;
		}
		let data: Uint8Array;
		try {
			data = decodeValue(key, value);
		} catch {
			// A decode failure on one key must not abort the report.
			errors.push(key);
			continue;
		}
		decoded[key] = base64Encode(data);
		reencoded[key] = encodeValue(key, data);
	}
	// Sort by Unicode code points, matching Python's sorted(): "😀/" must
	// sort after "/", where UTF-16 code-unit order would put it first.
	const sortedIssues = issues
		.map((i) => ({ rule: i.rule as string, key: i.key }))
		.sort(
			(a, b) =>
				compareCodePoints(a.key, b.key) || compareCodePoints(a.rule, b.rule),
		);
	errors.sort(compareCodePoints);
	return { issues: sortedIssues, decoded, reencoded, errors };
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
		// strictParse: rejects float64 overflow (1e400) like Python and Rust,
		// and parses big integer literals losslessly as bigint.
		document = strictParse(text);
	} catch (err) {
		process.stderr.write(`invalid JSON input: ${String(err)}\n`);
		return 1;
	}
	if (typeof document !== "object" || document === null || Array.isArray(document)) {
		process.stderr.write("input must be a JSON object\n");
		return 1;
	}
	let report: string;
	try {
		// canonicalStringify (not JSON.stringify): a lone surrogate in a key
		// must be a loud error, matching Python's "cannot encode report".
		report = canonicalStringify(run(document as Record<string, unknown>));
	} catch (err) {
		process.stderr.write(`cannot encode report: ${String(err)}\n`);
		return 1;
	}
	process.stdout.write(report);
	return 0;
}

// Only run the CLI when executed directly (not when imported by tests).
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
	main().then((code) => {
		process.exitCode = code;
	});
}
