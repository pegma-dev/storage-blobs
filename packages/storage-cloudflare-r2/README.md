# `@pegma/storage-cloudflare-r2`

[![CI](https://github.com/pegma-dev/storage-blobs/actions/workflows/ci.yml/badge.svg)](https://github.com/pegma-dev/storage-blobs/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Cloudflare R2 adapter for [`@pegma/storage-blobs`](../storage-blobs), via R2's
S3-compatible API.

> [!IMPORTANT]
> Early `0.x` (`0.1.0` on npm). Pin exact versions. Verified in this monorepo's
> CI against LocalStack S3 (S3-compatible local harness). Point the same client
> at a real R2 endpoint for production.

## Usage

```ts
import { S3Client } from "@aws-sdk/client-s3";
import { createCloudflareR2BlobStore } from "@pegma/storage-cloudflare-r2";

const client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

const endpoint = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
const blobs = createCloudflareR2BlobStore({
  client,
  bucket: "my-app-blobs",
  endpoint,
  maxObjectBytes: 16 * 1024 * 1024,
});
```

One store instance binds to **one bucket**. Namespace with key prefixes. The
host owns the `S3Client` (credentials, endpoint, retry policy); this package
never reads environment secrets itself. `endpoint` or `backendId` is **required** so list cursors cannot cross accounts
that reuse a bucket name.

## Conformance

```ts
import { conformanceCases } from "@pegma/storage-blobs/conformance";
import { createCloudflareR2BlobStore } from "@pegma/storage-cloudflare-r2";

// Each case needs an empty bucket; createStore() may return fresh clients
// to that same empty bucket.
```

See [ADAPTER_AUTHORING.md](../../docs/ADAPTER_AUTHORING.md).

## License

[MIT](LICENSE) © 2026 RetireGolden, LLC
