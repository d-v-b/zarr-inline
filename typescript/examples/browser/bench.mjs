// Compare text-mode interaction cost between two builds: time 60 wheel
// events dispatched on the viewer in text mode (handlers run
// synchronously, so this measures what a real scroll pays).
import { chromium } from "playwright";
import { pathToFileURL } from "node:url";

const targets = process.argv.slice(2);
const browser = await chromium.launch();

for (const target of targets) {
	const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
	await page.goto(pathToFileURL(target).href);
	await page.waitForTimeout(500);
	await page.locator("#demo").click();
	await page.waitForTimeout(1000);
	// Select the labels array in either UI generation (DAG or flat list).
	await page.evaluate(() => {
		for (const node of document.querySelectorAll("#dag g.node")) {
			if (node.querySelector("title")?.textContent === "labels") {
				node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
				return;
			}
		}
		document
			.querySelector('#tree-panel .list-row[data-path="labels"] .list-row-head')
			?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	await page.waitForTimeout(800);
	await page
		.locator('#display-panel select:has(option[value="text"])')
		.selectOption("text");
	await page.waitForTimeout(400);
	const result = await page.evaluate(async () => {
		const viewport = document.querySelector(".viewer-viewport");
		const rect = viewport.getBoundingClientRect();
		const cx = rect.left + rect.width / 2;
		const cy = rect.top + rect.height / 2;
		const wheel = (deltaY) =>
			viewport.dispatchEvent(
				new WheelEvent("wheel", {
					deltaY,
					clientX: cx,
					clientY: cy,
					bubbles: true,
					cancelable: true,
				}),
			);
		// Zoom just past the text threshold so ALL cells stay visible —
		// the renderer's worst case.
		for (let i = 0; i < 2; i++) wheel(-60);
		await new Promise((r) => requestAnimationFrame(r));
		const t0 = performance.now();
		for (let i = 0; i < 60; i++) wheel(i % 2 === 0 ? -20 : 20);
		const dispatch = performance.now() - t0;
		// And the steady-state frame cost: time 30 animation frames while
		// nudging the view each frame.
		const f0 = performance.now();
		for (let i = 0; i < 30; i++) {
			wheel(i % 2 === 0 ? -10 : 10);
			await new Promise((r) => requestAnimationFrame(r));
		}
		const frames = performance.now() - f0;
		return { dispatch, frameAvg: frames / 30 };
	});
	console.log(
		`${target}: 60 wheel events ${result.dispatch.toFixed(1)}ms, steady frame ${result.frameAvg.toFixed(1)}ms`,
	);
	await page.close();
}
await browser.close();
