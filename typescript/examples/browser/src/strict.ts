/**
 * Strict JSON parsing with a graceful browser fallback. zarr-inline's
 * strictParse needs JSON.parse reviver source access (exact big-integer
 * digits); every current engine ships it, but if one doesn't we fall back
 * to plain JSON.parse and tell the caller fidelity may be reduced.
 */

import { strictParse } from "../../../src/document.js";

export interface ParsedText {
	value: unknown;
	/** True when the fallback parser ran (big integers may have rounded). */
	lossy: boolean;
}

let hasSourceAccess: boolean | null = null;

export function parseJsonText(text: string): ParsedText {
	if (hasSourceAccess !== false) {
		try {
			const value = strictParse(text);
			hasSourceAccess = true;
			return { value, lossy: false };
		} catch (error) {
			if (
				hasSourceAccess === null &&
				String(error).includes("reviver source access")
			) {
				hasSourceAccess = false;
			} else {
				throw error;
			}
		}
	}
	return { value: JSON.parse(text), lossy: true };
}
