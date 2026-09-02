/**
 * Dependency-free JSON syntax highlighting, plus an editor built from a
 * highlight layer kept in sync underneath a transparent-text textarea.
 */

const HIGHLIGHT_LIMIT = 400_000; // chars; beyond this, skip highlighting

const TOKEN =
	/("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)|([{}[\],:])/g;

function escapeHtml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Turn JSON text into HTML with token spans (input is escaped). */
export function highlightJson(text: string): string {
	if (text.length > HIGHLIGHT_LIMIT) return escapeHtml(text);
	let html = "";
	let last = 0;
	TOKEN.lastIndex = 0;
	for (let m = TOKEN.exec(text); m !== null; m = TOKEN.exec(text)) {
		html += escapeHtml(text.slice(last, m.index));
		last = TOKEN.lastIndex;
		if (m[1] !== undefined) {
			const cls = m[2] !== undefined ? "j-key" : "j-str";
			html += `<span class="${cls}">${escapeHtml(m[1])}</span>`;
			if (m[2] !== undefined) html += `${escapeHtml(m[2].slice(0, -1))}<span class="j-pun">:</span>`;
		} else if (m[3] !== undefined) {
			html += `<span class="j-num">${m[3]}</span>`;
		} else if (m[4] !== undefined) {
			html += `<span class="j-lit">${m[4]}</span>`;
		} else {
			html += `<span class="j-pun">${escapeHtml(m[5])}</span>`;
		}
	}
	return html + escapeHtml(text.slice(last));
}

/** A read-only highlighted JSON block. */
export function jsonBlock(text: string, className = "attrs"): HTMLElement {
	const pre = document.createElement("pre");
	pre.className = className;
	const code = document.createElement("code");
	code.innerHTML = highlightJson(text);
	pre.append(code);
	return pre;
}

export interface JsonEditor {
	root: HTMLElement;
	textarea: HTMLTextAreaElement;
	getValue: () => string;
	setValue: (text: string) => void;
}

/**
 * A JSON editor with live syntax highlighting: a <pre> paints the tokens
 * and a textarea with transparent text (visible caret) sits on top with
 * identical font metrics, synced on input and scroll.
 */
export function createJsonEditor(initial: string): JsonEditor {
	const root = document.createElement("div");
	root.className = "json-editor";
	const layer = document.createElement("pre");
	layer.className = "json-editor-layer";
	const code = document.createElement("code");
	layer.append(code);
	const textarea = document.createElement("textarea");
	textarea.spellcheck = false;
	textarea.autocapitalize = "off";
	textarea.setAttribute("autocorrect", "off");
	root.append(layer, textarea);

	const repaint = () => {
		// Trailing newline keeps the layer's height in step with the caret
		// on the textarea's last empty line.
		code.innerHTML = `${highlightJson(textarea.value)}\n`;
		// Stretch to the content's height; outer panels provide the
		// scrollbar fallback. (Horizontal overflow still scrolls inside.)
		textarea.style.height = "auto";
		textarea.style.height = `${textarea.scrollHeight + 2}px`;
	};
	const sync = () => {
		layer.scrollTop = textarea.scrollTop;
		layer.scrollLeft = textarea.scrollLeft;
	};
	textarea.addEventListener("input", repaint);
	textarea.addEventListener("scroll", sync);

	textarea.value = initial;
	repaint();
	// The editor is measured while still detached (scrollHeight is 0);
	// re-measure right after the caller mounts it.
	requestAnimationFrame(() => {
		if (textarea.isConnected) repaint();
	});
	return {
		root,
		textarea,
		getValue: () => textarea.value,
		setValue: (text: string) => {
			textarea.value = text;
			repaint();
			sync();
		},
	};
}
