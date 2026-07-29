# Storage Blobs Project Plan

## Status

**Stage:** Repository bootstrap. Workspace, CI, release tooling, and planning
docs only. No port implementation and no npm publication.

**Package (planned first release):** `@pegma/storage-blobs@0.1.0`

**License:** MIT

**First named consumer (planned):** Support Desk Phase 9 — attachments and
authorized downloads for the retiregolden.org (Azure) and pegma.dev
(Cloudflare) hosts.

**Sibling foundation:** `@pegma/storage-core` for structured records. This
repository never stores ticket rows, attachment lifecycle state, or audit
events; those remain storage-core collections owned by the consuming
component.

## Vision

Pegma components need to store opaque bytes the same way they store records:
through a narrow, provider-neutral port, proven by conformance, with thin
adapters for each cloud. Hosts compose `BlobStore` next to `Store`. Application
services authorize, rate-limit, validate, log, and audit on the **API path**;
the object backend is an implementation detail the end user never sees.

## Problem statement

1. **Records and blobs are different jobs.** Tables/D1 give keyed records,
   versions, and single-partition transactions. Object stores give streams,
   content-types, size, etags, and prefix listing. Forcing one port to pretend
   to be the other produces lies or unimplementable APIs.
2. **Cloud object APIs are similar but not identical.** Azure Blob, R2, and S3
   share a core; they diverge on ACLs, multipart protocols, checksum algorithms,
   and signed-URL constraint expressiveness. The port must be the **honest
   intersection**, not the union.
3. **Controls belong on the application path.** Rate limiting, authorization,
   validation, correlation logging, and audit of accepted changes are host and
   component concerns. Defaulting to client ↔ provider signed URLs weakens or
   relocates those controls. The primary integration is
   `Client ↔ host API ↔ BlobStore ↔ provider`.
4. **Agents assemble Pegma.** The package must be boring to read: small surface,
   explicit non-goals, conformance as the spec, and a single application pattern
   for metadata-in-storage-core plus bytes-in-BlobStore.

## Core model (target)

- **`BlobStore`** — one binding to one container/bucket. Opaque string keys,
  streaming put/get, head, delete, etag-conditioned writes/deletes, bounded
  prefix list with opaque cursor, configured max object size.
- **`createMemoryBlobStore`** — reference implementation with the same rules as
  production adapters; default for tests and local composition.
- **`@pegma/storage-blobs/conformance`** — framework-free cases every adapter
  must pass against a real empty backend.
- **Adapters** — `@pegma/storage-azure-blob`, `@pegma/storage-cloudflare-r2`,
  `@pegma/storage-s3` (S3 also covers many S3-compatible endpoints).

Exact TypeScript shapes are fixed in the port phase and frozen by the suite;
this plan states intent, not the final export list.

## Design decisions

### API-mediated access is the default

Hosts expose upload and download over their own HTTP routes. The route layer
runs Authorization Core, `@pegma/rate-limit`, size/type policy, and structured
logging. The application service calls `BlobStore` with streams. Clients never
receive Azure, R2, or S3 URLs in the standard path and need not know which
provider is configured.

Provider-signed (SAS / presigned) URLs are **not** part of the v1 port. They
remain a possible later host-level optimization with a separate threat model
(mint-time authz, weak transfer-time controls, provider log split). They must
not become the agent-taught default.

### Opaque keys; content addressing as policy

The store addresses opaque keys the component mints (with charset and length
limits that all first-class backends accept). Content-addressed keys may be
layered by a consumer via create-only conditional put; they are not the store's
native identity model. Per-object retention and deletion require independent
object identity.

### No atomicity with storage-core transactions

A blob put and a ticket row cannot share one `transact`. The durable pattern is
application-owned:

1. Authorize and rate-limit on the host route.
2. Allocate an opaque key and write pending attachment metadata in the
   component's storage-core partition (with audit as required).
3. Stream bytes into `BlobStore.put` (prefer create-only conditionals).
4. On success, transition metadata to available (store size, content-type, etag).
5. On failure, mark failed or leave pending for GC; delete orphan bytes with
   conditional delete when an etag is known.
6. Download: authorize on metadata, then `get` and stream the response with safe
   headers.

Orphan cleanup is a worker over storage-core pending rows plus conditional blob
delete — not a feature of the blob port.

### Quarantine and malware stay outside

Lifecycle states (`pending_upload`, `available`, `quarantined`, `rejected`) live
on storage-core records. Optional scan ports are host-injected. Serving policy
(attachment disposition, no HTML inline, isolated origin) is host topology.
`BlobStore` does not implement ACLs, roles, or virus scanning.

### Web-standard I/O

Public APIs use `ReadableStream` / `Uint8Array`, not Node `Buffer` or Node
streams. Multipart upload protocols stay inside adapters when size requires
them; v1 does not expose initiate/complete multipart on the port.

### Conditionals are first-class

Opaque etags, create-only put, replace-if-match, and delete-if-match use
**result-shaped** outcomes for expected races (same spirit as storage-core
transaction refusals). Genuine infrastructure failures still throw.

### One store instance = one container/bucket

The host constructs `createAzureBlobStore({ ... })` or equivalent per bucket.
Logical namespacing uses key prefixes (`support-desk/…`), not multi-bucket
routing inside one instance.

