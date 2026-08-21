/**
 * Pure functions for classifying keys and encoding/decoding values.
 *
 * A zarr-json value is one of:
 *
 * - metadata key (`zarr.json` or `*\/zarr.json`) -> inline JSON object
 * - byte key -> base64 string (opaque bytes), or a JSON array (inline data
 *   values, produced by the `json` array->bytes codec)
 *
 * Inline arrays use a canonical JSON serialization (no whitespace, no NaN /
 * Infinity tokens) so that parse -> re-serialize is byte-identical. That makes
 * the inlining rule in encodeValue lossless by construction: a byte value is
 * inlined only if its bytes are exactly the canonical serialization of a JSON
 * array, so decodeValue reproduces the original bytes no matter what they
 * actually were.
 */

export const METADATA_SUFFIX = "zarr.json";

/** Return true if the key names a Zarr v3 metadata document. */
export function isMetadataKey(key: string): boolean {
	return key === METADATA_SUFFIX || key.endsWith("/" + METADATA_SUFFIX);
}

/**
 * Serialize a JSON value in the canonical zarr-json form.
 *
 * No whitespace; non-ASCII characters unescaped (UTF-8); object member order
 * preserved. Numbers follow RFC 8785 (JCS): ECMAScript Number::toString,
 * which is exactly `String(v)` in JavaScript — so canonical output is
 * byte-identical to `JSON.stringify` compact output for portable values
 * (negative zero prints `0`; Python and Rust implement ES ToString to match),
 * with three deliberate divergences that keep decoded bytes identical
 * across languages:
 *
 * - non-finite numbers are an error (JSON.stringify would silently emit
 *   `null` — the fill_value convention represents them as strings like
 *   "NaN" instead);
 * - bigint values serialize as exact integer digits (strictParse produces
 *   them for integer literals outside the float64-safe range, so integers
 *   of any size round-trip losslessly, like Python's arbitrary ints);
 * - strings that are not well-formed UTF-16 (lone surrogates) are an error,
 *   matching Python's UTF-8 encode failure, instead of being escaped into
 *   bytes no other implementation can produce.
 */
export function canonicalStringify(value: unknown): string {
	if (
		value === undefined ||
		typeof value === "function" ||
		typeof value === "symbol"
	) {
		throw new Error("value is not JSON-serializable");
	}
	const parts: string[] = [];
	writeCanonical(value, parts);
	return parts.join("");
}

const STRING_ESCAPES: Record<string, string> = {
	'"': '\\"',
	"\\": "\\\\",
	"\b": "\\b",
	"\t": "\\t",
	"\n": "\\n",
	"\f": "\\f",
	"\r": "\\r",
};

// eslint-disable-next-line no-control-regex
const STRING_ESCAPE_RE = /[\u0000-\u001f"\\]/g;

function writeCanonicalString(value: string, parts: string[]): void {
	if (!value.isWellFormed()) {
		throw new Error(
			"canonical JSON cannot encode a string containing a lone surrogate " +
				"(it has no UTF-8 encoding)",
		);
	}
	parts.push(
		'"',
		value.replace(
			STRING_ESCAPE_RE,
			(ch) =>
				STRING_ESCAPES[ch] ??
				"\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"),
		),
		'"',
	);
}

function writeCanonicalNumber(value: number, parts: string[]): void {
	if (!Number.isFinite(value)) {
		throw new Error(
			"canonical JSON cannot represent non-finite numbers (NaN/Infinity); " +
				'use the fill_value string convention ("NaN", "Infinity", "-Infinity")',
		);
	}
	// RFC 8785 numbers are ES Number::toString, which is exactly String(v);
	// note String(-0) === "0" — the sign of negative zero is not preserved
	// (Python and Rust emit "0" for -0.0 as well).
	parts.push(String(value));
}

function isUnserializable(value: unknown): boolean {
	return (
		value === undefined ||
		typeof value === "function" ||
		typeof value === "symbol"
	);
}

