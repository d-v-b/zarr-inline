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
 * preserved; non-finite numbers rejected (JSON.stringify would silently emit
 * `null` for NaN/Infinity — the fill_value convention represents them as
 * strings like "NaN" instead). This form is shared by all zarr-json
 * implementations so that decoded bytes agree across languages.
 */
export function canonicalStringify(value: unknown): string {
	const text = JSON.stringify(value, (_key, v) => {
		if (typeof v === "number" && !Number.isFinite(v)) {
			throw new Error(
				"canonical JSON cannot represent non-finite numbers (NaN/Infinity); " +
					'use the fill_value string convention ("NaN", "Infinity", "-Infinity")',
			);
		}
		return v;
	});
	if (text === undefined) {
		throw new Error("value is not JSON-serializable");
	}
	return text;
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
		const parsed: unknown = JSON.parse(UTF8_DECODER.decode(data));
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
	let parsed: unknown;
	try {
		// JSON.parse rejects NaN/Infinity tokens (they are not JSON), so bytes
		// like "[NaN]" fall through to base64 here, matching canonical form.
		parsed = JSON.parse(UTF8_DECODER.decode(data));
	} catch {
		// Not UTF-8 or not JSON.
		return undefined;
	}
	if (!Array.isArray(parsed)) {
		return undefined;
	}
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
}
