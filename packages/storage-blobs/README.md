# `@pegma/storage-blobs`

[![CI](https://github.com/pegma-dev/storage-blobs/actions/workflows/ci.yml/badge.svg)](https://github.com/pegma-dev/storage-blobs/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Provider-neutral object (blob) storage for [Pegma](https://pegma.dev)
components: opaque keys, streaming put/get, conditional writes, bounded prefix
listing, and a conformance suite that every adapter must pass.

> [!IMPORTANT]
> This package is in early `0.x` scaffolding. It is not published and its
> public API is not stable. See [PROJECT_PLAN.md](../../docs/PROJECT_PLAN.md).

## Status

Repository bootstrap only. The `BlobStore` port, in-memory reference
implementation, and `@pegma/storage-blobs/conformance` export are planned next.
Cloud adapters (`@pegma/storage-azure-blob`, `@pegma/storage-cloudflare-r2`,
`@pegma/storage-s3`) follow once the port is proven against two real backends.

## License

[MIT](LICENSE) © 2026 RetireGolden, LLC
