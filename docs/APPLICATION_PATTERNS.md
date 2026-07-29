# Application patterns

How a Pegma component should use `@pegma/storage-blobs` together with
`@pegma/storage-core`. This document is the agent-taught lifecycle for opaque
bytes; the TypeScript surface lives in the package README.

## Roles

| Concern                                           | Package / layer                                   |
| ------------------------------------------------- | ------------------------------------------------- |
| Ticket rows, attachment metadata, lifecycle state | `@pegma/storage-core` collections                 |
| Object bytes, etags, content-type                 | `@pegma/storage-blobs` (`BlobStore`)              |
| Who may upload or download                        | Host routes + Authorization Core                  |
| Rate limits, body size policy                     | Host (`@pegma/rate-limit`, reverse proxy)         |
| Audit of accepted domain changes                  | `@pegma/audit` (or equivalent) in the component   |
| Malware scan / quarantine                         | Host-injected scanners; state on the metadata row |

`BlobStore` is called only by **trusted server code** after those checks.

## Key minting

Keys are opaque strings the **component** mints. They are not capabilities:
knowing a key must never authorize download. Prefer high-entropy identifiers
(for example ULID/UUID) under a stable prefix:

```text
support-desk/attachments/{ticketId}/{attachmentId}
```

Stay within the port’s key rules (non-empty, UTF-8 length cap, no control
characters). Do not put secrets or PII in keys; keys appear in provider logs.

## Upload lifecycle (metadata + bytes)

There is **no** shared transaction across storage-core and a blob put. Own the
protocol:

1. **Authorize and rate-limit** on the host route.
2. **Allocate** an opaque blob key and insert a **pending** attachment row in
   the component’s storage-core partition (include audit as required).
3. **Stream** the request body into `BlobStore.put`, preferably with
   `ifNoneMatch: "*"` so a retry does not clobber an object another worker
   already wrote under the same key.
4. **On success**, transition metadata to `available` and store size,
   content-type, and etag from the put result (and `head` if needed).
5. **On failure**, mark the row `failed` (or leave `pending` for GC) and, if a
   partial object might exist, attempt `delete` with the etag you observed.
6. **Respond** to the client from application state, never with a provider URL.

```ts
const key = mintAttachmentKey(ticketId);
await attachments.insertIfAbsent({
  id: attachmentId,
  ticketId,
  blobKey: key,
  state: "pending_upload",
  // ...
});

const put = await blobs.put(key, request.body, {
  contentType: declaredType,
  ifNoneMatch: "*",
  maxBytes: policy.maxBytes,
});

if (!put.ok) {
  await markFailed(attachmentId, put.reason);
  return conflict();
}

await markAvailable(attachmentId, {
  size: put.size,
  etag: put.etag,
  contentType: declaredType,
});
```

## Download lifecycle

1. **Authorize** against the storage-core attachment (and ticket) record — not
   against the blob key alone.
2. Refuse download when state is not `available` (or your product’s equivalent).
3. `get` the object; if missing, repair metadata (orphan/missing bytes).
4. Stream `body` to the response with safe headers (`Content-Disposition:
attachment`, `X-Content-Type-Options: nosniff`, never execute untrusted HTML
   inline from this path).

## Orphan cleanup

Listing blobs is not a snapshot. GC is a **worker over storage-core pending
rows** (and optionally a bounded `BlobStore.list` under a prefix):

- Pending older than a threshold → conditional `delete` if an etag is known, or
  unconditional delete if the product accepts that race window, then close the
  metadata row.
- When listing blobs for sweep, always `delete` with `ifMatch: entry.etag` so a
  newer object at the same key is not removed.

## What not to do

- Do not hand clients Azure SAS, R2, or S3 presigned URLs as the default path.
- Do not treat content-type or user metadata as authorization input.
- Do not log object bodies.
- Do not invent ACLs, virus scanning, or CDN purge inside `BlobStore`.
- Do not assume put + metadata update is atomic; design for pending and failed
  states.

## Related docs

- [ARCHITECTURE.md](./ARCHITECTURE.md) — trust boundary and threat model
- [PROJECT_PLAN.md](./PROJECT_PLAN.md) — phases and non-goals
- Package README — API examples and conformance wiring
