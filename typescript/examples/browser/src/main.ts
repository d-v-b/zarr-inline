/**
 * zarr-inline document browser: hierarchy DAG (left), the selected node's
 * metadata and chunks as editable JSON (middle), and a rendered display of
 * the node (right) — children for groups, a multi-dimensional slice viewer
 * for arrays. The whole app operates on one JSON document via the
 * zarr-inline store and zarrita.
 */

import * as zarr from "zarrita";

import { MemoryBacking, toNullPrototype, type Document } from "../../../src/backing.js";
import { canonicalStringify } from "../../../src/document.js";
import { registerJsonCodec } from "../../../src/serializer.js";
import { ZarrInlineStore } from "../../../src/store.js";
import { validate, type ValidationIssue } from "../../../src/validator.js";
import { fragmentForDocument, decompressFromParam, parseFragment } from "./url-state.js";

import { renderDag } from "./dag.js";
import demoText from "./demo-document.json.txt";
import { prettyJson, renderJsonPanel } from "./jsonpanel.js";
import {
	arrayShape,
	buildHierarchy,
	chunkShape,
	dimensionNames,
	nodeSubtitle,
	type Hierarchy,
	type NodeInfo,
} from "./model.js";
import { parseJsonText } from "./strict.js";
import {
	initialViewerState,
	renderArrayViewer,
	type ArrayData,
	type ViewerState,
} from "./viewer.js";

registerJsonCodec();

const el = {
	dag: document.getElementById("dag") as unknown as SVGSVGElement,
	json: document.getElementById("json-panel")!,
	display: document.getElementById("display-panel")!,
	status: document.getElementById("status")!,
	open: document.getElementById("open") as HTMLButtonElement,
	file: document.getElementById("file") as HTMLInputElement,
	paste: document.getElementById("paste") as HTMLButtonElement,
	fromUrl: document.getElementById("from-url") as HTMLButtonElement,
	demo: document.getElementById("demo") as HTMLButtonElement,
	download: document.getElementById("download") as HTMLButtonElement,
	copy: document.getElementById("copy") as HTMLButtonElement,
	copyLink: document.getElementById("copy-link") as HTMLButtonElement,
};

let doc: Document | null = null;
let hierarchy: Hierarchy | null = null;
let selectedPath = "";
let displayEpoch = 0;
const viewerStates = new Map<string, ViewerState>();
const arrayCache = new Map<string, Promise<ArrayData>>();

/**
 * URL sync policy for a load: "auto" re-encodes the document into a
 * #doc= fragment, a literal string is written verbatim (e.g. #url=...),
 * and null leaves the address bar untouched (fragment-initiated loads).
 */
type FragmentPolicy = "auto" | string | null;

function loadDocumentText(
	text: string,
	sourceName: string,
	fragment: FragmentPolicy = "auto",
): boolean {
	let parsed: unknown;
	try {
		parsed = parseJsonText(text).value;
	} catch (error) {
		el.status.replaceChildren(badSpan(`${sourceName}: ${String(error)}`));
		return false;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		el.status.replaceChildren(badSpan(`${sourceName}: document must be a JSON object`));
		return false;
	}
	doc = toNullPrototype(parsed as Document);
	selectedPath = "";
	viewerStates.clear();
	refresh();
	if (fragment === "auto") scheduleUrlSync();
	else if (fragment !== null) writeFragment(fragment);
	return true;
}

// --- URL state (the document travels in the fragment) -------------------

let urlShareable = true;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let syncEpoch = 0;

function writeFragment(fragment: string): void {
	history.replaceState(null, "", `${location.pathname}${location.search}${fragment}`);
}

function scheduleUrlSync(): void {
	if (syncTimer !== null) clearTimeout(syncTimer);
	syncTimer = setTimeout(() => {
		syncTimer = null;
		if (doc === null) return;
		const epoch = ++syncEpoch;
		void fragmentForDocument(canonicalStringify(doc) as string).then((fragment) => {
			if (epoch !== syncEpoch) return; // a newer sync superseded this one
			const shareable = fragment !== null;
			if (shareable) writeFragment(fragment);
			else writeFragment("#");
			if (shareable !== urlShareable) {
				urlShareable = shareable;
				updateStatus();
			}
		});
	}, 250);
}

async function initFromLocation(): Promise<void> {
	const state = parseFragment(location.hash);
	if (state.kind === "doc") {
		try {
			loadDocumentText(await decompressFromParam(state.value), "URL document", null);
			return;
		} catch (error) {
			el.status.replaceChildren(badSpan(`URL document: ${String(error)}`));
		}
	} else if (state.kind === "url") {
		try {
			const response = await fetch(state.value);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			loadDocumentText(await response.text(), state.value, null);
			return;
		} catch (error) {
			el.status.replaceChildren(badSpan(`${state.value}: ${String(error)}`));
		}
	}
	// Bare viewer: an empty document, ready for paste / open / demo.
	loadDocumentText("{}", "empty", null);
}

