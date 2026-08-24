# zarr-inline

A convention for storing Zarr v3 hierarchies in JSON documents. The goal is
simple interchange of small Zarr hierarchies: one portable,
human-inspectable, hand-editable file.

The project is licensed under the [MIT License](LICENSE).

- **[SPEC.md](SPEC.md)** — the specification.
- `python/`, `typescript/`, `rust/` — reference implementations targeting
  zarr-python, zarrita, and zarrs.
- `examples/` — shared conformance fixtures, including an
  [OME-Zarr 0.5 multiscale image](examples/valid/ome_zarr_0.5_image.json).
- **[DESIGN.md](DESIGN.md)** — how it works: the model, design rationale,
  implementation architecture, conformance and crosscheck protocols, and
  known limitations.

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
