/**
 * The JSON panel: the selected node's metadata and chunk keys as editable
 * JSON. Applying an edit round-trips the value through the zarr-inline
 * decode/encode pair, so whatever is typed is stored in the document's
 * canonical form (inline JSON when byte-stable, base64 otherwise).
 */

import type { Document } from "../../../src/backing.js";
import { canonicalStringify, decodeValue, encodeValue } from "../../../src/document.js";
import type { NodeInfo } from "./model.js";
import { parseJsonText } from "./strict.js";

export interface JsonPanelCallbacks {
	/** Called after a successful edit was written into the document. */
	onDocumentChanged: () => void;
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

export function renderJsonPanel(
	container: HTMLElement,
	doc: Document,
	node: NodeInfo | null,
	callbacks: JsonPanelCallbacks,
): void {
	container.replaceChildren();
	if (node === null) {
		container.append(hint("Select a node in the hierarchy."));
		return;
	}

	if (node.metaKey !== null) {
		container.append(
			sectionHeader("metadata", node.metaKey),
			editor(doc, node.metaKey, callbacks),
		);
	} else {
		container.append(
			sectionHeader("metadata", "(none)"),
			hint("This node has no zarr.json key — it only exists as a path prefix of other keys."),
		);
	}

	const label = node.kind === "array" ? "chunks" : "other keys";
	const header = sectionHeader(label, `${node.dataKeys.length} key${node.dataKeys.length === 1 ? "" : "s"}`);
	container.append(header);
	if (node.dataKeys.length === 0) {
		container.append(hint(node.kind === "array" ? "No chunks written yet." : "No non-metadata keys."));
		return;
	}
	for (const key of node.dataKeys) {
		const value = doc[key];
		const details = document.createElement("details");
		const summary = document.createElement("summary");
		const kindBadge = document.createElement("span");
		const isInline = typeof value !== "string";
		kindBadge.className = `chip ${isInline ? "chip-inline" : "chip-b64"}`;
		kindBadge.textContent = isInline ? "inline JSON" : "base64";
		const name = document.createElement("code");
		name.textContent = key;
		summary.append(name, kindBadge, sizeBadge(key, value));
		details.append(summary);
		let filled = false;
		details.addEventListener("toggle", () => {
			if (details.open && !filled) {
				filled = true;
				details.append(editor(doc, key, callbacks));
			}
		});
		container.append(details);
	}
}

function sizeBadge(key: string, value: unknown): HTMLElement {
	const span = document.createElement("span");
	span.className = "chip";
	try {
		span.textContent = `${decodeValue(key, value).length} B`;
	} catch {
		span.textContent = "unreadable";
	}
	return span;
}

function editor(doc: Document, key: string, callbacks: JsonPanelCallbacks): HTMLElement {
	const wrap = document.createElement("div");
	wrap.className = "editor";
	const textarea = document.createElement("textarea");
	textarea.spellcheck = false;
	textarea.value = prettyJson(doc[key]);
	const status = document.createElement("div");
	status.className = "editor-status";
	const apply = document.createElement("button");
	apply.textContent = "Apply";
	const revert = document.createElement("button");
	revert.textContent = "Revert";
	revert.addEventListener("click", () => {
		textarea.value = prettyJson(doc[key]);
		status.textContent = "";
		status.className = "editor-status";
	});
	apply.addEventListener("click", () => {
		try {
			const parsed = parseJsonText(textarea.value);
			// Round-trip through bytes: the document stores the canonical form.
			const bytes = decodeValue(key, parsed.value);
			doc[key] = encodeValue(key, bytes);
			textarea.value = prettyJson(doc[key]);
			status.className = "editor-status ok";
			status.textContent = parsed.lossy
				? "applied (this browser lacks JSON.parse source access; huge integers may have lost precision)"
				: "applied";
			callbacks.onDocumentChanged();
		} catch (error) {
			status.className = "editor-status error";
			status.textContent = String(error instanceof Error ? error.message : error);
		}
	});
	const row = document.createElement("div");
	row.className = "editor-buttons";
	row.append(apply, revert, status);
	wrap.append(textarea, row);
	return wrap;
}

function sectionHeader(title: string, detail: string): HTMLElement {
	const h = document.createElement("div");
	h.className = "section-header";
	const strong = document.createElement("strong");
	strong.textContent = title;
	const code = document.createElement("code");
	code.textContent = detail;
	h.append(strong, code);
	return h;
}

function hint(text: string): HTMLElement {
	const p = document.createElement("p");
	p.className = "hint";
	p.textContent = text;
	return p;
}
