// Build the zarr-inline document browser into a single self-contained HTML
// file (dist/index.html). No server needed: open the file directly.
//
//   node build.mjs           build once
//   node build.mjs --serve   rebuild on change and serve on localhost:8137

import * as esbuild from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const options = {
	entryPoints: [join(here, "src/main.ts")],
	bundle: true,
	format: "iife",
	platform: "browser",
	target: "es2022",
	minify: true,
	// The zarr-inline sources use Node's Buffer for base64 only; substitute
	// an atob/btoa-backed shim so the bundle runs in any browser.
	inject: [join(here, "src/buffer-shim.ts")],
	// The demo document is a .txt so it imports as raw text and is parsed
	// by the same strict parser as user documents (exact big integers).
	// One zarrita copy only: the app and the zarr-inline sources (which
	// live two directories up and would otherwise resolve the parent
	// package's node_modules) must share a codec registry.
	alias: { zarrita: join(here, "node_modules/zarrita") },
	write: false,
	logLevel: "info",
};

function emit(result) {
	const js = result.outputFiles[0].text.replaceAll("</script>", "<\\/script>");
	const html = readFileSync(join(here, "src/index.html"), "utf8").replace(
		"/*__APP__*/",
		() => js,
	);
	mkdirSync(join(here, "dist"), { recursive: true });
	writeFileSync(join(here, "dist/index.html"), html);
	console.log(`dist/index.html (${(html.length / 1024).toFixed(0)} KiB)`);
}

if (process.argv.includes("--serve")) {
	const context = await esbuild.context({
		...options,
		plugins: [
			{
				name: "emit-html",
				setup(build) {
					build.onEnd((result) => {
						if (result.errors.length === 0) emit(result);
					});
				},
			},
		],
	});
	await context.watch();
	const { hosts, port } = await context.serve({
		servedir: join(here, "dist"),
		port: 8137,
	});
	console.log(`serving http://${hosts[0]}:${port}/`);
} else {
	emit(await esbuild.build(options));
}