window.addEventListener("hashchange", () => {
	void initFromLocation();
});

function refresh(renderJson = true): void {
	if (doc === null) return;
	arrayCache.clear();
	hierarchy = buildHierarchy(doc);
	if (!hierarchy.byPath.has(selectedPath)) selectedPath = "";
	updateStatus();
	renderSelection(renderJson);
}

function renderSelection(renderJson = true): void {
	if (doc === null || hierarchy === null) return;
	renderDag(el.dag, hierarchy.root, selectedPath, (path) => {
		selectedPath = path;
		renderSelection();
	});
	const node = hierarchy.byPath.get(selectedPath) ?? null;
	if (renderJson) {
		renderJsonPanel(el.json, doc, node, {
			// Keep the editor DOM (and its "applied" feedback) in place;
			// the editor already shows the canonicalized value itself.
			onDocumentChanged: () => {
				refresh(false);
				scheduleUrlSync();
			},
		});
	}
	renderDisplay(node);
}

function updateStatus(): void {
	if (doc === null || hierarchy === null) return;
	const keys = Object.keys(doc).length;
	const bytes = new TextEncoder().encode(prettyJson(doc)).length;
	const issues: ValidationIssue[] = validate(doc);
	const stats = document.createElement("span");
	stats.textContent = `${keys} keys · ${(bytes / 1024).toFixed(1)} KiB · ${urlShareable ? "" : "too large for URL sharing · "}`;
	const verdict = document.createElement("span");
	if (issues.length === 0) {
		verdict.className = "ok";
		verdict.textContent = "valid";
	} else {
		verdict.className = "bad";
		verdict.textContent = `${issues.length} issue${issues.length === 1 ? "" : "s"}`;
		verdict.title = issues.map((i) => `[${i.rule}] ${i.key}: ${i.message}`).join("\n");
	}
	el.status.replaceChildren(stats, verdict);
}

function badSpan(text: string): HTMLElement {
	const span = document.createElement("span");
	span.className = "bad";
	span.textContent = text;
	return span;
}

// --- display panel ------------------------------------------------------

function renderDisplay(node: NodeInfo | null): void {
	const epoch = ++displayEpoch;
	el.display.replaceChildren();
	if (node === null || doc === null || hierarchy === null) {
		el.display.append(hintP("The selected node is displayed here."));
		return;
	}
	const title = document.createElement("h2");
	title.className = "node-title";
	const code = document.createElement("code");
	code.textContent = node.path === "" ? "/" : node.path;
	const sub = document.createElement("span");
	sub.className = "sub";
	sub.textContent = nodeSubtitle(node);
	title.append(code, sub);
	el.display.append(title);

	if (node.kind !== "array") {
		renderGroupDisplay(node);
		return;
	}

	const shape = arrayShape(node);
	if (shape === null) {
		el.display.append(hintP("Array metadata has no usable shape."));
		return;
	}
	const loading = hintP("Loading array…");
	el.display.append(loading);
	readArray(node.path).then(
		(data) => {
			if (epoch !== displayEpoch) return; // selection changed meanwhile
			loading.remove();
			let state = viewerStates.get(node.path);
			if (state === undefined || state.index.length !== shape.length) {
				state = initialViewerState(shape);
				viewerStates.set(node.path, state);
			}
			state.index = state.index.map((idx, d) => Math.min(idx, shape[d] - 1));
			const host = document.createElement("div");
			host.style.display = "flex";
			host.style.flexDirection = "column";
			host.style.flex = "1";
			host.style.minHeight = "0";
			el.display.append(host);
			const names = dimensionNames(node) ?? shape.map((_, i) => `d${i}`);
			renderArrayViewer(host, data, names, state, chunkShape(node));
		},
		(error) => {
			if (epoch !== displayEpoch) return;
			loading.remove();
			const p = hintP(
				`Could not read array: ${String(error instanceof Error ? error.message : error)}`,
			);
			p.style.color = "var(--error)";
			el.display.append(p);
		},
	);
}

