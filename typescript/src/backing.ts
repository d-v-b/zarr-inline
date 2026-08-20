/**
 * Pluggable backings: where the zarr-json object lives and how it persists.
 *
 * A Backing has two operations: load() returns the document object, persist()
 * writes a document object. The store logic is identical regardless of backing.
 */

export type Document = Record<string, unknown>;

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
		this.#document = document;
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
		return JSON.parse(this.#text) as Document;
	}

	persist(document: Document): void {
		this.#text = JSON.stringify(document);
	}

	dumps(): string {
		return this.#text;
	}
}
