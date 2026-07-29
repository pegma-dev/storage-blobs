# Adapter authoring guide

How to implement a `BlobStore` backend for `@pegma/storage-blobs`. The
**conformance suite is the specification.** A behaviour not asserted there is
not something a component may rely on, and an adapter is finished only when it
passes the suite against a **real empty backend** (never a mocked client).

## Packages and layout

| Package                        | Role                                   |
| ------------------------------ | -------------------------------------- |
| `@pegma/storage-blobs`         | Port, memory store, conformance export |
| `@pegma/storage-azure-blob`    | Azure Blob (this monorepo)             |
| `@pegma/storage-cloudflare-r2` | Cloudflare R2 (this monorepo)          |
| `@pegma/storage-s3`            | AWS S3 / S3-compatible (later phase)   |

One package per backend family. Depend on `@pegma/storage-blobs` at an exact
published version when consumers install you; workspace `*` is fine inside this
monorepo only.

## Required surface

Implement the full `BlobStore` interface from `@pegma/storage-blobs`:

- `put` / `get` / `head` / `delete` / `list`
- Result-shaped conditionals (`ifNoneMatch: "*"`, `ifMatch`, delete outcomes)
- Store-level and optional per-call size ceilings
- Web-standard `ReadableStream` / `Uint8Array` bodies
- Key, content-type, and user-metadata validation equivalent to the port

Do **not** add methods to `BlobStore` in an adapter package. New methods are a
breaking change on the port and must land with conformance cases in the same
change.

## Running conformance

```ts
import { describe, it } from "vitest";
import {
  concurrentConformanceCases,
  conformanceCases,
  dualStoreConformanceCases,
  sizeLimitConformanceCases,
} from "@pegma/storage-blobs/conformance";
import { createMyBlobStore, type BlobStore } from "./index.js";

// Provision a fresh empty container/bucket, return a factory of client handles
// that all talk to that same empty backend for the duration of one case.
async function openEmptyBackend(): Promise<{
  createStore: () => BlobStore;
  close: () => Promise<void>;
}> {
  const bucket = await provisionEmptyBucket(); // real service
  return {
    createStore: () => createMyBlobStore({ bucket }),
    close: () => destroyBucket(bucket),
  };
}

describe("my adapter", () => {
  for (const testCase of conformanceCases) {
    it(testCase.name, async () => {
      const backend = await openEmptyBackend();
      try {
        // Repeated createStore() calls share this case's empty backend.
        await testCase.run(() => backend.createStore());
      } finally {
        await backend.close();
      }
    });
  }

  for (const testCase of sizeLimitConformanceCases) {
    it(testCase.name, async () => {
      // Factory must return BlobStore synchronously (not a Promise).
      const buckets: Awaited<ReturnType<typeof provisionEmptyBucket>>[] = [];
      try {
        await testCase.run((limitBytes) => {
          // Synchronous: provision must complete before run, or use a
          // pre-created pool. Here we block via a sync helper your harness owns.
          const bucket = provisionEmptyBucketSync();
          buckets.push(bucket);
          return createMyBlobStore({ maxObjectBytes: limitBytes, bucket });
        });
      } finally {
        for (const bucket of buckets) {
          await destroyBucket(bucket);
        }
      }
    });
  }

  for (const testCase of concurrentConformanceCases) {
    it(testCase.name, async () => {
      const backend = await openEmptyBackend();
      try {
        // Every createStore() must share ONE empty backend for the race.
        await testCase.run(() => backend.createStore());
      } finally {
        await backend.close();
      }
    });
  }

  for (const testCase of dualStoreConformanceCases) {
    it(testCase.name, async () => {
      const a = await openEmptyBackend();
      const b = await openEmptyBackend();
      try {
        await testCase.run(
          () => a.createStore(),
          () => b.createStore(),
        );
      } finally {
        await a.close();
        await b.close();
      }
    });
  }
});
```

### Factory contract

- **`conformanceCases`:** one empty physical backend per case. `createStore()`
  may return the same handle or a new client to that backend.
- **`concurrentConformanceCases`:** every `createStore()` call in the case must
  share **one** empty backend so create-only races are real.
- **`dualStoreConformanceCases`:** two **independent** empty backends (two
  buckets/containers), not two clients to one bucket.
- **`sizeLimitConformanceCases`:** construct a store whose maximum equals the
  factory argument.

## Mapping rules

1. **Honest intersection.** If Azure, R2, or S3 cannot honour a guarantee
   without lying, the port will not promise it. Do not paper over gaps with
   local emulation that other adapters cannot match.
2. **Conditionals.** Prefer native `If-Match` / `If-None-Match` (or SDK
   equivalents). Map precondition failures to `{ ok: false, reason }` — do not
   throw for expected races.
3. **Etags.** Opaque strings; pass them through. Never invent etag semantics
   components can parse (for example, requiring a quoted form unless every
   backend uses it — they do not).
4. **Streaming.** Accept `ReadableStream` and `Uint8Array`. When the provider
   needs multipart under the hood, hide that inside `put`.
5. **Oversize.** Enforce the configured ceiling. Cancelling a remaining body
   stream after the limit is hit is allowed (see port docs).
6. **Listing.** Opaque cursors bound to the backend identity. Foreign or
   malformed cursors → `BlobValidationError`. Listing is not a snapshot.
7. **Validation.** Match port key/metadata/content-type rules (ASCII metadata
   values, lowercase metadata keys, path segment limits, etc.). Prefer
   rejecting early with `BlobValidationError` rather than provider 400s that
   adapters must translate inconsistently.

## What not to put in an adapter

- Authorization, rate limits, audit, malware scanning
- Signed URL minting as the primary integration path
- Structured attachment/ticket metadata (that is storage-core)
- Multi-bucket routing inside one `BlobStore` instance

## CI expectations

Adapters in this monorepo run the suite against Azurite (Azure), LocalStack S3
as an S3-compatible stand-in for R2 (or a real empty R2 bucket),
LocalStack/MinIO/S3, or an equivalent **empty** service. Mocked SDK clients are
not enough. Prefer ephemeral containers/buckets per job and tear them down.

## Freezing the contract

The exported suite is frozen for v1 behaviour. Adding a method or changing a
guarantee requires:

1. Conformance cases in the same change
2. Implementation in every in-repo adapter
3. A minor version bump on the port package

If you need behaviour the suite does not assert, open a port change first —
do not ship private adapter semantics that components will depend on.
