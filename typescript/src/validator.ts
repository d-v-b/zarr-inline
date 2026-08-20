/**
 * Validate a zarr-json document against the two validity rules.
 *
 * R1 — well-formed keys: every key is a non-empty string with no leading or
 *      trailing "/", no empty segments, and no "." or ".." segments.
 * R2 — per-value type: metadata keys map to a JSON object; byte keys map to a
 *      base64 string or an inline JSON array.
 */

import { isMetadataKey } from "./codec.js";

export interface ValidationIssue {
	rule: "R1" | "R2";
	key: string;
	message: string;
}

/** Thrown by validate() in strict mode when a document is invalid. */
export class ValidationError extends Error {
	readonly issues: ValidationIssue[];

	constructor(issues: ValidationIssue[]) {
		const joined = issues
			.map((i) => `[${i.rule}] ${i.key}: ${i.message}`)
			.join("; ");
		super(`invalid zarr-json document: ${joined}`);
		this.name = "ValidationError";
		this.issues = issues;
	}
}

function checkKeyWellFormed(key: string): ValidationIssue | undefined {
	if (typeof key !== "string" || key === "") {
		return { rule: "R1", key: String(key), message: "key must be a non-empty string" };
	}
	if (key.startsWith("/") || key.endsWith("/")) {
		return { rule: "R1", key, message: "key must not have a leading or trailing '/'" };
	}
	for (const seg of key.split("/")) {
		if (seg === "") {
			return { rule: "R1", key, message: "key must not have empty segments" };
		}
		if (seg === "." || seg === "..") {
			return { rule: "R1", key, message: "key must not have '.' or '..' segments" };
		}
	}
	return undefined;
}

function checkValueType(key: string, value: unknown): ValidationIssue | undefined {
	if (isMetadataKey(key)) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return { rule: "R2", key, message: "metadata key must map to a JSON object" };
		}
	} else if (typeof value !== "string" && !Array.isArray(value)) {
		return {
			rule: "R2",
			key,
			message: "byte key must map to a base64 string or JSON array",
		};
	}
	return undefined;
}

export interface ValidateOptions {
	/** When true, throw ValidationError if any issue is found. Default false. */
	strict?: boolean;
}

/**
 * Check a zarr-json document. Returns the list of issues (empty if valid).
 *
 * At most one issue is reported per key; R1 (well-formed key) takes
 * precedence — the value-type check on a malformed key is not meaningful.
 */
export function validate(
	document: Record<string, unknown>,
	options: ValidateOptions = {},
): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	for (const [key, value] of Object.entries(document)) {
		const keyIssue = checkKeyWellFormed(key);
		if (keyIssue !== undefined) {
			issues.push(keyIssue);
			continue;
		}
		const valueIssue = checkValueType(key, value);
		if (valueIssue !== undefined) {
			issues.push(valueIssue);
		}
	}
	if (options.strict && issues.length > 0) {
		throw new ValidationError(issues);
	}
	return issues;
}
