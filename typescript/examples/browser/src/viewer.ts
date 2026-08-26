/**
 * Multi-dimensional array viewer: pick two dimensions to display as an
 * image plane, slice the rest with sliders (neuroglancer-style), with
 * colormaps, zoom/pan, and a hover value readout. Non-numeric (string)
 * arrays render as a value table instead.
 */

export interface ArrayData {
	/** Typed array, or a wrapper with .get(i) (bool/string arrays). */
	data: unknown;
	shape: number[];
	stride: number[];
}

export interface ViewerState {
	xDim: number;
	yDim: number; // -1 for 1-D arrays
	index: number[];
	/** A colormap name, or "text" to render each element as its value. */
	cmap: string;
	auto: boolean;
	vmin: number;
	vmax: number;
	/** Draw chunk boundaries (when the chunk shape is known). */
	showChunks: boolean;
	zoom: number | null; // null = fit on next render
	panX: number;
	panY: number;
}

export function initialViewerState(shape: number[]): ViewerState {
	const rank = shape.length;
	return {
		xDim: rank - 1,
		yDim: rank >= 2 ? rank - 2 : -1,
		index: shape.map(() => 0),
		cmap: "viridis",
		auto: true,
		vmin: 0,
		vmax: 1,
		showChunks: true,
		zoom: null,
		panX: 0,
		panY: 0,
	};
}

type Accessor = (offset: number) => unknown;

function makeAccessor(data: unknown): Accessor {
	const anyData = data as { get?: (i: number) => unknown };
	if (typeof anyData?.get === "function") return (i) => anyData.get!(i);
	return (i) => (data as ArrayLike<unknown>)[i];
}

function toNumber(value: unknown): number {
	if (typeof value === "number") return value;
	if (typeof value === "bigint") return Number(value);
	if (typeof value === "boolean") return value ? 1 : 0;
	return Number.NaN;
}

const COLORMAPS: Record<string, [number, number, number][]> = {
	gray: [
		[0, 0, 0],
		[255, 255, 255],
	],
	viridis: [
		[68, 1, 84],
		[71, 44, 122],
		[59, 81, 139],
		[44, 113, 142],
		[33, 144, 141],
		[39, 173, 129],
		[92, 200, 99],
		[170, 220, 50],
		[253, 231, 37],
	],
	magma: [
		[0, 0, 4],
		[40, 11, 84],
		[101, 21, 110],
		[159, 42, 99],
		[212, 72, 66],
		[245, 125, 21],
		[250, 193, 39],
		[252, 253, 191],
	],
	coolwarm: [
		[59, 76, 192],
		[124, 159, 249],
		[192, 212, 245],
		[242, 242, 242],
		[245, 196, 173],
		[238, 121, 98],
		[180, 4, 38],
	],
};

function colorAt(stops: [number, number, number][], t: number): [number, number, number] {
	const clamped = Math.min(1, Math.max(0, t));
	const scaled = clamped * (stops.length - 1);
	const i = Math.min(stops.length - 2, Math.floor(scaled));
	const frac = scaled - i;
	const a = stops[i];
	const b = stops[i + 1];
	return [
		Math.round(a[0] + (b[0] - a[0]) * frac),
		Math.round(a[1] + (b[1] - a[1]) * frac),
		Math.round(a[2] + (b[2] - a[2]) * frac),
	];
}

