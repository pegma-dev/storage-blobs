# `@pegma/storage-s3`

[![CI](https://github.com/pegma-dev/storage-blobs/actions/workflows/ci.yml/badge.svg)](https://github.com/pegma-dev/storage-blobs/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

AWS S3 / S3-compatible adapter for [`@pegma/storage-blobs`](../storage-blobs).

> [!IMPORTANT]
> Early `0.x`. Not published yet. Verified in this monorepo's CI against
> LocalStack S3. Point the same client at real AWS S3 for production. Other
> S3-compatible products must pass the frozen conformance suite before hosts
> rely on them (MinIO is not a CI-proven target for this package).

## Usage

```ts
import { S3Client } from "@aws-sdk/client-s3";
import { createS3BlobStore } from "@pegma/storage-s3";

const client = new S3Client({
  region: process.env.AWS_REGION ?? "us-east-1",
  // Optional for AWS; set for path-style / custom endpoints (e.g. LocalStack)
  // forcePathStyle: true,
  // endpoint: process.env.S3_ENDPOINT,
});

const blobs = createS3BlobStore({
  client,
  bucket: "my-app-blobs",
  endpoint:
    process.env.S3_ENDPOINT ??
    `https://s3.${process.env.AWS_REGION}.amazonaws.com`,
  maxObjectBytes: 16 * 1024 * 1024,
});
```

One store instance binds to **one bucket**. Namespace with key prefixes. The
host owns the `S3Client` (credentials, endpoint, retry policy); this package
never reads environment secrets itself. `endpoint` or `backendId` is
**required** so list cursors cannot cross accounts that reuse a bucket name.

## Conformance

```ts
import { conformanceCases } from "@pegma/storage-blobs/conformance";
import { createS3BlobStore } from "@pegma/storage-s3";

// Each case needs an empty bucket; createStore() may return fresh clients
// to that same empty bucket.
```

See [ADAPTER_AUTHORING.md](../../docs/ADAPTER_AUTHORING.md).

## License

[MIT](LICENSE) © 2026 RetireGolden, LLC
