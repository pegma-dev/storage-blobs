# Storage Blobs

[![CI](https://github.com/pegma-dev/storage-blobs/actions/workflows/ci.yml/badge.svg)](https://github.com/pegma-dev/storage-blobs/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Object (blob) storage for [Pegma](https://pegma.dev) components — the byte
counterpart to structured records in `@pegma/storage-core`.

> [!IMPORTANT]
> Storage Blobs is in early `0.x` development. Nothing is published yet. The
> public API is not stable.

## Why it exists

`@pegma/storage-core` stores structured records (collections, versions,
single-partition transactions). Blobs are a different job: streams,
content-types, size limits, opaque keys, and conditional put/delete against
object stores such as Azure Blob Storage, Cloudflare R2, and S3.

This repository owns that port. Components declare opaque keys and stream
bytes; hosts inject a `BlobStore` bound to one container or bucket. Clients
reach storage only through the host API — not through provider-signed URLs by
default — so authorization, rate limits, validation, and logging stay on the
application path.

## Packages

| Package                        | Role                                  | Status  |
| ------------------------------ | ------------------------------------- | ------- |
| `@pegma/storage-blobs`         | Port, memory store, conformance suite | In tree |
| `@pegma/storage-azure-blob`    | Azure Blob Storage adapter            | In tree |
| `@pegma/storage-cloudflare-r2` | Cloudflare R2 adapter                 | In tree |
| `@pegma/storage-s3`            | AWS S3 / S3-compatible adapter        | In tree |

## Constraint that shapes everything

**The conformance suite is the specification.** A behaviour not asserted there
is not something a component may rely on. An adapter is finished when it passes
the suite against a real empty backend.

**Do not promise what every first-class adapter cannot keep.** The port is the
honest intersection of Azure Blob, R2, and S3 — not the union of their
marketing features.

## Documentation

- [Project plan](docs/PROJECT_PLAN.md) — phases, scope, and decisions
- [Architecture](docs/ARCHITECTURE.md) — boundaries and threat model
- [Application patterns](docs/APPLICATION_PATTERNS.md) — metadata + bytes lifecycle
- [Adapter authoring](docs/ADAPTER_AUTHORING.md) — implement a real backend
- [Releasing](docs/RELEASING.md) — trusted-publisher release runbook

## Development

Requires Node.js 22 or newer.

```sh
npm ci
npm run format:check
npm run check
npm test
```

## License

[MIT](LICENSE) © 2026 RetireGolden, LLC
