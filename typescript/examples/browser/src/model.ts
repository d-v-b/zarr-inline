/** Turn a zarr-inline document into a hierarchy graph of groups and arrays. */

import type { Document } from "../../../src/backing.js";
import { isMetadataKey, METADATA_SUFFIX } from "../../../src/document.js";

export interface NodeInfo {
	/** Hierarchy path, "" for the root. */
	path: string;
	name: string;
	/** "implicit" = referenced by descendants but has no metadata key itself. */
	kind: "group" | "array" | "implicit";
	meta: Record<string, unknown> | null;
	metaKey: string | null;
	children: NodeInfo[];
	/** Non-metadata document keys owned by this node (chunks, stray keys). */
	dataKeys: string[];
}

export interface Hierarchy {
	root: NodeInfo;
	byPath: Map<string, NodeInfo>;
}

export function buildHierarchy(doc: Document): Hierarchy {
	const byPath = new Map<string, NodeInfo>();
	const ensure = (path: string): NodeInfo => {
		const existing = byPath.get(path);
		if (existing) return existing;
		const node: NodeInfo = {
			path,
			name: path === "" ? "/" : path.slice(path.lastIndexOf("/") + 1),
			kind: "implicit",
			meta: null,
			metaKey: null,
			children: [],
			dataKeys: [],
		};
		byPath.set(path, node);
		if (path !== "") {
			const slash = path.lastIndexOf("/");
			const parent = ensure(slash === -1 ? "" : path.slice(0, slash));
			parent.children.push(node);
		}
		return node;
	};
	ensure("");

	const keys = Object.keys(doc);
	for (const key of keys) {
		if (!isMetadataKey(key)) continue;
		const path =
			key === METADATA_SUFFIX
				? ""
				: key.slice(0, key.length - METADATA_SUFFIX.length - 1);
		const node = ensure(path);
		node.metaKey = key;
		const meta = doc[key];
		if (meta !== null && typeof meta === "object" && !Array.isArray(meta)) {
			node.meta = meta as Record<string, unknown>;
			const nodeType = node.meta["node_type"];
			node.kind =
				nodeType === "array" ? "array" : nodeType === "group" ? "group" : "implicit";
		}
	}

	// Every non-metadata key belongs to the deepest ancestor that has a
	// metadata key (its array for chunk keys); stray keys land on the root.
	for (const key of keys) {
		if (isMetadataKey(key)) continue;
		const segments = key.split("/");
		let owner = byPath.get("")!;
		let prefix = "";
		for (let i = 0; i < segments.length - 1; i++) {
			prefix = prefix === "" ? segments[i] : `${prefix}/${segments[i]}`;
			const candidate = byPath.get(prefix);
			if (candidate?.metaKey !== null && candidate !== undefined) owner = candidate;
		}
		owner.dataKeys.push(key);
	}

	for (const node of byPath.values()) {
		node.children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		node.dataKeys.sort();
	}
	return { root: byPath.get("")!, byPath };
}

export function arrayShape(node: NodeInfo): number[] | null {
	const shape = node.meta?.["shape"];
	return Array.isArray(shape) && shape.every((n) => typeof n === "number")
		? (shape as number[])
		: null;
}

export function arrayDtype(node: NodeInfo): string | null {
	const dtype = node.meta?.["data_type"];
	if (typeof dtype === "string") return dtype;
	if (dtype !== null && typeof dtype === "object") {
		const name = (dtype as Record<string, unknown>)["name"];
		if (typeof name === "string") return name;
	}
	return null;
}

export function chunkShape(node: NodeInfo): number[] | null {
	const grid = node.meta?.["chunk_grid"];
	if (grid === null || typeof grid !== "object") return null;
	const config = (grid as Record<string, unknown>)["configuration"];
	if (config === null || typeof config !== "object") return null;
	const shape = (config as Record<string, unknown>)["chunk_shape"];
	return Array.isArray(shape) && shape.every((n) => typeof n === "number")
		? (shape as number[])
		: null;
}

export function dimensionNames(node: NodeInfo): string[] | null {
	const names = node.meta?.["dimension_names"];
	return Array.isArray(names) ? names.map((n, i) => (typeof n === "string" ? n : `d${i}`)) : null;
}

export function nodeSubtitle(node: NodeInfo): string {
	if (node.kind === "array") {
		const shape = arrayShape(node);
		const dtype = arrayDtype(node);
		return `${dtype ?? "?"} ${shape ? `[${shape.join("×")}]` : ""}`.trim();
	}
	if (node.kind === "group") return "group";
	return "(no metadata)";
}
