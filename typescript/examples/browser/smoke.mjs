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
import { prettyJson, keyTag } from "./src/jsonpanel.js";
import { decodeValue, encodeValue } from "../../src/document.js";
import { readFileSync } from "node:fs";
import { compressToParam, decompressFromParam, parseFragment } from "./src/url-state.js";
import { metadataIssues } from "./src/metadata.js";

const assert = (cond, msg) => { if (!cond) throw new Error("FAIL: " + msg); };

const text = readFileSync(new URL("./src/demo-document.json.txt", import.meta.url), "utf8");
const doc = toNullPrototype(strictParse(text));
assert(validate(doc).length === 0, "demo document validates");

// Hierarchy model
const { root, byPath } = buildHierarchy(doc);
assert(root.children.map((c) => c.name).join(",") === "image,tables", "root children");
const image = byPath.get("image");
assert(image.kind === "array", "image is an array");
assert(arrayShape(image).join(",") === "20,20,20", "image shape");
assert(arrayDtype(image) === "uint8", "image dtype");
assert(dimensionNames(image).join(",") === "z,y,x", "image dim names");
assert(image.dataKeys.length === 64, "image owns 64 chunk keys");
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
const arr = await zarr.open(zarr.root(store).resolve("/image"), { kind: "array" });
const chunk = await zarr.get(arr);
assert(chunk.shape.join(",") === "20,20,20", "read shape");
// Integer-exact sphere glow: v = max(0, 255 - d2*255//1083)
const expected = (z, y, x) => {
  const d2 = (2 * z - 19) ** 2 + (2 * y - 19) ** 2 + (2 * x - 19) ** 2;
  return Math.max(0, 255 - Math.floor((d2 * 255) / 1083));
};
for (const [z, y, x] of [[0, 0, 0], [10, 10, 10], [19, 3, 12], [5, 15, 9]]) {
  const off = z * chunk.stride[0] + y * chunk.stride[1] + x * chunk.stride[2];
  assert(chunk.data[off] === expected(z, y, x), "spot value at " + z + "," + y + "," + x);
}

const big = await zarr.open(zarr.root(store).resolve("/tables/counters"), { kind: "array" });
const bigChunk = await zarr.get(big);
assert(bigChunk.data[1] === 9007199254740993n, "int64 exact through zarrita: " + bigChunk.data[1]);

// Codec-aware tags: an inline chunk is only "data" under the json codec
const imageChunkTag = keyTag(image, "image/c/0/0/0", doc["image/c/0/0/0"]);
assert(imageChunkTag.tag === "JSON Array", "json-codec chunk tagged as data: " + imageChunkTag.tag);
const rawDoc = toNullPrototype(strictParse(JSON.stringify({
  "zarr.json": { zarr_format: 3, node_type: "group" },
  "raw/zarr.json": { zarr_format: 3, node_type: "array", shape: [7], data_type: "uint8",
    chunk_grid: { name: "regular", configuration: { chunk_shape: [7] } },
    chunk_key_encoding: { name: "default" }, fill_value: 0, codecs: [{ name: "bytes" }] },
  "raw/c/0": [1, 2, 3],
})));
const raw = buildHierarchy(rawDoc).byPath.get("raw");
const rawTag = keyTag(raw, "raw/c/0", rawDoc["raw/c/0"]);
assert(rawTag.tagClass === "tag-warn" && rawTag.tag.includes("bytes"), "bytes-codec inline chunk warns: " + rawTag.tag);

// Semantic metadata lint (zarr-metadata): clean demo, flagged violations
for (const key of Object.keys(doc).filter((k) => k.endsWith("zarr.json"))) {
  assert(metadataIssues(doc[key]).length === 0, "demo metadata is clean: " + key);
}
const broken = JSON.parse(JSON.stringify(doc["image/zarr.json"]));
broken.shape = [20, 20]; // chunk_shape stays 3-D: arity mismatch
const arity = metadataIssues(broken);
assert(arity.length > 0 && arity.some((i) => i.path.includes("chunk_shape")), "chunk-grid arity flagged: " + JSON.stringify(arity));
const badFill = JSON.parse(JSON.stringify(doc["image/zarr.json"]));
badFill.fill_value = "NaN"; // not a uint8 value
assert(metadataIssues(badFill).some((i) => i.path.includes("fill_value")), "fill_value vs dtype flagged");
const missing = JSON.parse(JSON.stringify(doc["image/zarr.json"]));
delete missing.data_type;
assert(metadataIssues(missing).some((i) => i.kind === "missing_key"), "missing data_type flagged structurally");

// Viewer-support lint: grids zarrita cannot read are flagged before it crashes
const recti = JSON.parse(JSON.stringify(doc["image/zarr.json"]));
recti.chunk_grid = { name: "rectilinear", configuration: { chunk_shapes: [[5,5,5,5],[5,5,5,5],[5,5,5,5]] } };
assert(metadataIssues(recti).some((i) => i.message.includes("cannot be displayed")), "rectilinear flagged as unsupported");
const shapes = JSON.parse(JSON.stringify(doc["image/zarr.json"]));
shapes.chunk_grid = { name: "regular", configuration: { chunk_shapes: [5, 5, 5] } };
assert(metadataIssues(shapes).some((i) => i.path.join(".") === "chunk_grid.configuration.chunk_shape"), "regular grid without chunk_shape flagged");

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
