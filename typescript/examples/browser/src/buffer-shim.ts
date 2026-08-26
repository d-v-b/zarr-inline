/**
 * Minimal Buffer substitute injected by esbuild so the zarr-inline sources
 * (which use Buffer only for base64 encode/decode) run in the browser.
 */
class Bytes extends Uint8Array {
	override toString(encoding?: string): string {
		if (encoding === "base64") {
			let binary = "";
			for (let i = 0; i < this.length; i++) binary += String.fromCharCode(this[i]);
			return btoa(binary);
		}
		return new TextDecoder().decode(this);
	}
}

export const Buffer = {
	from(input: unknown, encoding?: string): Bytes {
		if (typeof input === "string") {
			if (encoding === "base64") {
				const binary = atob(input);
				const out = new Bytes(binary.length);
				for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
				return out;
			}
			return new Bytes(new TextEncoder().encode(input));
		}
		return new Bytes(input as ArrayLike<number>);
	},
};