function writeCanonical(value: unknown, parts: string[]): void {
	if (value === null) {
		parts.push("null");
		return;
	}
	switch (typeof value) {
		case "boolean":
			parts.push(value ? "true" : "false");
			return;
		case "number":
			writeCanonicalNumber(value, parts);
			return;
		case "bigint":
			// Exact integer digits, any size (RFC 8785 integers-as-digits).
			parts.push(value.toString());
			return;
		case "string":
			writeCanonicalString(value, parts);
			return;
		case "object":
			break;
		default:
			// bigint, and anything the language grows later.
			throw new Error(`value is not JSON-serializable: ${typeof value}`);
	}
	if (Array.isArray(value)) {
		parts.push("[");
		for (let i = 0; i < value.length; i++) {
			if (i > 0) {
				parts.push(",");
			}
			const element: unknown = value[i];
			// JSON.stringify emits null for unserializable array elements.
			if (isUnserializable(element)) {
				parts.push("null");
			} else {
				writeCanonical(element, parts);
			}
		}
		parts.push("]");
		return;
	}
	parts.push("{");
	let first = true;
	for (const [key, member] of Object.entries(value)) {
		// JSON.stringify skips unserializable object members.
		if (isUnserializable(member)) {
			continue;
		}
		if (!first) {
			parts.push(",");
		}
		first = false;
		writeCanonicalString(key, parts);
		parts.push(":");
		writeCanonical(member, parts);
	}
	parts.push("}");
}

/**
 * Compare two strings by Unicode code points (not UTF-16 code units), the
 * order Python's `sorted()` uses. "😀" (U+1F600) sorts after "\uffff", where
 * UTF-16 code-unit order would place its surrogate pair before it.
 */
export function compareCodePoints(a: string, b: string): number {
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		const ca = a.codePointAt(i) as number;
		const cb = b.codePointAt(j) as number;
		if (ca !== cb) {
			return ca < cb ? -1 : 1;
		}
		i += ca > 0xffff ? 2 : 1;
		j += cb > 0xffff ? 2 : 1;
	}
	return (a.length - i) - (b.length - j);
}

/**
 * Walk a parsed JSON value and reject any non-finite number.
 *
 * JSON.parse rejects NaN/Infinity tokens, so the only way a non-finite
 * number appears is overflow of a literal like 1e400 — which Python and
 * Rust reject at parse time (see strict_loads / serde_json). Rejecting here
 * keeps the three implementations agreeing on which documents are readable.
 */
export function assertNumbersFinite(value: unknown): void {
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error("number literal overflows float64 (e.g. 1e400)");
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const element of value) {
			assertNumbersFinite(element);
		}
		return;
	}
	if (typeof value === "object" && value !== null) {
		for (const member of Object.values(value)) {
			assertNumbersFinite(member);
		}
	}
}

const INTEGER_LITERAL_RE = /^-?\d+$/;

type ReviverContext = { source?: string };

// JSON.parse reviver source-text access (Node >= 21 / V8's rawJSON
// proposal). Without it, integer literals beyond 2^53 are silently rounded
// before user code can see them, so lossless integers are impossible.
const HAS_REVIVER_SOURCE: boolean = (() => {
	let seen = false;
	JSON.parse("0", (_key: string, value: unknown, context?: ReviverContext) => {
		seen = typeof context?.source === "string";
		return value;
	});
	return seen;
})();

/**
 * Parse JSON like Python's strict_loads, losslessly.
 *
 * - Integer literals (no ".", "e", "E") outside the float64-safe range parse
 *   as bigint, using the reviver's source-text access (Node >= 21), so
 *   integers of any size survive exactly — JSON.parse alone would silently
 *   round them to the nearest double.
 * - Number literals that overflow float64 (e.g. 1e400) are rejected, like
 *   Python's strict_loads and Rust's serde_json.
 */
export interface StrictParseOptions {
	/**
	 * Parse EVERY integer-literal token as bigint, not just those outside
	 * the float64-safe range. This preserves the JSON number sort (integer
	 * vs float64) of every token, which the json codec's decoder needs to
	 * reject float tokens like `1.0` for integer data types (SPEC §9.2).
	 */
	integersAsBigInt?: boolean;
}

export function strictParse(text: string, options: StrictParseOptions = {}): unknown {
	if (!HAS_REVIVER_SOURCE) {
		throw new Error(
			"zarr-json requires JSON.parse reviver source access (Node >= 21) " +
				"to parse integers losslessly",
		);
	}
	return JSON.parse(
		text,
		(_key: string, value: unknown, context?: ReviverContext) => {
			if (typeof value === "number") {
				const source = context?.source;
				if (
					source !== undefined &&
					(options.integersAsBigInt || !Number.isSafeInteger(value)) &&
					INTEGER_LITERAL_RE.test(source)
				) {
					return BigInt(source);
				}
				if (!Number.isFinite(value)) {
					throw new Error("number literal overflows float64 (e.g. 1e400)");
				}
			}
			return value;
		},
	);
}

