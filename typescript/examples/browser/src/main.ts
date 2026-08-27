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

import demoText from "./demo-document.json.txt";
import { createJsonEditor, jsonBlock } from "./jsonhl.js";
import { renderFlatList } from "./list.js";
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
	tree: document.getElementById("tree-panel")!,
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
	main: document.querySelector("main")!,
	documentPanel: document.getElementById("document-panel")!,
	viewBrowser: document.getElementById("view-browser") as HTMLButtonElement,
	viewJson: document.getElementById("view-json") as HTMLButtonElement,
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
	if (viewMode === "json") renderDocumentView();
}

// --- whole-document JSON view -------------------------------------------

type ViewMode = "browser" | "json";
let viewMode: ViewMode = "browser";
let docViewStatus: { text: string; ok: boolean } | null = null;

function setViewMode(mode: ViewMode): void {
	viewMode = mode;
	el.main.dataset.view = mode;
	el.viewBrowser.classList.toggle("active", mode === "browser");
	el.viewJson.classList.toggle("active", mode === "json");
	if (mode === "json") renderDocumentView();
}

/** The whole document as one editable, syntax-highlighted JSON text. */
function renderDocumentView(): void {
	el.documentPanel.replaceChildren();
	if (doc === null) return;
	const editor = createJsonEditor(prettyJson(doc));
	const status = document.createElement("div");
	status.className = "editor-status";
	if (docViewStatus !== null) {
		status.className = `editor-status ${docViewStatus.ok ? "ok" : "error"}`;
		status.textContent = docViewStatus.text;
		docViewStatus = null;
	}
	const apply = document.createElement("button");
	apply.textContent = "Apply";
	apply.addEventListener("click", () => {
		try {
			const parsed = parseJsonText(editor.getValue());
			if (parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
				throw new Error("document must be a JSON object");
			}
			doc = toNullPrototype(parsed.value as Document);
			docViewStatus = {
				ok: true,
				text: parsed.lossy
					? "applied (this browser lacks JSON.parse source access; huge integers may have lost precision)"
					: "applied",
			};
			refresh(); // re-renders this view with the canonicalized text
			scheduleUrlSync();
		} catch (error) {
			status.className = "editor-status error";
			status.textContent = String(error instanceof Error ? error.message : error);
		}
	});
	const revert = document.createElement("button");
	revert.textContent = "Revert";
	revert.addEventListener("click", () => {
		editor.setValue(prettyJson(doc));
		status.textContent = "";
		status.className = "editor-status";
	});
	const buttons = document.createElement("div");
	buttons.className = "editor-buttons";
	buttons.append(apply, revert, status);
	el.documentPanel.append(buttons, editor.root);
}

el.viewBrowser.addEventListener("click", () => setViewMode("browser"));
el.viewJson.addEventListener("click", () => setViewMode("json"));

function renderSelection(renderJson = true): void {
	if (doc === null || hierarchy === null) return;
	renderTreePanel();
	const node = hierarchy.byPath.get(selectedPath) ?? null;
	if (renderJson) {
		renderJsonPanel(el.json, doc, node, {
			// Keep the editor DOM (and its "applied" feedback) in place;
			// the editor already shows the canonicalized value itself.
			onDocumentChanged: () => {
				refresh(false);
				scheduleUrlSync();
			},
			// Key set changed: rebuild the hierarchy and re-render the
			// panel too (its module state keeps the expansion and search).
			onKeysChanged: () => {
				refresh(true);
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

// --- left pane: the current group's members as a flat list --------------

let treeSearch = "";
let lastListPath: string | null = null;

/** The group whose members the left pane lists: the selected node when it
 * is a group, otherwise the selected array's parent. */
function listPathFor(selected: string): string {
	const node = hierarchy?.byPath.get(selected);
	if (node === undefined) return "";
	if (node.kind !== "array") return node.path;
	const slash = node.path.lastIndexOf("/");
	return slash === -1 ? "" : node.path.slice(0, slash);
}

function renderTreePanel(): void {
	if (hierarchy === null) return;
	const listPath = listPathFor(selectedPath);
	if (listPath !== lastListPath) {
		lastListPath = listPath;
		treeSearch = "";
	}
	el.tree.replaceChildren();

	const crumb = document.createElement("div");
	crumb.className = "breadcrumb";
	const addCrumb = (label: string, path: string) => {
		const link = document.createElement("a");
		link.textContent = label;
		link.dataset.path = path;
		if (path === listPath) link.className = "current";
		link.addEventListener("click", () => {
			selectedPath = path;
			renderSelection();
		});
		crumb.append(link);
	};
	addCrumb("/", "");
	let accumulated = "";
	for (const segment of listPath === "" ? [] : listPath.split("/")) {
		accumulated = accumulated === "" ? segment : `${accumulated}/${segment}`;
		const sep = document.createElement("span");
		sep.textContent = "›";
		crumb.append(sep);
		addCrumb(segment, accumulated);
	}
	el.tree.append(crumb);

	const parent = hierarchy.byPath.get(listPath)!;
	const host = document.createElement("div");
	el.tree.append(host);
	renderFlatList(host, {
		rows: parent.children.map((child) => ({
			name: child.name,
			tag: child.kind === "array" ? "Array" : "Group",
			tagClass: child.kind === "array" ? "tag-array-node" : "tag-group",
			detail:
				child.kind === "array"
					? nodeSubtitle(child)
					: `${child.children.length} member${child.children.length === 1 ? "" : "s"}`,
			path: child.path,
			selected: child.path === selectedPath,
			onSelect: () => {
				selectedPath = child.path;
				renderSelection();
			},
		})),
		search: treeSearch,
		onSearch: (value) => {
			treeSearch = value;
			renderTreePanel();
		},
		capacity: 100,
		placeholder: "filter members by prefix…",
		emptyText: "empty group",
	});
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
		el.display.append(jsonBlock(prettyJson(attrs)));
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
