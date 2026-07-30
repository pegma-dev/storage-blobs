# `@pegma/storage-azure-blob`

[![CI](https://github.com/pegma-dev/storage-blobs/actions/workflows/ci.yml/badge.svg)](https://github.com/pegma-dev/storage-blobs/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Azure Blob Storage adapter for [`@pegma/storage-blobs`](../storage-blobs).

> [!IMPORTANT]
> Early `0.x` (`0.2.0` on npm). Pin exact versions. Verified against Azurite in
> this monorepo's CI.

## Usage

```ts
import { BlobServiceClient } from "@azure/storage-blob";
import { createAzureBlobStore } from "@pegma/storage-azure-blob";

const service = BlobServiceClient.fromConnectionString(
  process.env.AZURE_STORAGE_CONNECTION_STRING!,
);
const container = service.getContainerClient("my-app-blobs");
await container.createIfNotExists();

const blobs = createAzureBlobStore({
  containerClient: container,
  maxObjectBytes: 16 * 1024 * 1024,
});
```

One store instance binds to **one container**. Namespace with key prefixes.

## Conformance

```ts
import { conformanceCases } from "@pegma/storage-blobs/conformance";
import { createAzureBlobStore } from "@pegma/storage-azure-blob";

// Each case needs an empty container; createStore() may return fresh clients
// to that same empty container.
```

See [ADAPTER_AUTHORING.md](../../docs/ADAPTER_AUTHORING.md).

## License

[MIT](LICENSE) © 2026 RetireGolden, LLC
