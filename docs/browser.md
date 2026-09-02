# Document browser

The docs site ships a single-file web app for exploring and editing
zarr-inline documents, built on the TypeScript implementation and
[zarrita](https://zarrita.dev):

- **[Open the demo](viewer/index.html#url=demo-document.json)** — the
  viewer loaded with a small demo hierarchy: a 20×20×20 uint8 volume in
  (5,5,5) chunks plus an int64 table, small enough that every chunk is
  comfortable to edit by hand.
- **[Open a bare viewer](viewer/index.html)** — starts with an empty
  document; paste a document, open a local `.json` file, or fetch one
  from a URL.

The browser pane lists, for the selected node, its members (child groups
and arrays, tagged **Group** or **Array** — click to navigate) together
with every document key it owns — its `zarr.json` and its chunks, tagged
with their encoding (**JSON Object**, **JSON Array**, or **base64**) — as
one flat, prefix-searchable collection (type `c/` to see only chunks)
under a breadcrumb for moving up; keys expand into a syntax-highlighted
JSON editor, and edits are
canonicalized through the format's decode/encode pair, re-validated
live, and the viewer updates on every Apply. Keys can be added and
deleted, so the document's data is fully live: edit `image/zarr.json`
from 3-D to 2-D, add a `c/0/0` chunk, and watch the pixels appear. The right panel displays the
node: groups as attribute + children cards, arrays in a multi-dimensional
slice viewer with X/Y dimension assignment, sliders for the remaining
dimensions, lookup tables (including a `text` mode that prints each
element's exact value), an optional chunk-boundary overlay, always-on axis
coordinate labels, zoom/pan, and a hover readout. A header toggle
switches between this two-pane browser and a **JSON view** — the whole
document as one editable, syntax-highlighted text; Apply canonicalizes
it and both views stay in sync.

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