## Scope

### In scope

- Port, memory store, conformance suite.
- Thin adapters for Azure Blob, Cloudflare R2, and S3.
- Hard size ceilings, content-type storage, constrained user metadata.
- Bounded prefix listing for retention and GC.
- Documentation: architecture, threat model, application patterns, adapter
  authoring, releasing.

### Non-goals (v1)

- Client-facing signed upload/download URLs as a port feature.
- Authorization, rate limiting, or audit inside this package.
- Malware scanning, image processing, or CDN purge APIs.
- Cross-object transactions, rename/move as atomic ops, server-side query by
  metadata.
- Object versioning / soft-delete as port defaults.
- Resumable browser multipart protocols on the public surface.
- Building Support Desk attachment product features in this repository.

## Package architecture

| Package                        | Responsibility                 | Phase |
| ------------------------------ | ------------------------------ | ----- |
| `@pegma/storage-blobs`         | Port, memory, conformance      | 1–2   |
| `@pegma/storage-azure-blob`    | Azure Blob adapter             | 3     |
| `@pegma/storage-cloudflare-r2` | Cloudflare R2 adapter          | 4     |
| `@pegma/storage-s3`            | AWS S3 / S3-compatible adapter | 5     |

All publishable packages live in this monorepo (same layout as storage-core).

## Delivery phases

### Phase 0 — repository bootstrap (this commit)

- Monorepo workspace, TypeScript, Vitest, Prettier, Node 22/24 CI, CodeQL.
- Trusted-publisher release scripts (not yet configured on npm).
- `AGENTS.md`, security/contributing docs, project plan, architecture.
- Minimal package export so the gate is green.

**Exit criterion:** green CI on `main`; docs describe scope and non-goals.

### Phase 1 — port, memory store, conformance

- Define `BlobStore` and related types.
- Implement `createMemoryBlobStore`.
- Export conformance cases covering put/get/head/delete, streaming fidelity,
  size limits, content-type round-trip, conditionals, prefix list/cursors, key
  validation.
- Package README usage for server-side composition.
- `docs/APPLICATION_PATTERNS.md` for the metadata + bytes lifecycle.

**Exit criterion:** memory store passes the full suite; public types documented;
no cloud SDK in `@pegma/storage-blobs`.

### Phase 2 — freeze the contract

- Adversarial and edge cases in conformance (empty body, large multi-chunk
  streams, foreign cursors, illegal keys, concurrent create-only races).
- Adapter authoring guide.
- Optional: pack/import smoke already covered by release tooling.

**Exit criterion:** suite is considered the specification for v1 adapters;
further port methods require suite additions in the same change.

### Phase 3 — Azure Blob adapter

- `@pegma/storage-azure-blob` against Azurite (and optionally a real account in
  maintained CI secrets later).
- Same conformance runner as memory.

**Exit criterion:** suite green on Azurite in CI.

### Phase 4 — Cloudflare R2 adapter

- `@pegma/storage-cloudflare-r2` against a real empty bucket or approved local
  harness.
- Forces the port to stay honest under S3-compatible R2 semantics.

**Exit criterion:** suite green on R2 (or documented equivalent) in CI.

### Phase 5 — S3 adapter

- `@pegma/storage-s3` for AWS and S3-compatible endpoints.
- Third backend confirmation of the intersection.

**Exit criterion:** suite green against LocalStack, MinIO, or real S3 test
bucket as chosen in the adapter PR.

### Phase 6 — first supported publish

- Trusted publisher configured for each package.
- First advertised release `0.1.0` (or repository-wide aligned set) with
  provenance.
- Org profile and pegma.dev roadmap entry when appropriate.

**Exit criterion:** public exact versions installable; release runbook followed
once end-to-end.

### Phase 7 — Support Desk Phase 9 consumption (other repository)

- Support Desk attachment contracts and API-mediated upload/download.
- Hosts wire Azure Blob and R2 stores; rate limits and authz on routes.
- No Git/path dependency: exact published versions only.

**Exit criterion:** documented in Support Desk; not implemented in this repo.

## Near-term backlog (post-v1)

- Evaluate host-only signed URL helpers only if a concrete scale need appears
  and the threat model is written first.
- Resumable large-object protocol as a separate design if a consumer needs it.
- Encryption and customer-managed keys as adapter/bucket configuration docs,
  not port surface, until a consumer requires portable guarantees.

## Dependencies

| Package                | Rule                                                               |
| ---------------------- | ------------------------------------------------------------------ |
| `@pegma/storage-blobs` | No runtime dependencies                                            |
| Adapters               | Backend SDKs only; depend on storage-blobs exactly when published  |
| Optional later         | `@pegma/spine` only if the port truly needs `Clock` / logger ports |

Exact `0.x` pins for workspace siblings when introduced. No ranges, no Git
dependencies for production composition.

## Success metrics

- A fresh agent can wire a host upload route to `BlobStore` from README +
  APPLICATION_PATTERNS without reading adapter source.
- Two cloud adapters pass identical conformance without per-cloud behavioural
  forks in components.
- Support Desk Phase 9 can add attachments without forking provider SDKs into
  the support-desk repository.
