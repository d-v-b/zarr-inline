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
await page.waitForTimeout(1200);
await page.screenshot({ path: join(shotDir, "1-initial.png") });

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

// Click DAG nodes by their exact path (the <title> element).
const clickNode = (path) =>
	page.evaluate((p) => {
		for (const node of document.querySelectorAll("#dag g.node")) {
			const title = node.querySelector("title")?.textContent;
			if (title === p || (p === "" && title === "/ (root)")) {
				node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
				return true;
			}
		}
		return false;
	}, path);

// Select the volume array in the DAG.
await clickNode("volume");
await page.waitForTimeout(900);
const volumeStats = await canvasStats();
await page.screenshot({ path: join(shotDir, "2-volume.png") });

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

// Chunk-grid overlay: labels has 2-D chunks (20, 24), so interior lines.
await clickNode("labels");
await page.waitForTimeout(600);
const chunkOverlayOn = await overlayStats();
await page.screenshot({ path: join(shotDir, "6-labels-chunks.png") });
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

const status = await page.locator("#status").textContent();
console.log(
	JSON.stringify(
		{
			errors,
			status,
			volumeStats,
			sliderChangedImage: before !== after,
			readout,
			editStatus,
			editedAttrs,
			tablesCards: cards,
			countersStats,
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
