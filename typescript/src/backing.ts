/**
 * Pluggable backings: where the zarr-json object lives and how it persists.
 *
 * A Backing has two operations: load() returns the document object, persist()
 * writes a document object. The store logic is identical regardless of backing.
 *
 * Documents are held as null-prototype objects: a zarr-json key is an
 * arbitrary string, and on a plain object assigning the key "__proto__" hits
 * the inherited Object.prototype setter instead of creating a property (a
 * silent-no-op write). Re-keying every accepted document onto
 * Object.create(null) makes reads and writes own-property-only.
 */

import { canonicalStringify, strictParse } from "./codec.js";

export type Document = Record<string, unknown>;

/** Copy a document's own enumerable members onto a null-prototype object. */
export function toNullPrototype(document: Document): Document {
	// The null-prototype target has no inherited "__proto__" setter, so
	// Object.assign creates an own property for every key, including
	// "__proto__" / "constructor" / "toString".
	return Object.assign(Object.create(null) as Document, document);
}

/**
 * A document's top-level value must be a JSON object (SPEC §6): arrays,
 * strings, numbers, null, etc. are document errors — re-keying an array
 * would silently turn its indices into store keys.
 */
export function requireDocumentObject(value: unknown): Document {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("document error: top-level value must be a JSON object");
	}
	return value as Document;
}

/**
 * Where a zarr-json document lives and how it persists.
 *
 * The store calls `load()` exactly once to obtain the document, mutates that
 * document in place, then calls `persist()` after each mutation.
 */
export interface Backing {
	load(): Document;
	persist(document: Document): void;
}

/** Holds the document in memory; the in-memory object is the source of truth. */
export class MemoryBacking implements Backing {
	#document: Document;

	constructor(document: Document = {}) {
		this.#document = toNullPrototype(requireDocumentObject(document));
	}

	load(): Document {
		return this.#document;
	}

	persist(document: Document): void {
		// The store mutates the same object it loaded; persist just records it.
		this.#document = document;
	}
}

/** Parses the document from a string; persist updates the dumped string. */
export class StringBacking implements Backing {
	#text: string;

	constructor(text = "{}") {
		this.#text = text;
	}

	/** Parse and return the document. Call once; see the Backing contract. */
	load(): Document {
		// strictParse rejects number literals that overflow float64 (1e400):
		// Python and Rust refuse such documents, so loading one here would
		// silently diverge.
		return toNullPrototype(requireDocumentObject(strictParse(this.#text)));
	}

	persist(document: Document): void {
		// canonicalStringify, not JSON.stringify: documents may hold bigint
		// (integers beyond 2^53), which JSON.stringify cannot serialize.
		this.#text = canonicalStringify(document);
	}

	dumps(): string {
		return this.#text;
	}
}
