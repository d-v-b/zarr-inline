/**
 * Neuroglancer-style URL state: the whole zarr-inline document travels in
 * the URL fragment so viewer links are shareable.
 *
 * - `#doc=<base64url(deflate-raw(canonical JSON))>` — the document inline.
 * - `#url=<location>` — fetch the document from an http(s) URL.
 * - no fragment — an empty document.
 */

const URL_DOC_LIMIT = 500_000; // base64url chars; beyond this, don't sync

export async function compressToParam(text: string): Promise<string> {
	const stream = new Blob([text])
		.stream()
		.pipeThrough(new CompressionStream("deflate-raw"));
	const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
	let binary = "";
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function decompressFromParam(param: string): Promise<string> {
	const b64 = param.replaceAll("-", "+").replaceAll("_", "/");
	const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=");
	const binary = atob(padded);
	const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
	const stream = new Blob([bytes])
		.stream()
		.pipeThrough(new DecompressionStream("deflate-raw"));
	return await new Response(stream).text();
}

export interface FragmentState {
	kind: "doc" | "url" | "empty";
	value: string;
}

export function parseFragment(hash: string): FragmentState {
	const params = new URLSearchParams(hash.replace(/^#/, ""));
	const doc = params.get("doc");
	if (doc !== null && doc !== "") return { kind: "doc", value: doc };
	const url = params.get("url");
	if (url !== null && url !== "") return { kind: "url", value: url };
	return { kind: "empty", value: "" };
}

/**
 * Encode the document text into a fragment, or null when it is too large
 * to share by URL.
 */
export async function fragmentForDocument(text: string): Promise<string | null> {
	const param = await compressToParam(text);
	if (param.length > URL_DOC_LIMIT) return null;
	return `#doc=${param}`;
}