const BASE64_RE =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Strict standard base64 decode (padding required).
 *
 * `Buffer.from(str, "base64")` is lenient — it ignores invalid characters and
 * tolerates missing padding — so the string is validated against the standard
 * alphabet with correct padding first. Non-zero trailing padding bits (e.g.
 * "AB==") are accepted, matching the Python reference implementation
 * (`base64.b64decode(..., validate=True)`) and the Rust implementation.
 */
export function base64Decode(text: string): Uint8Array {
	if (!BASE64_RE.test(text)) {
		throw new Error(`invalid base64 string: ${JSON.stringify(text)}`);
	}
	return new Uint8Array(Buffer.from(text, "base64"));
}

/** Standard base64 encode (with padding). */
export function base64Encode(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const UTF8_ENCODER = new TextEncoder();
// fatal: reject invalid UTF-8 (mirrors Python's decode errors); ignoreBOM:
// preserve a leading U+FEFF so re-encoding is byte-exact.
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Convert a stored zarr-json value into the bytes Zarr expects.
 *
 * Metadata keys hold a JSON object -> serialize to canonical UTF-8 JSON bytes.
 * Byte keys hold a base64 string -> base64-decode to raw bytes, or a JSON
 * array -> canonical-serialize to UTF-8 JSON bytes.
 */
export function decodeValue(key: string, value: unknown): Uint8Array {
	if (isMetadataKey(key)) {
		if (!isPlainObject(value)) {
			throw new Error(`metadata key ${JSON.stringify(key)} must map to a JSON object`);
		}
		return UTF8_ENCODER.encode(canonicalStringify(value));
	}
	if (Array.isArray(value)) {
		return UTF8_ENCODER.encode(canonicalStringify(value));
	}
	if (typeof value !== "string") {
		throw new Error(
			`byte key ${JSON.stringify(key)} must map to a base64 string or JSON array`,
		);
	}
	return base64Decode(value);
}

/**
 * Convert Zarr's bytes into the value stored in a zarr-json document.
 *
 * Metadata keys: parse bytes as JSON, require a JSON object.
 * Byte keys: inline as a JSON array if the bytes are exactly the canonical
 * serialization of one (lossless by construction); otherwise base64-encode.
 */
export function encodeValue(key: string, data: Uint8Array): unknown {
	if (isMetadataKey(key)) {
		// strictParse: a metadata document containing an overflowing number
		// literal like 1e400 is an error (Python/Rust reject it at parse time).
		const parsed: unknown = strictParse(UTF8_DECODER.decode(data));
		if (!isPlainObject(parsed)) {
			throw new Error(
				`metadata key ${JSON.stringify(key)} requires a JSON object value`,
			);
		}
		return parsed;
	}
	const inlined = tryInlineArray(data);
	if (inlined !== undefined) {
		return inlined;
	}
	return base64Encode(data);
}

/** Return the parsed JSON array if inlining `data` is lossless, else undefined. */
function tryInlineArray(data: Uint8Array): unknown[] | undefined {
	try {
		// strictParse rejects NaN/Infinity tokens and float64 overflow, and
		// parses big integer literals as bigint — so bytes like
		// "[9007199254740993]" inline losslessly instead of falling back to
		// base64, while "[NaN]" and "[1e400]" fall through to base64.
		const parsed: unknown = strictParse(UTF8_DECODER.decode(data));
		if (!Array.isArray(parsed)) {
			return undefined;
		}
		// canonicalStringify must stay inside the try: bytes that parse as
		// JSON but cannot be canonicalized (e.g. "[1e400]", whose parse
		// overflows to Infinity) must fall back to base64, matching Python.
		const canonical = UTF8_ENCODER.encode(canonicalStringify(parsed));
		if (canonical.length !== data.length) {
			return undefined;
		}
		for (let i = 0; i < canonical.length; i++) {
			if (canonical[i] !== data[i]) {
				return undefined;
			}
		}
		return parsed;
	} catch {
		// Not UTF-8, not JSON, or not canonicalizable.
		return undefined;
	}
}
