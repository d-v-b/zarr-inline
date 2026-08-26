// Node smoke test for the browser app's non-DOM logic: hierarchy model,
// BigInt-safe pretty printer, and the full array read path (zarr-inline
// store + json codec + zarrita) against the embedded demo document.
// Run: node --experimental-strip-types? No — bundle first via esbuild.
import * as esbuild from "esbuild";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const entry = `
import * as zarr from "zarrita";
import { MemoryBacking, toNullPrototype } from "../../src/backing.js";
import { ZarrInlineStore } from "../../src/store.js";
import { registerJsonCodec } from "../../src/serializer.js";
import { strictParse } from "../../src/document.js";
import { validate } from "../../src/validator.js";
import { buildHierarchy, arrayShape, arrayDtype, dimensionNames } from "./src/model.js";
import { prettyJson } from "./src/jsonpanel.js";
import { decodeValue, encodeValue } from "../../src/document.js";
import { readFileSync } from "node:fs";
import { compressToParam, decompressFromParam, parseFragment } from "./src/url-state.js";

const assert = (cond, msg) => { if (!cond) throw new Error("FAIL: " + msg); };

const text = readFileSync(new URL("./src/demo-document.json.txt", import.meta.url), "utf8");
const doc = toNullPrototype(strictParse(text));
assert(validate(doc).length === 0, "demo document validates");

// Hierarchy model
const { root, byPath } = buildHierarchy(doc);
assert(root.children.map((c) => c.name).join(",") === "labels,tables,volume", "root children");
const volume = byPath.get("volume");
assert(volume.kind === "array", "volume is an array");
assert(arrayShape(volume).join(",") === "4,2,40,48", "volume shape");
assert(arrayDtype(volume) === "float32", "volume dtype");
assert(dimensionNames(volume).join(",") === "t,c,y,x", "volume dim names");
assert(volume.dataKeys.length === 8, "volume owns 8 chunk keys");
assert(byPath.get("tables").kind === "group", "tables is a group");
assert(byPath.get("tables/counters").kind === "array", "nested array found");

// prettyJson: BigInt fidelity + parse round trip
const counters = doc["tables/counters/c/0"];
const printed = prettyJson(counters);
assert(printed.includes("9007199254740993"), "big int printed exactly: " + printed);
const reparsed = strictParse(printed);
assert(prettyJson(reparsed) === printed, "prettyJson round-trips through strictParse");

// Editing round trip: decode + encode is identity on canonical values
for (const key of Object.keys(doc)) {
  const bytes = decodeValue(key, doc[key]);
  const re = encodeValue(key, bytes);
  assert(prettyJson(re) === prettyJson(doc[key]), "canonical identity for " + key);
}

// Full read path through zarrita
registerJsonCodec();
const store = new ZarrInlineStore(new MemoryBacking(doc), { onIssue: () => {} });
const arr = await zarr.open(zarr.root(store).resolve("/volume"), { kind: "array" });
const chunk = await zarr.get(arr);
assert(chunk.shape.join(",") === "4,2,40,48", "read shape");
assert(Number.isNaN(chunk.data[0]), "NaN corner survives");
// spot value: volume[1,1,5,7] via stride
const off = 1 * chunk.stride[0] + 1 * chunk.stride[1] + 5 * chunk.stride[2] + 7 * chunk.stride[3];
assert(Math.abs(chunk.data[off] - (Math.round((Math.sin(7 / 6 + 0.9) * Math.cos(5 / 5 + 1.7) + 0.2) * 1000) / 1000)) < 1e-6, "spot value matches");

const big = await zarr.open(zarr.root(store).resolve("/tables/counters"), { kind: "array" });
const bigChunk = await zarr.get(big);
assert(bigChunk.data[1] === 9007199254740993n, "int64 exact through zarrita: " + bigChunk.data[1]);

// URL state: compress/decompress round trip and fragment parsing
const param = await compressToParam(text);
assert(await decompressFromParam(param) === text, "doc param round-trips");
assert(param.length < text.length / 3, "compression actually shrinks: " + param.length);
assert(parseFragment("#doc=abc").kind === "doc", "doc fragment parses");
assert(parseFragment("#url=https%3A%2F%2Fx%2Fd.json").value === "https://x/d.json", "url fragment decodes");
assert(parseFragment("").kind === "empty", "no fragment means empty document");

console.log("smoke OK");
`;

writeFileSync(join(import.meta.dirname, "smoke-entry.mts"), entry);
await esbuild.build({
	entryPoints: [join(import.meta.dirname, "smoke-entry.mts")],
	bundle: true,
	format: "esm",
	platform: "node",
	target: "es2022",
	loader: { ".json": "file" },
	alias: { zarrita: join(import.meta.dirname, "node_modules/zarrita") },
	external: ["node:*"],
	outfile: join(import.meta.dirname, "smoke-bundle.mjs"),
});
await import(pathToFileURL(join(import.meta.dirname, "smoke-bundle.mjs")));