function renderGroupDisplay(node: NodeInfo): void {
	const attrs = node.meta?.["attributes"];
	if (attrs !== undefined && attrs !== null && Object.keys(attrs as object).length > 0) {
		const pre = document.createElement("pre");
		pre.className = "attrs";
		pre.textContent = prettyJson(attrs);
		el.display.append(pre);
	}
	if (node.children.length === 0) {
		el.display.append(hintP("Empty group."));
		return;
	}
	const grid = document.createElement("div");
	grid.className = "card-grid";
	for (const child of node.children) {
		const card = document.createElement("div");
		card.className = "card";
		const name = document.createElement("div");
		name.className = "name";
		name.textContent = `${child.kind === "array" ? "▦" : "▸"} ${child.name}`;
		const sub = document.createElement("div");
		sub.className = "sub";
		sub.textContent = nodeSubtitle(child);
		card.append(name, sub);
		card.addEventListener("click", () => {
			selectedPath = child.path;
			renderSelection();
		});
		grid.append(card);
	}
	el.display.append(grid);
}

function readArray(path: string): Promise<ArrayData> {
	let cached = arrayCache.get(path);
	if (cached === undefined) {
		cached = (async () => {
			const store = new ZarrInlineStore(new MemoryBacking(doc!), { onIssue: () => {} });
			const location = zarr.root(store);
			const array = await zarr.open(
				path === "" ? location : location.resolve(`/${path}`),
				{ kind: "array" },
			);
			return (await zarr.get(array)) as unknown as ArrayData;
		})();
		arrayCache.set(path, cached);
	}
	return cached;
}

function hintP(text: string): HTMLParagraphElement {
	const p = document.createElement("p");
	p.className = "hint";
	p.textContent = text;
	return p;
}

// --- header actions -----------------------------------------------------

el.open.addEventListener("click", () => el.file.click());
el.file.addEventListener("change", async () => {
	const file = el.file.files?.[0];
	if (file) loadDocumentText(await file.text(), file.name);
	el.file.value = "";
});
el.demo.addEventListener("click", () => loadDocumentText(demoText, "demo"));
el.paste.addEventListener("click", () => {
	const overlay = document.createElement("div");
	overlay.className = "modal-overlay";
	const box = document.createElement("div");
	box.className = "modal";
	const label = document.createElement("p");
	label.textContent = "Paste a zarr-inline JSON document:";
	const textarea = document.createElement("textarea");
	textarea.spellcheck = false;
	const row = document.createElement("div");
	row.className = "editor-buttons";
	const load = document.createElement("button");
	load.textContent = "Load";
	const cancel = document.createElement("button");
	cancel.textContent = "Cancel";
	const close = () => overlay.remove();
	cancel.addEventListener("click", close);
	overlay.addEventListener("click", (event) => {
		if (event.target === overlay) close();
	});
	load.addEventListener("click", () => {
		if (loadDocumentText(textarea.value, "pasted document")) close();
	});
	row.append(load, cancel);
	box.append(label, textarea, row);
	overlay.append(box);
	document.body.append(overlay);
	textarea.focus();
});
el.fromUrl.addEventListener("click", async () => {
	const url = window.prompt("URL of a zarr-inline JSON document:");
	if (url === null || url.trim() === "") return;
	try {
		const response = await fetch(url.trim());
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		loadDocumentText(
			await response.text(),
			url.trim(),
			`#url=${encodeURIComponent(url.trim())}`,
		);
	} catch (error) {
		el.status.replaceChildren(badSpan(`${url.trim()}: ${String(error)}`));
	}
});
el.copyLink.addEventListener("click", async () => {
	try {
		await navigator.clipboard.writeText(location.href);
		el.copyLink.textContent = "Copied!";
	} catch {
		el.copyLink.textContent = "Copy failed";
	}
	setTimeout(() => {
		el.copyLink.textContent = "Copy link";
	}, 1200);
});
el.download.addEventListener("click", () => {
	if (doc === null) return;
	const blob = new Blob([`${prettyJson(doc)}\n`], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = "document.json";
	a.click();
	URL.revokeObjectURL(url);
});
el.copy.addEventListener("click", async () => {
	if (doc === null) return;
	try {
		await navigator.clipboard.writeText(`${prettyJson(doc)}\n`);
		el.copy.textContent = "Copied!";
	} catch {
		el.copy.textContent = "Copy failed";
	}
	setTimeout(() => {
		el.copy.textContent = "Copy JSON";
	}, 1200);
});

window.addEventListener("dragover", (event) => {
	event.preventDefault();
	document.body.classList.add("drop-active");
});
window.addEventListener("dragleave", (event) => {
	if (event.relatedTarget === null) document.body.classList.remove("drop-active");
});
window.addEventListener("drop", async (event) => {
	event.preventDefault();
	document.body.classList.remove("drop-active");
	const file = event.dataTransfer?.files?.[0];
	if (file) loadDocumentText(await file.text(), file.name);
});

// The URL fragment is the source of truth: #doc= (inline, compressed),
// #url= (fetched), or nothing — a bare viewer with an empty document.
void initFromLocation();
