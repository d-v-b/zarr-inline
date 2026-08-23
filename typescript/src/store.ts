/**
 * ZarrJsonStore: a read-write zarrita store backed by a JSON object.
 *
 * Conforms to zarrita's `AsyncMutable` store interface
 * (`AsyncReadable & AsyncWritable` from `@zarrita/storage`), including the
 * optional `getRange` partial read. zarrita store keys are `AbsolutePath`
 * strings starting with "/"; the leading "/" is stripped to obtain zarr-json
 * document keys.
 */

import type { AbsolutePath, AsyncMutable, RangeQuery } from "@zarrita/storage";
import { toNullPrototype, type Backing, type Document } from "./backing.js";
import {
	canonicalStringify,
	decodeValue,
	encodeValue,
	isMetadataKey,
} from "./codec.js";
import { checkKey, validate, type ValidationIssue } from "./validator.js";

const UTF8_ENCODER = new TextEncoder();

export interface ZarrJsonStoreOptions {
	/** Refuse set/delete when true. Default false. */
	readOnly?: boolean;
	/** Throw ValidationError on construction if the document is invalid. */
	strict?: boolean;
	/**
	 * Called for each validator issue in lenient mode.
	 * Defaults to a console.warn diagnostic.
	 */
	onIssue?: (issue: ValidationIssue) => void;
}

function applyRange(data: Uint8Array, range: RangeQuery): Uint8Array {
	if ("suffixLength" in range) {
		// Index arithmetic, not negative slicing: slice(-0) would wrongly
		// return the whole array instead of empty bytes.
		return data.slice(Math.max(0, data.length - range.suffixLength));
	}
	return data.slice(range.offset, range.offset + range.length);
}

/**
 * A Zarr v3 store whose entire contents live in one JSON object.
 *
 * Construct from a Backing (memory / string). All operations are serialized
 * by an async mutex (JS is single-threaded, but operations interleave at
 * await points). Mutating operations call backing.persist().
 */
export class ZarrJsonStore implements AsyncMutable {
	#backing: Backing;
	#document: Document;
	#readOnly: boolean;
	#lock: Promise<unknown> = Promise.resolve();
	// Lenient mode: keys with validation issues behave as absent (SPEC §8.1)
	// while staying in the document text, so unrecognized-but-future-valid
	// values are never destroyed by a re-persist. A successful set clears
	// the key's skip.
	#skipped: Set<string> = new Set();

	constructor(backing: Backing, options: ZarrJsonStoreOptions = {}) {
		this.#backing = backing;
		this.#readOnly = options.readOnly ?? false;
		// Documents must be null-prototype objects so that keys like
		// "__proto__" are ordinary own properties (see backing.ts). The
		// shipped backings already guarantee this; re-key defensively for
		// custom backings that hand over a plain object.
		const loaded = backing.load();
		this.#document =
			Object.getPrototypeOf(loaded) === null ? loaded : toNullPrototype(loaded);
		if (options.strict) {
			validate(this.#document, { strict: true });
		} else {
			const onIssue =
				options.onIssue ??
				((issue: ValidationIssue) =>
					console.warn(
						`zarr-json validation [${issue.rule}] ${issue.key}: ${issue.message}`,
					));
			for (const issue of validate(this.#document)) {
				this.#skipped.add(issue.key);
				onIssue(issue);
			}
		}
	}

	get readOnly(): boolean {
		return this.#readOnly;
	}

	/** Run fn with the store lock held; operations execute in FIFO order. */
	#withLock<T>(fn: () => T): Promise<T> {
		const run = this.#lock.then(fn);
		this.#lock = run.catch(() => undefined);
		return run;
	}

	#docKey(key: AbsolutePath): string {
		return key.startsWith("/") ? key.slice(1) : key;
	}

	#checkWritable(): void {
		if (this.#readOnly) {
			throw new Error("store is read-only");
		}
	}

	#present(docKey: string): boolean {
		return Object.hasOwn(this.#document, docKey) && !this.#skipped.has(docKey);
	}

	async get(key: AbsolutePath): Promise<Uint8Array | undefined> {
		return this.#withLock(() => {
			const docKey = this.#docKey(key);
			if (!this.#present(docKey)) {
				return undefined;
			}
			return decodeValue(docKey, this.#document[docKey]);
		});
	}

	async getRange(
		key: AbsolutePath,
		range: RangeQuery,
	): Promise<Uint8Array | undefined> {
		const data = await this.get(key);
		if (data === undefined) {
			return undefined;
		}
		return applyRange(data, range);
	}

	async set(key: AbsolutePath, value: Uint8Array): Promise<void> {
		return this.#setBytes(key, value);
	}

	/**
	 * Store a JSON value at `key`, canonicalized first. Equivalent to
	 * `set(key, utf8(canonicalStringify(value)))` — the value is guaranteed
	 * to land in the document as its inline JSON representation, so callers
	 * need not produce canonical text themselves. The value must fit the
	 * key's representation (R2): a JSON object at a metadata key, a JSON
	 * array at a byte key.
	 */
	async setJson(key: AbsolutePath, value: unknown): Promise<void> {
		const docKey = this.#docKey(key);
		if (isMetadataKey(docKey)) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				throw new Error(
					`setJson: metadata key ${JSON.stringify(docKey)} takes a JSON object`,
				);
			}
		} else if (
			!Array.isArray(value) &&
			(typeof value !== "object" || value === null)
		) {
			throw new Error(
				`setJson: byte key ${JSON.stringify(docKey)} takes a JSON array or object`,
			);
		}
		return this.#setBytes(key, UTF8_ENCODER.encode(canonicalStringify(value)));
	}

	async #setBytes(key: AbsolutePath, value: Uint8Array): Promise<void> {
		this.#checkWritable();
		// The Zarr v3 spec defines well-formed store keys; rejecting the rest
		// here keeps every document this store produces valid (R1). The check
		// runs on the document key (leading "/" stripped) before any mutation.
		const docKey = this.#docKey(key);
		const issue = checkKey(docKey);
		if (issue !== undefined) {
			throw new Error(
				`invalid store key ${JSON.stringify(docKey)}: ${issue.message}`,
			);
		}
		return this.#withLock(() => {
			const encoded = encodeValue(docKey, value);
			// A failed set MUST leave the document unchanged (SPEC §8.2): if
			// persist throws, restore the previous entry before rethrowing.
			const had = Object.hasOwn(this.#document, docKey);
			const previous = this.#document[docKey];
			this.#document[docKey] = encoded;
			try {
				this.#backing.persist(this.#document);
			} catch (err) {
				if (had) {
					this.#document[docKey] = previous;
				} else {
					delete this.#document[docKey];
				}
				throw err;
			}
			this.#skipped.delete(docKey);
		});
	}

	async delete(key: AbsolutePath): Promise<void> {
		this.#checkWritable();
		return this.#withLock(() => {
			const docKey = this.#docKey(key);
			const had = Object.hasOwn(this.#document, docKey);
			const previous = this.#document[docKey];
			delete this.#document[docKey];
			try {
				this.#backing.persist(this.#document);
			} catch (err) {
				if (had) {
					this.#document[docKey] = previous;
				}
				throw err;
			}
			this.#skipped.delete(docKey);
		});
	}

	async has(key: AbsolutePath): Promise<boolean> {
		return this.#withLock(() => this.#present(this.#docKey(key)));
	}

	/** All usable document keys (zarr-json keys, without a leading "/"). */
	async list(): Promise<string[]> {
		return this.#withLock(() =>
			Object.keys(this.#document).filter((k) => !this.#skipped.has(k)),
		);
	}
}