export function renderArrayViewer(
	container: HTMLElement,
	array: ArrayData,
	dimNames: string[],
	state: ViewerState,
	chunkShape: number[] | null = null,
): void {
	container.replaceChildren();
	const { shape, stride } = array;
	const rank = shape.length;
	const accessor = makeAccessor(array.data);
	const size = shape.reduce((a, b) => a * b, 1);

	if (rank === 0 || size === 0) {
		const p = document.createElement("p");
		p.className = "hint";
		p.textContent =
			size === 0 ? "Array has no elements." : `Scalar value: ${String(accessor(0))}`;
		container.append(p);
		return;
	}

	const sample = accessor(0);
	if (typeof sample === "string") {
		renderStringTable(container, array, accessor, dimNames, state);
		return;
	}

	// --- controls -------------------------------------------------------
	const controls = document.createElement("div");
	controls.className = "viewer-controls";
	const redraw = () => drawImage();

	for (let d = 0; d < rank; d++) {
		const row = document.createElement("div");
		row.className = "dim-row";
		const label = document.createElement("span");
		label.className = "dim-name";
		label.textContent = `${dimNames[d] ?? `d${d}`} (${shape[d]})`;
		const role = document.createElement("select");
		for (const opt of rank >= 2 ? ["X", "Y", "slice"] : ["X", "slice"]) {
			const o = document.createElement("option");
			o.value = opt;
			o.textContent = opt;
			role.append(o);
		}
		role.value = state.xDim === d ? "X" : state.yDim === d ? "Y" : "slice";
		role.addEventListener("change", () => {
			// Swap roles with whichever dimension currently holds the target.
			const wanted = role.value;
			const mine = state.xDim === d ? "X" : state.yDim === d ? "Y" : "slice";
			if (wanted === mine) return;
			if (wanted === "X") {
				if (mine === "Y") state.yDim = state.xDim;
				state.xDim = d;
			} else if (wanted === "Y") {
				if (mine === "X") state.xDim = state.yDim;
				state.yDim = d;
			} else if (mine === "X") {
				state.xDim = state.yDim >= 0 ? state.yDim : d === 0 ? Math.min(1, rank - 1) : 0;
				if (state.yDim === state.xDim) state.yDim = d; // keep roles distinct
			} else if (mine === "Y") {
				state.yDim = -1;
				for (let alt = rank - 1; alt >= 0; alt--) {
					if (alt !== state.xDim && alt !== d) {
						state.yDim = alt;
						break;
					}
				}
			}
			state.zoom = null;
			renderArrayViewer(container, array, dimNames, state, chunkShape);
		});
		row.append(label, role);
		if (role.value === "slice" && shape[d] > 1) {
			const slider = document.createElement("input");
			slider.type = "range";
			slider.min = "0";
			slider.max = String(shape[d] - 1);
			slider.value = String(state.index[d]);
			const readout = document.createElement("code");
			readout.textContent = String(state.index[d]);
			slider.addEventListener("input", () => {
				state.index[d] = Number(slider.value);
				readout.textContent = slider.value;
				redraw();
			});
			row.append(slider, readout);
		}
		controls.append(row);
	}

	const optionsRow = document.createElement("div");
	optionsRow.className = "dim-row";
	const cmapSelect = document.createElement("select");
	for (const name of [...Object.keys(COLORMAPS), "text"]) {
		const o = document.createElement("option");
		o.value = name;
		o.textContent = name === "text" ? "text (values)" : name;
		cmapSelect.append(o);
	}
	cmapSelect.value = state.cmap;
	cmapSelect.addEventListener("change", () => {
		state.cmap = cmapSelect.value;
		redraw();
	});
	const autoLabel = document.createElement("label");
	const autoBox = document.createElement("input");
	autoBox.type = "checkbox";
	autoBox.checked = state.auto;
	autoLabel.append(autoBox, document.createTextNode(" auto range"));
	const vminInput = numberInput(state.vmin);
	const vmaxInput = numberInput(state.vmax);
	vminInput.disabled = vmaxInput.disabled = state.auto;
	autoBox.addEventListener("change", () => {
		state.auto = autoBox.checked;
		vminInput.disabled = vmaxInput.disabled = state.auto;
		redraw();
	});
	for (const input of [vminInput, vmaxInput]) {
		input.addEventListener("change", () => {
			state.vmin = Number(vminInput.value);
			state.vmax = Number(vmaxInput.value);
			redraw();
		});
	}
	const fit = document.createElement("button");
	fit.textContent = "Fit";
	fit.addEventListener("click", () => {
		state.zoom = null;
		redraw();
	});
	optionsRow.append(cmapSelect, autoLabel, vminInput, vmaxInput, fit);
	if (chunkShape !== null) {
		const chunkLabel = document.createElement("label");
		const chunkBox = document.createElement("input");
		chunkBox.type = "checkbox";
		chunkBox.checked = state.showChunks;
		chunkBox.className = "chunk-toggle";
		chunkBox.addEventListener("change", () => {
			state.showChunks = chunkBox.checked;
			drawOverlay();
		});
		chunkLabel.append(chunkBox, document.createTextNode(" chunk grid"));
		optionsRow.append(chunkLabel);
	}
	controls.append(optionsRow);

	// --- canvas ---------------------------------------------------------
	const viewport = document.createElement("div");
	viewport.className = "viewer-viewport checker";
	const canvas = document.createElement("canvas");
	const overlay = document.createElement("canvas");
	overlay.className = "viewer-overlay";
	viewport.append(canvas, overlay);
	const readout = document.createElement("div");
	readout.className = "viewer-readout";
	readout.textContent = "—";
	container.append(controls, viewport, readout);

	const width = shape[state.xDim];
	const height = state.yDim >= 0 ? shape[state.yDim] : 1;
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d")!;
	const overlayContext = overlay.getContext("2d")!;

	const offsetFor = (px: number, py: number): number => {
		let offset = 0;
		for (let d = 0; d < rank; d++) {
			const idx = d === state.xDim ? px : d === state.yDim ? py : state.index[d];
			offset += idx * stride[d];
		}
		return offset;
	};

	function sliceRange(): [number, number] {
		let lo = Number.POSITIVE_INFINITY;
		let hi = Number.NEGATIVE_INFINITY;
		for (let py = 0; py < height; py++) {
			for (let px = 0; px < width; px++) {
				const v = toNumber(accessor(offsetFor(px, py)));
				if (Number.isFinite(v)) {
					if (v < lo) lo = v;
					if (v > hi) hi = v;
				}
			}
		}
		if (lo > hi) return [0, 1];
		if (lo === hi) return [lo - 0.5, hi + 0.5];
		return [lo, hi];
	}

	function applyTransform(): void {
		if (state.zoom === null) {
			const availW = viewport.clientWidth || 400;
			const availH = viewport.clientHeight || 300;
			state.zoom = Math.max(
				0.25,
				Math.min(availW / width, availH / height) * 0.95,
			);
			state.panX = (availW - width * state.zoom) / 2;
			state.panY = (availH - height * state.zoom) / 2;
		}
		canvas.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
		drawOverlay();
	}

	function drawImage(): void {
		const textMode = state.cmap === "text";
		canvas.style.display = textMode ? "none" : "";
		if (!textMode) {
			let [lo, hi] = [state.vmin, state.vmax];
			if (state.auto) {
				[lo, hi] = sliceRange();
				state.vmin = lo;
				state.vmax = hi;
				vminInput.value = formatNumber(lo);
				vmaxInput.value = formatNumber(hi);
			}
			const stops = COLORMAPS[state.cmap] ?? COLORMAPS.viridis;
			const image = context.createImageData(width, height);
			const pixels = image.data;
			let cursor = 0;
			for (let py = 0; py < height; py++) {
				for (let px = 0; px < width; px++) {
					const v = toNumber(accessor(offsetFor(px, py)));
					if (Number.isFinite(v)) {
						const [r, g, b] = colorAt(stops, (v - lo) / (hi - lo || 1));
						pixels[cursor] = r;
						pixels[cursor + 1] = g;
						pixels[cursor + 2] = b;
						pixels[cursor + 3] = 255;
					} else {
						pixels[cursor + 3] = 0; // NaN/±Inf: transparent over checkerboard
					}
					cursor += 4;
				}
			}
			context.putImageData(image, 0, 0);
		}
		applyTransform();
	}

	// --- screen-space overlay: cell values, chunk grid, axes ------------

	/** Smallest 1/2/5·10^k step whose screen spacing is at least minPx. */
	function niceStep(zoom: number, minPx: number): number {
		let step = 1;
		while (step * zoom < minPx) {
			const digits = Math.floor(Math.log10(step));
			const lead = step / 10 ** digits;
			step = (lead === 1 ? 2 : lead === 2 ? 5 : 10) * 10 ** digits;
		}
		return step;
	}

	function formatCell(value: unknown, zoom: number): string {
		if (typeof value === "number") {
			if (!Number.isFinite(value)) return String(value);
			if (Number.isInteger(value)) return String(value);
			const digits = zoom >= 64 ? 5 : zoom >= 40 ? 4 : 3;
			return String(Number(value.toPrecision(digits)));
		}
		return String(value);
	}

	function drawOverlay(): void {
		const zoom = state.zoom ?? 1;
		const viewWidth = viewport.clientWidth || 400;
		const viewHeight = viewport.clientHeight || 300;
		const dpr = window.devicePixelRatio || 1;
		if (overlay.width !== Math.round(viewWidth * dpr)) {
			overlay.width = Math.round(viewWidth * dpr);
		}
		if (overlay.height !== Math.round(viewHeight * dpr)) {
			overlay.height = Math.round(viewHeight * dpr);
		}
		const ctx = overlayContext;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, viewWidth, viewHeight);
		const toScreenX = (arrayX: number) => state.panX + arrayX * zoom;
		const toScreenY = (arrayY: number) => state.panY + arrayY * zoom;
		// Visible cell range (inclusive).
		const x0 = Math.max(0, Math.floor(-state.panX / zoom));
		const x1 = Math.min(width - 1, Math.ceil((viewWidth - state.panX) / zoom));
		const y0 = Math.max(0, Math.floor(-state.panY / zoom));
		const y1 = Math.min(height - 1, Math.ceil((viewHeight - state.panY) / zoom));

		// Cell values (the "text" lookup table).
		if (state.cmap === "text") {
			if (zoom >= 14 && (x1 - x0 + 1) * (y1 - y0 + 1) <= 5000) {
				ctx.strokeStyle = "rgba(215, 221, 229, 0.12)";
				ctx.lineWidth = 1;
				for (let px = x0; px <= x1 + 1; px++) {
					ctx.beginPath();
					ctx.moveTo(toScreenX(px), toScreenY(y0));
					ctx.lineTo(toScreenX(px), toScreenY(y1 + 1));
					ctx.stroke();
				}
				for (let py = y0; py <= y1 + 1; py++) {
					ctx.beginPath();
					ctx.moveTo(toScreenX(x0), toScreenY(py));
					ctx.lineTo(toScreenX(x1 + 1), toScreenY(py));
					ctx.stroke();
				}
				const fontSize = Math.min(13, Math.max(8, zoom * 0.3));
				ctx.font = `${fontSize}px ui-monospace, Menlo, Consolas, monospace`;
				ctx.textAlign = "center";
				ctx.textBaseline = "middle";
				for (let py = y0; py <= y1; py++) {
					for (let px = x0; px <= x1; px++) {
						const value = accessor(offsetFor(px, py));
						const numeric = toNumber(value);
						ctx.fillStyle = Number.isFinite(numeric)
							? "#d7dde5"
							: "rgba(255, 107, 107, 0.85)";
						ctx.fillText(
							formatCell(value, zoom),
							toScreenX(px) + zoom / 2,
							toScreenY(py) + zoom / 2,
							zoom - 3, // squeeze rather than overflow the cell
						);
					}
				}
			} else {
				ctx.font = "12px system-ui, sans-serif";
				ctx.textAlign = "center";
				ctx.fillStyle = "#8b96a5";
				ctx.fillText("zoom in to read values", viewWidth / 2, 30);
			}
		}

		// Chunk boundaries.
		if (state.showChunks && chunkShape !== null) {
			const chunkW = chunkShape[state.xDim];
			const chunkH = state.yDim >= 0 ? chunkShape[state.yDim] : Number.NaN;
			ctx.strokeStyle = "rgba(226, 163, 78, 0.9)";
			ctx.lineWidth = 1.5;
			ctx.setLineDash([6, 4]);
			const clipTop = Math.max(toScreenY(0), 0);
			const clipBottom = Math.min(toScreenY(height), viewHeight);
			const clipLeft = Math.max(toScreenX(0), 0);
			const clipRight = Math.min(toScreenX(width), viewWidth);
			if (Number.isFinite(chunkW) && chunkW > 0) {
				for (let cx = 0; cx <= width; cx += chunkW) {
					const sx = toScreenX(cx);
					if (sx < 0 || sx > viewWidth) continue;
					ctx.beginPath();
					ctx.moveTo(sx, clipTop);
					ctx.lineTo(sx, clipBottom);
					ctx.stroke();
				}
			}
			if (Number.isFinite(chunkH) && chunkH > 0) {
				for (let cy = 0; cy <= height; cy += chunkH) {
					const sy = toScreenY(cy);
					if (sy < 0 || sy > viewHeight) continue;
					ctx.beginPath();
					ctx.moveTo(clipLeft, sy);
					ctx.lineTo(clipRight, sy);
					ctx.stroke();
				}
			}
			ctx.setLineDash([]);
		}

		// Axes: always-on x/y coordinate labels along the top and left edges.
		const axisH = 16;
		const axisW = 10 + 7 * String(Math.max(height - 1, 0)).length;
		ctx.fillStyle = "rgba(16, 19, 24, 0.86)";
		ctx.fillRect(0, 0, viewWidth, axisH);
		ctx.fillRect(0, 0, axisW, viewHeight);
		ctx.strokeStyle = "rgba(215, 221, 229, 0.25)";
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(0, axisH + 0.5);
		ctx.lineTo(viewWidth, axisH + 0.5);
		ctx.moveTo(axisW + 0.5, 0);
		ctx.lineTo(axisW + 0.5, viewHeight);
		ctx.stroke();
		ctx.font = "10px ui-monospace, Menlo, Consolas, monospace";
		const step = niceStep(zoom, 44);
		ctx.fillStyle = "#aeb8c4";
		ctx.textAlign = "center";
		ctx.textBaseline = "alphabetic";
		for (let ax = Math.ceil(x0 / step) * step; ax <= x1 + 1; ax += step) {
			const sx = toScreenX(ax) + (zoom >= 14 ? zoom / 2 : 0);
			if (sx < axisW + 8 || sx > viewWidth - 4) continue;
			ctx.fillText(String(ax), sx, 11);
			ctx.fillRect(sx - 0.5, axisH - 3, 1, 3);
		}
		ctx.textAlign = "right";
		for (let ay = Math.ceil(y0 / step) * step; ay <= y1 + 1; ay += step) {
			const sy = toScreenY(ay) + (zoom >= 14 ? zoom / 2 : 0);
			if (sy < axisH + 10 || sy > viewHeight - 4) continue;
			ctx.fillText(String(ay), axisW - 4, sy + 3);
			ctx.fillRect(axisW - 3, sy - 0.5, 3, 1);
		}
		// Dimension names in the corner.
		ctx.fillStyle = "#4da3ff";
		ctx.textAlign = "left";
		const xName = dimNames[state.xDim] ?? `d${state.xDim}`;
		const yName = state.yDim >= 0 ? (dimNames[state.yDim] ?? `d${state.yDim}`) : "";
		ctx.fillText(`${xName} →`, axisW + 6, 11);
		if (yName !== "") ctx.fillText(`${yName} ↓`, 3, axisH + 12);
	}

	const resizeObserver = new ResizeObserver(() => drawOverlay());
	resizeObserver.observe(viewport);

	// --- zoom / pan / hover --------------------------------------------
	viewport.addEventListener("wheel", (event) => {
		event.preventDefault();
		const rect = viewport.getBoundingClientRect();
		const mx = event.clientX - rect.left;
		const my = event.clientY - rect.top;
		const factor = Math.exp(-event.deltaY * 0.0015);
		const zoom = Math.min(128, Math.max(0.1, (state.zoom ?? 1) * factor));
		state.panX = mx - ((mx - state.panX) * zoom) / (state.zoom ?? 1);
		state.panY = my - ((my - state.panY) * zoom) / (state.zoom ?? 1);
		state.zoom = zoom;
		applyTransform();
	});
	let dragging: { x: number; y: number } | null = null;
	viewport.addEventListener("pointerdown", (event) => {
		dragging = { x: event.clientX, y: event.clientY };
		viewport.setPointerCapture(event.pointerId);
	});
	viewport.addEventListener("pointerup", () => {
		dragging = null;
	});
	viewport.addEventListener("pointermove", (event) => {
		if (dragging !== null) {
			state.panX += event.clientX - dragging.x;
			state.panY += event.clientY - dragging.y;
			dragging = { x: event.clientX, y: event.clientY };
			applyTransform();
			return;
		}
		const rect = viewport.getBoundingClientRect();
		const zoom = state.zoom ?? 1;
		const px = Math.floor((event.clientX - rect.left - state.panX) / zoom);
		const py = Math.floor((event.clientY - rect.top - state.panY) / zoom);
		if (px < 0 || py < 0 || px >= width || py >= height) {
			readout.textContent = "—";
			return;
		}
		const value = accessor(offsetFor(px, py));
		const shown =
			typeof value === "number" && !Number.isInteger(value) && Number.isFinite(value)
				? String(Number(value.toPrecision(7)))
				: String(value);
		const parts: string[] = [];
		for (let d = 0; d < rank; d++) {
			const idx = d === state.xDim ? px : d === state.yDim ? py : state.index[d];
			parts.push(`${dimNames[d] ?? `d${d}`}=${idx}`);
		}
		readout.textContent = `${parts.join("  ")}  →  ${shown}`;
	});

	drawImage();
}

