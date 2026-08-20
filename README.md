# Zarr JSON

A convention for storing Zarr v3 hierarchies in JSON documents. The goal is
simple interchange of small Zarr hierarchies: one portable,
human-inspectable, hand-editable file.

- **[SPEC.md](SPEC.md)** — the specification.
- `python/`, `typescript/`, `rust/` — reference implementations targeting
  zarr-python, zarrita, and zarrs.
- `examples/` — shared conformance fixtures, including an
  [OME-Zarr 0.5 multiscale image](examples/valid/ome_zarr_0.5_image.json).
- `docs/superpowers/specs/` — design history, conformance and crosscheck
  protocols, adversarial review record.