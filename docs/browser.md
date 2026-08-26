# Document browser

The docs site ships a single-file web app for exploring and editing
zarr-inline documents, built on the TypeScript implementation and
[zarrita](https://zarrita.dev):

- **[Open the demo](viewer/index.html#url=demo-document.json)** — the
  viewer loaded with a small demo hierarchy (a 4-D float32 volume with
  NaNs, a uint8 label image, and float64/int64 tables).
- **[Open a bare viewer](viewer/index.html)** — starts with an empty
  document; paste a document, open a local `.json` file, or fetch one
  from a URL.

The left panel shows the hierarchy as a selectable DAG of groups and
arrays. The middle panel exposes the selected node's `zarr.json` and chunk
keys as editable JSON — edits are canonicalized through the format's
decode/encode pair and re-validated live. The right panel displays the
node: groups as attribute + children cards, arrays in a multi-dimensional
slice viewer with X/Y dimension assignment, sliders for the remaining
dimensions, lookup tables (including a `text` mode that prints each
element's exact value), an optional chunk-boundary overlay, always-on axis
coordinate labels, zoom/pan, and a hover readout.

## Shareable URLs

Like neuroglancer, the viewer's state — the entire zarr-inline document —
lives in the URL fragment, so links are shareable:

- `#doc=<payload>` carries the document inline, as base64url-encoded
  raw-deflate-compressed canonical JSON. The address bar updates as you
  edit; **Copy link** hands out the current state.
- `#url=<location>` points at a document served over http(s) (the demo
  link above works this way; the server must allow cross-origin reads).
- No fragment is a bare viewer holding the empty document `{}`.

A document too large to fit a practical URL simply stops syncing to the
address bar (the status line says so); Download and Copy JSON still work.

## Source

The app lives at
[`typescript/examples/browser`](https://github.com/d-v-b/zarr-inline/tree/main/typescript/examples/browser)
— see its README for the build, the Node smoke test, and the
headless-Chromium checks.
