# `@pegma/storage-blobs`

[![CI](https://github.com/pegma-dev/storage-blobs/actions/workflows/ci.yml/badge.svg)](https://github.com/pegma-dev/storage-blobs/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Provider-neutral object (blob) storage for [Pegma](https://pegma.dev)
components: opaque keys, streaming put/get, conditional writes, bounded prefix
listing, and a conformance suite that every adapter must pass.

> [!IMPORTANT]
> Early `0.x` (`0.1.0` on npm). Pin exact versions; the public API is not frozen.
> See [PROJECT_PLAN.md](../../docs/PROJECT_PLAN.md).

## Install

```sh
npm install @pegma/storage-blobs@0.1.0
```

## Server-side composition

Hosts construct one `BlobStore` per container or bucket and inject it into
application services. Clients never talk to Azure, R2, or S3 directly; the host
API authorizes, rate-limits, and streams through the store.

```ts
import { createMemoryBlobStore, type BlobStore } from "@pegma/storage-blobs";

// Local / tests. Production hosts inject an adapter for one bucket.
const blobs: BlobStore = createMemoryBlobStore({
  maxObjectBytes: 16 * 1024 * 1024,
});

const key = "support-desk/attachments/01JEXAMPLE";
const put = await blobs.put(key, requestBodyStream, {
  contentType: "application/pdf",
  ifNoneMatch: "*", // create-only
  userMetadata: { ticket_id: "t_123" },
});

if (!put.ok) {
  // "exists" — another writer won the create-only race
  throw conflict(put.reason);
}

const object = await blobs.get(key);
if (object === null) {
  return notFound();
}
// Stream object.body to the HTTP response with safe Content-Disposition.
```

### Conditionals

Expected races return a result, not an exception:

| Call     | Condition          | Refusal                                 |
| -------- | ------------------ | --------------------------------------- |
| `put`    | `ifNoneMatch: "*"` | `{ ok: false, reason: "exists" }`       |
| `put`    | `ifMatch: etag`    | `"missing"` or `"changed"`              |
| `delete` | `ifMatch: etag`    | `"missing"` or `"changed"`              |
| `delete` | (none)             | `"missing"` if the key was already free |

Infrastructure failures still throw (`BlobStoreError` and subclasses).

### Listing for GC

```ts
let cursor: string | undefined;
do {
  const page = await blobs.list({
    prefix: "support-desk/",
    limit: 100,
    cursor,
  });
  for (const entry of page.objects) {
    await blobs.delete(entry.key, { ifMatch: entry.etag });
  }
  cursor = page.nextCursor ?? undefined;
} while (cursor !== undefined);
```

Listing is not a snapshot. Always delete with the etag you observed.

## Conformance (v1 specification)

The exported suite **is** the v1 contract. A behaviour not asserted there is
not something a component may rely on. New `BlobStore` methods require suite
cases in the same change. See [ADAPTER_AUTHORING.md](../../docs/ADAPTER_AUTHORING.md).

Every adapter must pass the suite against a real empty backend:

```ts
import { describe, it } from "vitest";
import { conformanceCases } from "@pegma/storage-blobs/conformance";
import { createMemoryBlobStore } from "@pegma/storage-blobs";

describe("my adapter", () => {
  for (const testCase of conformanceCases) {
    it(testCase.name, () => testCase.run(() => createMyStore()));
  }
});
```

Size-limit and concurrent create-only cases are exported separately when the
adapter needs a dedicated small ceiling or parallel writers:

```ts
import {
  concurrentConformanceCases,
  dualStoreConformanceCases,
  sizeLimitConformanceCases,
} from "@pegma/storage-blobs/conformance";
```

## What this package is not

- Not an access-control system. Authorization and rate limits belong on the host.
- Not structured persistence. Ticket rows and attachment lifecycle live in
  `@pegma/storage-core`.
- Not client-facing signed URLs. The default path is
  `Client → host API → BlobStore → provider`.

See [ARCHITECTURE.md](../../docs/ARCHITECTURE.md) and
[APPLICATION_PATTERNS.md](../../docs/APPLICATION_PATTERNS.md).

## License

[MIT](LICENSE) © 2026 RetireGolden, LLC