function renderStringTable(
	container: HTMLElement,
	array: ArrayData,
	accessor: Accessor,
	dimNames: string[],
	state: ViewerState,
): void {
	const { shape, stride } = array;
	const rank = shape.length;
	const note = document.createElement("p");
	note.className = "hint";
	note.textContent = "String array — values shown as a table.";
	const table = document.createElement("table");
	table.className = "value-table";
	const width = Math.min(shape[state.xDim], 60);
	const height = state.yDim >= 0 ? Math.min(shape[state.yDim], 200) : 1;
	for (let py = 0; py < height; py++) {
		const tr = document.createElement("tr");
		for (let px = 0; px < width; px++) {
			let offset = 0;
			for (let d = 0; d < rank; d++) {
				const idx = d === state.xDim ? px : d === state.yDim ? py : state.index[d];
				offset += idx * stride[d];
			}
			const td = document.createElement("td");
			td.textContent = String(accessor(offset));
			tr.append(td);
		}
		table.append(tr);
	}
	container.append(note, table);
	void dimNames;
}

function numberInput(value: number): HTMLInputElement {
	const input = document.createElement("input");
	input.type = "text";
	input.className = "range-input";
	input.value = formatNumber(value);
	return input;
}

function formatNumber(value: number): string {
	if (!Number.isFinite(value)) return "0";
	const rounded = Math.round(value * 1e6) / 1e6;
	return String(rounded);
}
