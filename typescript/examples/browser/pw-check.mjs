// Drive dist/index.html in headless Chromium: select nodes, check the
// canvas actually rendered, move a slider, apply a JSON edit, and report
// console errors. Screenshots land in SHOT_DIR (default: ./shots).
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const shotDir = process.env.SHOT_DIR ?? join(import.meta.dirname, "shots");
mkdirSync(shotDir, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errors = [];
page.on("console", (m) => {
	if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(
	pathToFileURL(join(import.meta.dirname, "dist/index.html")).href,
);
await page.waitForTimeout(600);
const bareStatus = await page.locator("#status").textContent();
await page.locator("#demo").click();
await page.waitForTimeout(1200);
await page.screenshot({ path: join(shotDir, "1-initial.png") });
const demoHash = await page.evaluate(() => location.hash.slice(0, 5));

const canvasStats = () =>
	page.evaluate(() => {
		const canvas = document.querySelector(".viewer-viewport canvas");
		if (!canvas) return null;
		const data = canvas
			.getContext("2d")
			.getImageData(0, 0, canvas.width, canvas.height).data;
		let opaque = 0;
		for (let i = 3; i < data.length; i += 4) if (data[i] > 0) opaque++;
		return { w: canvas.width, h: canvas.height, opaque, total: data.length / 4 };
	});

// Navigate the left pane's flat member list to a node path.
const clickNode = async (path) => {
	await page.locator('#tree-panel .breadcrumb [data-path=""]').first().click();
	await page.waitForTimeout(150);
	if (path === "") return;
	let acc = "";
	for (const segment of path.split("/")) {
		acc = acc === "" ? segment : `${acc}/${segment}`;
		const row = page.locator(`#tree-panel .list-row[data-path="${acc}"] .list-row-head`);
		if ((await row.count()) > 0) await row.first().click();
		await page.waitForTimeout(150);
	}
};

// Select the image array in the left pane.
await clickNode("image");
await page.waitForTimeout(900);
const imageStats = await canvasStats();
await page.screenshot({ path: join(shotDir, "2-image.png") });

// Flat key list: tags and prefix search (c/ filters to chunks).
const metaTag = await page
	.locator('#json-panel .list-row[data-path="image/zarr.json"] .chip')
	.textContent();
const chunkTag = await page
	.locator('#json-panel .list-row[data-path="image/c/0/0/0"] .chip')
	.textContent();
await page.fill("#json-panel .list-search", "c/");
await page.waitForTimeout(200);
const filteredRows = await page.locator("#json-panel .list-row").count();
await page.fill("#json-panel .list-search", "");
await page.waitForTimeout(200);
// Typing character-by-character must keep focus: the box filters in place.
await page.click("#json-panel .list-search");
await page.keyboard.type("c/0/");
const searchFocusKept = await page.evaluate(() => {
	const active = document.activeElement;
	return active?.classList?.contains("list-search") ? active.value : null;
});
const typedRows = await page.locator("#json-panel .list-row").count();
await page.fill("#json-panel .list-search", "");
await page.waitForTimeout(200);
// The expanded editor stretches to its content (no internal v-scroll).
const editorAutosized = await page.evaluate(() => {
	const ta = document.querySelector("#json-panel .json-editor textarea");
	return ta ? ta.scrollHeight - ta.clientHeight < 4 : null;
});
// Syntax highlighting in the expanded (zarr.json) editor.
const highlightSpans = await page
	.locator("#json-panel .json-editor-layer .j-key")
	.count();
// Left pane tags: members are Group / Array.
const groupTag = await page
	.locator('#tree-panel .list-row[data-path="tables"] .chip')
	.textContent();

// Move the t slider and confirm the image changes.
const before = await page.evaluate(() =>
	document.querySelector(".viewer-viewport canvas").toDataURL(),
);
await page
	.locator('.dim-row input[type="range"]')
	.first()
	.evaluate((slider) => {
		slider.value = "2";
		slider.dispatchEvent(new Event("input", { bubbles: true }));
	});
await page.waitForTimeout(300);
const after = await page.evaluate(() =>
	document.querySelector(".viewer-viewport canvas").toDataURL(),
);
await page.screenshot({ path: join(shotDir, "3-slider.png") });

// Readout on hover over the canvas.
const box = await page.locator(".viewer-viewport").boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(200);
const readout = await page.locator(".viewer-readout").textContent();

// Apply a metadata edit on the root group and confirm it lands.
await clickNode("");
await page.waitForTimeout(400);
await page.locator("#json-panel textarea").first().evaluate((textarea) => {
	textarea.value = textarea.value.replace(
		"browser demo",
		"browser demo (edited)",
	);
});
await page.locator("#json-panel button", { hasText: "Apply" }).first().click();
await page.waitForTimeout(400);
const editStatus = await page.locator(".editor-status").first().textContent();
const editedAttrs = await page.evaluate(() =>
	document.querySelector("#display-panel pre.attrs")?.textContent?.includes("(edited)"),
);
await page.screenshot({ path: join(shotDir, "4-edited.png") });

// Group display: tables shows its children.
await clickNode("tables");
await page.waitForTimeout(300);
const cards = await page.locator("#display-panel .card").count();

const overlayStats = () =>
	page.evaluate(() => {
		const c = document.querySelector("canvas.viewer-overlay");
		if (!c) return null;
		const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
		let opaque = 0;
		for (let i = 3; i < d.length; i += 4) if (d[i] > 16) opaque++;
		return opaque;
	});

// Chunk-grid overlay: image chunks are (5,5,5), so in-plane lines every 5.
await clickNode("image");
await page.waitForTimeout(600);
const chunkOverlayOn = await overlayStats();
await page.screenshot({ path: join(shotDir, "6-image-chunks.png") });
await page.locator(".chunk-toggle").setChecked(false);
await page.waitForTimeout(200);
const chunkOverlayOff = await overlayStats();

// int64 array renders (BigInt path).
await clickNode("tables/counters");
await page.waitForTimeout(500);
const countersStats = await canvasStats();
await page.screenshot({ path: join(shotDir, "5-counters.png") });

// Text lookup table: counters fits at a huge zoom, so values are legible.
const axesOnly = await overlayStats();
await page.locator('#display-panel select:has(option[value="text"])').selectOption("text");
await page.waitForTimeout(300);
const textOverlay = await overlayStats();
const dataCanvasHidden = await page.evaluate(
	() =>
		document.querySelector(".viewer-viewport canvas:not(.viewer-overlay)").style
			.display === "none",
);
await page.screenshot({ path: join(shotDir, "7-text-mode.png") });

// Live edits: turn the 3-D image into a 2-D image; the viewer follows
// every Apply. Then add a fresh 2-D chunk key and delete it again.
await clickNode("image");
await page.waitForTimeout(600);
await page.locator("#json-panel .json-editor textarea").first().evaluate((ta) => {
	const meta = JSON.parse(ta.value);
	meta.shape = [20, 20];
	meta.chunk_grid.configuration.chunk_shape = [5, 5];
	meta.dimension_names = ["y", "x"];
	ta.value = JSON.stringify(meta, null, 2);
	ta.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.locator("#json-panel button", { hasText: "Apply" }).first().click();
await page.waitForTimeout(900);
const twoDStats = await canvasStats();
await page.screenshot({ path: join(shotDir, "8-live-2d.png") });
const beforeChunkAdd = await page.evaluate(() =>
	document.querySelector(".viewer-viewport canvas").toDataURL(),
);
await page.fill(".add-key-row input", "c/0/0");
await page.locator(".add-key-row button", { hasText: "Add key" }).click();
await page.waitForTimeout(500);
await page.locator("#json-panel .json-editor textarea").first().evaluate((ta) => {
	const row = [0, 60, 120, 180, 240];
	const grid = Array.from({ length: 5 }, (_, i) => row.map((v) => (v + i * 40) % 255));
	ta.value = JSON.stringify(grid);
	ta.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.locator("#json-panel .list-row.selected button", { hasText: "Apply" }).click();
await page.waitForTimeout(900);
const afterChunkAdd = await page.evaluate(() =>
	document.querySelector(".viewer-viewport canvas").toDataURL(),
);
const statusAfterAdd = await page.locator("#status").textContent();
await page.screenshot({ path: join(shotDir, "9-live-chunk.png") });
await page.locator("#json-panel button", { hasText: "Delete key" }).first().click();
await page.waitForTimeout(500);
const statusAfterDelete = await page.locator("#status").textContent();

// Whole-document JSON view: edit the raw document text and Apply.
await page.locator("#view-json").click();
await page.waitForTimeout(400);
const docViewHasText = await page.evaluate(() =>
	document.querySelector("#document-panel textarea").value.includes('"zarr.json"'),
);
await page.locator("#document-panel textarea").evaluate((ta) => {
	ta.value = ta.value.replace("browser demo (edited)", "browser demo (doc view)");
	ta.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.locator("#document-panel button", { hasText: "Apply" }).click();
await page.waitForTimeout(500);
const docViewStatus = await page.locator("#document-panel .editor-status").textContent();
const docViewStretched = await page.evaluate(() => {
	const ta = document.querySelector("#document-panel textarea");
	return ta !== null && ta.clientHeight > window.innerHeight;
});
await page.screenshot({ path: join(shotDir, "10-json-view.png") });
await page.locator("#view-browser").click();
await clickNode("");
await page.waitForTimeout(400);
const docViewEditVisible = await page.evaluate(() =>
	document.querySelector("#display-panel pre.attrs")?.textContent?.includes("(doc view)"),
);

// URL state: an edited document's link restores the same document.
const shareUrl = await page.evaluate(() => location.href);
await page.goto("about:blank");
await page.goto(shareUrl);
await page.waitForTimeout(1200);
const restoredStatus = await page.locator("#status").textContent();

// #url= loading: fetch a hosted document (network stubbed).
const fs = await import("node:fs");
const demoText = fs.readFileSync(
	join(import.meta.dirname, "src/demo-document.json.txt"),
	"utf8",
);
await page.route("**/hosted-demo.json", (route) =>
	route.fulfill({
		body: demoText,
		contentType: "application/json",
		headers: { "access-control-allow-origin": "*" },
	}),
);
await page.goto(
	pathToFileURL(join(import.meta.dirname, "dist/index.html")).href +
		"#url=" +
		encodeURIComponent("https://zarr-inline.test/hosted-demo.json"),
);
await page.waitForTimeout(1200);
const urlLoadStatus = await page.locator("#status").textContent();

const status = await page.locator("#status").textContent();
console.log(
	JSON.stringify(
		{
			errors,
			status,
			imageStats,
			sliderChangedImage: before !== after,
			readout,
			editStatus,
			editedAttrs,
			tablesCards: cards,
			metaTag,
			chunkTag,
			filteredRows,
			highlightSpans,
			groupTag,
			countersStats,
			bareStatus,
			demoHash,
			restoredStatus,
			urlLoadStatus,
			searchFocusKept,
			typedRows,
			editorAutosized,
			docViewStretched,
			docViewHasText,
			docViewStatus,
			docViewEditVisible,
			twoDStats,
			liveChunkChanged: beforeChunkAdd !== afterChunkAdd,
			statusAfterAdd,
			statusAfterDelete,
			axesDrawn: axesOnly > 0,
			chunkOverlay: { on: chunkOverlayOn, off: chunkOverlayOff },
			textOverlayGrew: textOverlay > axesOnly,
			dataCanvasHidden,
		},
		null,
		1,
	),
);
await browser.close();
