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
	cmap: string;
	auto: boolean;
	vmin: number;
	vmax: number;
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
			renderArrayViewer(container, array, dimNames, state);
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
	for (const name of Object.keys(COLORMAPS)) {
		const o = document.createElement("option");
		o.value = name;
		o.textContent = name;
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
	controls.append(optionsRow);

	// --- canvas ---------------------------------------------------------
	const viewport = document.createElement("div");
	viewport.className = "viewer-viewport checker";
	const canvas = document.createElement("canvas");
	viewport.append(canvas);
	const readout = document.createElement("div");
	readout.className = "viewer-readout";
	readout.textContent = "—";
	container.append(controls, viewport, readout);

	const width = shape[state.xDim];
	const height = state.yDim >= 0 ? shape[state.yDim] : 1;
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d")!;

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
	}

	function drawImage(): void {
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
		applyTransform();
	}

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
