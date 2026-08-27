/**
 * The JSON panel: every document key owned by the selected node — its
 * zarr.json and its chunk/data keys — as one flat, searchable, bounded
 * list. Each row is tagged with its encoding (JSON Object / JSON Array /
 * base64) and expands into a syntax-highlighted editor. Applying an edit
 * round-trips the value through the zarr-inline decode/encode pair, so
 * whatever is typed is stored in the document's canonical form.
 */

import type { Document } from "../../../src/backing.js";
import { canonicalStringify, decodeValue, encodeValue } from "../../../src/document.js";
import { createJsonEditor } from "./jsonhl.js";
import { renderFlatList, type ListRow } from "./list.js";
import type { NodeInfo } from "./model.js";
import { parseJsonText } from "./strict.js";

export interface JsonPanelCallbacks {
	/** Called after a successful edit was written into the document. */
	onDocumentChanged: () => void;
	/** Called when keys were added or removed: the hierarchy (and this
	 * panel) must re-render from a rebuilt model. */
	onKeysChanged: () => void;
}

/**
 * Pretty-print a document value without losing BigInt fidelity
 * (JSON.stringify throws on BigInt; canonicalStringify handles every
 * primitive the document model allows). Arrays of primitives stay on one
 * line so chunk matrices read as one row per line.
 */
export function prettyJson(value: unknown, indent = 0): string {
	const pad = "  ".repeat(indent);
	const inner = "  ".repeat(indent + 1);
	if (Array.isArray(value)) {
		if (value.length === 0) return "[]";
		if (value.every((v) => v === null || typeof v !== "object")) {
			return `[${value.map((v) => canonicalStringify(v)).join(", ")}]`;
		}
		const items = value.map((v) => inner + prettyJson(v, indent + 1));
		return `[\n${items.join(",\n")}\n${pad}]`;
	}
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length === 0) return "{}";
		const items = entries.map(
			([k, v]) => `${inner}${JSON.stringify(k)}: ${prettyJson(v, indent + 1)}`,
		);
		return `{\n${items.join(",\n")}\n${pad}}`;
	}
	return canonicalStringify(value);
}

export function valueTag(value: unknown): { tag: string; tagClass: string } {
	if (typeof value === "string") return { tag: "base64", tagClass: "tag-b64" };
	if (Array.isArray(value)) return { tag: "JSON Array", tagClass: "tag-array" };
	if (value !== null && typeof value === "object") {
		return { tag: "JSON Object", tagClass: "tag-object" };
	}
	return { tag: "JSON value", tagClass: "tag-other" };
}

// Panel UI state, reset when the selected node changes.
let search = "";
let expandedKey: string | null = null;
let lastNodePath: string | null = null;
let rerender: () => void = () => {};
// Editor feedback that survives the post-apply re-render (which refreshes
// the row's encoding tag and byte size).
let pendingStatus: { key: string; text: string; ok: boolean } | null = null;

export function renderJsonPanel(
	container: HTMLElement,
	doc: Document,
	node: NodeInfo | null,
	callbacks: JsonPanelCallbacks,
): void {
	rerender = () => renderJsonPanel(container, doc, node, callbacks);
	container.replaceChildren();
	if (node === null) {
		container.append(hint("Select a node in the hierarchy."));
		return;
	}
	if (node.path !== lastNodePath) {
		lastNodePath = node.path;
		search = "";
		expandedKey = node.metaKey; // metadata starts expanded
	}

	const keys: { name: string; key: string }[] = [];
	if (node.metaKey !== null) keys.push({ name: "zarr.json", key: node.metaKey });
	const prefixLength = node.path === "" ? 0 : node.path.length + 1;
	for (const key of node.dataKeys) keys.push({ name: key.slice(prefixLength), key });

	const header = document.createElement("div");
	header.className = "section-header";
	const title = document.createElement("strong");
	title.textContent = node.path === "" ? "/" : node.path;
	const count = document.createElement("code");
	count.textContent = `${keys.length} key${keys.length === 1 ? "" : "s"}`;
	header.append(title, count);
	container.append(header);

	if (keys.length === 0) {
		container.append(
			hint("This node has no document keys — it only exists as a path prefix of other keys."),
		);
		return;
	}

	const listHost = document.createElement("div");
	container.append(listHost);
	const rows: ListRow[] = keys.map(({ name, key }) => {
		const value = doc[key];
		const { tag, tagClass } = valueTag(value);
		const row: ListRow = {
			name,
			tag,
			tagClass,
			detail: byteSize(key, value),
			path: key,
			selected: expandedKey === key,
			onSelect: () => {
				expandedKey = expandedKey === key ? null : key;
				rerender();
			},
		};
		if (expandedKey === key) {
			row.expanded = (slot) => slot.append(editor(doc, key, callbacks));
		}
		return row;
	});
	renderFlatList(listHost, {
		rows,
		search,
		onSearch: (value) => {
			search = value;
		},
		capacity: 100,
		placeholder: "filter keys by prefix (e.g. c/) …",
	});

	container.append(addKeyRow(doc, node, callbacks));
}

