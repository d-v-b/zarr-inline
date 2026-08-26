/** Render the hierarchy as a left-to-right DAG of selectable nodes (SVG). */

import { nodeSubtitle, type NodeInfo } from "./model.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const NODE_W = 148;
const NODE_H = 44;
const GAP_X = 46;
const GAP_Y = 18;
const PAD = 14;

interface Placement {
	x: number;
	y: number;
	node: NodeInfo;
}

export function renderDag(
	svg: SVGSVGElement,
	root: NodeInfo,
	selected: string | null,
	onSelect: (path: string) => void,
): void {
	svg.replaceChildren();
	const placements = new Map<string, Placement>();
	let nextRow = 0;
	const place = (node: NodeInfo, depth: number): void => {
		const x = PAD + depth * (NODE_W + GAP_X);
		if (node.children.length === 0) {
			placements.set(node.path, { x, y: PAD + nextRow++ * (NODE_H + GAP_Y), node });
			return;
		}
		for (const child of node.children) place(child, depth + 1);
		const ys = node.children.map((c) => placements.get(c.path)!.y);
		placements.set(node.path, {
			x,
			y: (Math.min(...ys) + Math.max(...ys)) / 2,
			node,
		});
	};
	place(root, 0);

	let maxX = 0;
	let maxY = 0;
	for (const p of placements.values()) {
		maxX = Math.max(maxX, p.x + NODE_W);
		maxY = Math.max(maxY, p.y + NODE_H);
	}
	svg.setAttribute("width", String(maxX + PAD));
	svg.setAttribute("height", String(maxY + PAD));

	const edges = document.createElementNS(SVG_NS, "g");
	svg.append(edges);
	for (const { node, x, y } of placements.values()) {
		for (const child of node.children) {
			const c = placements.get(child.path)!;
			const x0 = x + NODE_W;
			const y0 = y + NODE_H / 2;
			const x1 = c.x;
			const y1 = c.y + NODE_H / 2;
			const mid = (x0 + x1) / 2;
			const path = document.createElementNS(SVG_NS, "path");
			path.setAttribute("d", `M ${x0} ${y0} C ${mid} ${y0}, ${mid} ${y1}, ${x1} ${y1}`);
			path.setAttribute("class", "edge");
			edges.append(path);
		}
	}

	for (const { node, x, y } of placements.values()) {
		const g = document.createElementNS(SVG_NS, "g");
		g.setAttribute("transform", `translate(${x} ${y})`);
		g.setAttribute(
			"class",
			`node ${node.kind}${node.path === selected ? " selected" : ""}`,
		);
		const rect = document.createElementNS(SVG_NS, "rect");
		rect.setAttribute("width", String(NODE_W));
		rect.setAttribute("height", String(NODE_H));
		rect.setAttribute("rx", "7");
		g.append(rect);

		const badge = document.createElementNS(SVG_NS, "text");
		badge.setAttribute("x", "10");
		badge.setAttribute("y", "27");
		badge.setAttribute("class", "badge");
		badge.textContent = node.kind === "array" ? "▦" : "▸";
		g.append(badge);

		const name = document.createElementNS(SVG_NS, "text");
		name.setAttribute("x", "28");
		name.setAttribute("y", "19");
		name.setAttribute("class", "name");
		name.textContent = clip(node.name, 15);
		g.append(name);

		const sub = document.createElementNS(SVG_NS, "text");
		sub.setAttribute("x", "28");
		sub.setAttribute("y", "34");
		sub.setAttribute("class", "sub");
		sub.textContent = clip(nodeSubtitle(node), 19);
		g.append(sub);

		const title = document.createElementNS(SVG_NS, "title");
		title.textContent = node.path === "" ? "/ (root)" : node.path;
		g.append(title);

		g.addEventListener("click", () => onSelect(node.path));
		svg.append(g);
	}
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
