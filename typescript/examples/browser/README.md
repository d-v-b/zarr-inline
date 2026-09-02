# zarr-inline document browser

A single-file web app for exploring and editing zarr-inline documents,
built on the TypeScript implementation and [zarrita](https://zarrita.dev).
A header toggle switches between the two-pane **Browser** view and a
**JSON** view holding the whole document as one editable,
syntax-highlighted text.

- **Browser pane** (left): the selected node's *members* (child groups
  and arrays, tagged **Group** / **Array** — click to navigate) and its
  *keys* (`zarr.json` plus chunk/data keys, tagged **JSON Object**,
  **JSON Array**, or **base64** — click to expand a syntax-highlighted
  editor) as one flat, prefix-searchable list (`c/` filters to chunks)
  under a breadcrumb for moving up. Applying an edit round-trips the
  value through the zarr-inline decode/encode pair, so whatever you type
  is stored canonically, and the whole document is re-validated live.
  Keys can be added and deleted too, and the viewer updates on every
  change — edit `zarr.json` to turn a 3-D image into a 2-D one, then add
  fresh chunk keys (`c/0/0`) and watch the pixels appear. `zarr.json`
  edits are linted live with [zarr-metadata](https://www.npmjs.com/package/zarr-metadata)
  — structure plus the spec's cross-field rules (chunk-grid arity,
  transpose permutations, sharding divisibility, `fill_value` vs data
  type) — shown as flags under the editor, in the key's tag, and as a
  document-wide count in the status bar; they never block an edit, since
  zarr-inline itself does not validate hierarchy coherence.
- **Display panel** (right): groups show their attributes and children;
  arrays open in a multi-dimensional slice viewer — assign any two
  dimensions to X/Y, scrub the rest with sliders, pick a lookup table
  (gray/viridis/magma/coolwarm, or **text**, which renders every element
  as its numeric value), zoom and pan (wheel/drag), and hover for exact
  values. X/Y axis coordinate labels are always shown; with the chunk
  grid on, a second axis band labels each chunk's index and the hover
  readout names the exact chunk key (c/…). NaN renders as transparent
  checkerboard. Big int64 values stay exact end to end (strict parsing
  preserves them as BigInt).

## Build and run

```sh
npm install
npm run build     # writes dist/index.html — a single self-contained file
```

Open `dist/index.html` directly in a browser (no server needed), or run
`npm run serve` for a rebuild-on-change dev server. A bare viewer holds
the empty document `{}`; load a document with Open/Paste/URL, drop a
`.json` file anywhere on the page, or press Demo for the embedded demo
hierarchy (a 20×20×20 uint8 volume in (5,5,5) chunks plus an int64
table, generated with the Python implementation's `from_zarr` — small
enough that every chunk is comfortable to edit by hand).

## Shareable URLs

Neuroglancer-style, the whole document travels in the URL fragment:
`#doc=<base64url(deflate-raw(canonical JSON))>` carries it inline (the
address bar live-updates as you edit; Copy link shares the current
state), `#url=<location>` fetches it from an http(s) server that allows
cross-origin reads, and no fragment is the bare empty viewer. Documents
too large for a practical URL stop syncing and the status line says so.
The project docs host this app with the demo document served next to it,
linked as `viewer/#url=demo-document.json`.

## Checks

`npm run check` builds the bundle and runs `smoke.mjs`, a Node test of the
non-DOM logic (hierarchy model, BigInt-safe pretty printer, the
decode/encode identity on canonical values, and the full read path through
the store, the `json` codec, and zarrita). `pw-check.mjs` drives the built
page in headless Chromium — canvas rendering, sliders, hover readout,
metadata editing — and needs an extra dependency:

```sh
npm install --no-save playwright && npx playwright install chromium
node pw-check.mjs
```

## Notes

- The build injects a tiny `Buffer` shim (base64 only) because the library
  sources use Node's `Buffer`, and aliases `zarrita` to a single copy so
  the app and the library share one codec registry.
- Exact big-integer parsing needs `JSON.parse` reviver source access; in a
  browser without it the app falls back to plain `JSON.parse` and says so
  after an edit.
- Like the format itself, the app reads whole arrays into memory — it is
  meant for small hierarchies.
