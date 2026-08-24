# zarr-inline

zarr-inline is a convention for storing an entire Zarr v3 hierarchy in one
JSON object. It is intended for small datasets that benefit from portable,
human-inspectable, and hand-editable interchange.

The [specification](specification.md) defines the interoperable document and
codec behavior. [How it works](how-it-works.md) explains the design rationale,
reference implementations, conformance harnesses, and known limitations.

## Reference implementations

The repository contains implementations for three Zarr libraries:

- [Python with zarr-python](https://github.com/d-v-b/zarr-inline/tree/main/python)
- [TypeScript with zarrita](https://github.com/d-v-b/zarr-inline/tree/main/typescript)
- [Rust with zarrs](https://github.com/d-v-b/zarr-inline/tree/main/rust)

All three consume the same examples and serialized conformance protocols. The
cross-implementation suite compares document behavior, whole-array reads and
writes, and operation traces, including one-level and nested sharding.

## Development

The repository [`justfile`](https://github.com/d-v-b/zarr-inline/blob/main/justfile)
is the command interface used locally and in CI:

```console
just test-python
just test-typescript
just test-rust
just cross
just docs-check
just check
```

Run `just docs-serve` to preview this site locally.
