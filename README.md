# zarr-inline

> [!WARNING]
> **zarr-inline is unstable.** The format (specification 0.2.0-draft) and
> the APIs of all three implementations may change incompatibly without
> notice. Do not use it as the only copy of data you care about.

A convention for storing Zarr v3 hierarchies in JSON documents. The goal is
simple interchange of small Zarr hierarchies: one portable,
human-inspectable, hand-editable file.

Read the [project documentation](https://d-v-b.github.io/zarr-inline/) or go
directly to the [specification](https://d-v-b.github.io/zarr-inline/specification/)
and [design guide](https://d-v-b.github.io/zarr-inline/how-it-works/). The docs
also host an in-browser [document browser](https://d-v-b.github.io/zarr-inline/browser/)
— [open the demo](https://d-v-b.github.io/zarr-inline/viewer/#url=demo-document.json)
to explore and edit a zarr-inline document, with shareable URLs. (The same
content lives in-repo under [docs/](docs/index.md).)

The project is licensed under the [MIT License](LICENSE).

- `python/`, `typescript/`, `rust/` — reference implementations targeting
  zarr-python, zarrita, and zarrs.
- `examples/` — shared conformance fixtures, including an
  [OME-Zarr 0.5 multiscale image](examples/valid/ome_zarr_0.5_image.json).

## Development

The root [`justfile`](justfile) is the command interface used locally and in
CI. Run `just` to list recipes. The main entry points are:

```console
just test-python
just test-typescript
just test-rust
just cross-conformance
just cross-arrays
just cross-traces
just cross
just check
```

`just cross` builds all three harnesses once, then runs document-level
conformance, the whole-array writer × reader matrix, and serialized operation
traces. It fails if any implementation harness is unavailable.