/** Create a new key under the node (e.g. a 2-D chunk after a 3-D → 2-D
 * metadata edit) and open it in the editor immediately. */
function addKeyRow(
	doc: Document,
	node: NodeInfo,
	callbacks: JsonPanelCallbacks,
): HTMLElement {
	const row = document.createElement("div");
	row.className = "add-key-row";
	const input = document.createElement("input");
	input.type = "text";
	input.className = "list-search";
	input.placeholder = "new key (e.g. c/0/0) …";
	const button = document.createElement("button");
	button.textContent = "Add key";
	const submit = () => {
		const name = input.value.trim().replace(/^\/+|\/+$/g, "");
		if (name === "") return;
		const key = node.path === "" ? name : `${node.path}/${name}`;
		if (key in doc) {
			input.setCustomValidity("key already exists");
			input.reportValidity();
			return;
		}
		// An empty base64 payload is a valid starting value for any key
		// class except metadata, which starts as an empty object.
		doc[key] = key.endsWith("zarr.json") ? {} : "";
		expandedKey = key;
		search = "";
		callbacks.onKeysChanged();
	};
	button.addEventListener("click", submit);
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter") submit();
		input.setCustomValidity("");
	});
	row.append(input, button);
	return row;
}

function byteSize(key: string, value: unknown): string {
	try {
		return `${decodeValue(key, value).length} B`;
	} catch {
		return "unreadable";
	}
}

function editor(doc: Document, key: string, callbacks: JsonPanelCallbacks): HTMLElement {
	const wrap = document.createElement("div");
	wrap.className = "editor";
	const jsonEditor = createJsonEditor(prettyJson(doc[key]));
	const status = document.createElement("div");
	status.className = "editor-status";
	if (pendingStatus !== null && pendingStatus.key === key) {
		status.className = `editor-status ${pendingStatus.ok ? "ok" : "error"}`;
		status.textContent = pendingStatus.text;
		pendingStatus = null;
	}
	const apply = document.createElement("button");
	apply.textContent = "Apply";
	const revert = document.createElement("button");
	revert.textContent = "Revert";
	revert.addEventListener("click", () => {
		jsonEditor.setValue(prettyJson(doc[key]));
		status.textContent = "";
		status.className = "editor-status";
	});
	apply.addEventListener("click", () => {
		try {
			const parsed = parseJsonText(jsonEditor.getValue());
			// Round-trip through bytes: the document stores the canonical form.
			const bytes = decodeValue(key, parsed.value);
			doc[key] = encodeValue(key, bytes);
			pendingStatus = {
				key,
				ok: true,
				text: parsed.lossy
					? "applied (this browser lacks JSON.parse source access; huge integers may have lost precision)"
					: "applied",
			};
			callbacks.onDocumentChanged();
			rerender(); // refresh this row's encoding tag and byte size
		} catch (error) {
			status.className = "editor-status error";
			status.textContent = String(error instanceof Error ? error.message : error);
		}
	});
	const remove = document.createElement("button");
	remove.textContent = "Delete key";
	remove.className = "danger";
	remove.addEventListener("click", () => {
		delete doc[key];
		if (expandedKey === key) expandedKey = null;
		callbacks.onKeysChanged();
	});
	const row = document.createElement("div");
	row.className = "editor-buttons";
	row.append(apply, revert, remove, status);
	wrap.append(jsonEditor.root, row);
	return wrap;
}

function hint(text: string): HTMLElement {
	const p = document.createElement("p");
	p.className = "hint";
	p.textContent = text;
	return p;
}
