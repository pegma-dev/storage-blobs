# Working in this repository

Read this before changing anything. It is short on purpose.

## What this is part of

Storage Blobs is the object-storage foundation of **Pegma**, a family of
MIT-licensed packages a host application composes. Structured records live in
`@pegma/storage-core`; shared identity, time, and logging contracts live in
`@pegma/spine`. They publish under the `@pegma` scope, one repository per
component family.

The governing principle, which every rule below follows from:

> **Optimize for a fresh agent context window.** How much must be read to make
> a correct change, and how does the change prove itself correct? Minimize the
> first, mechanize the second.

Components that store bytes (support attachments, exports, and similar) depend
on this package the way record-backed components depend on storage-core. A
mistake here is a mistake everywhere those components run. Weigh changes
accordingly.

## Hard rules

**The conformance suite is the specification.** A behaviour that is not
asserted in the exported conformance module is not something a component may
rely on, and an adapter is finished only when it passes. Add cases with the
behaviour, never after.

**Verify adapters against a real backend, never a fake.** Azure is tested
against Azurite (or a real account). R2 and S3 use a real empty bucket or a
faithful local S3-compatible service the suite runs against. A mocked client
only proves the adapter agrees with its author.

**A new method on `BlobStore` is a breaking change.** Implement it in every
adapter in this repository and cover it in conformance before merging. Bump
the minor version; adapters written elsewhere will not compile.

**Do not promise what an adapter cannot keep.** The port is the honest
intersection of first-class backends (Azure Blob, R2, S3). If one cloud cannot
honour a guarantee without lying, remove it from the port rather than
documenting a caveat. Cross-object transactions, server-side query by metadata,
and provider ACLs inside the store are out of scope.

**No runtime dependencies in `@pegma/storage-blobs`.** Adapters may depend on
their backend SDK; the port may not depend on anything. Keep it ESM-only and
written against web-standard APIs (`ReadableStream`, `Uint8Array`) where there
is a choice, so it can run outside Node.

**This package is not an access-control system.** Authorization, rate limits,
audit of accepted changes, and malware policy belong to the host and to
components such as Authorization Core and Support Desk. `BlobStore` stores and
returns bytes for **trusted server code** that already decided the caller may
act. Client-facing provider-signed URLs are not the default integration path.

**Do not invent structured persistence here.** Attachment metadata, lifecycle
state, and ticket linkage live in `@pegma/storage-core` collections. This port
holds opaque objects only.

**Never write literal control characters into source.** Write them as escape
sequences such as backslash-u-0000 through backslash-u-001F, and verify the
bytes after any tool-assisted edit.

## Packaging traps already paid for

Each published package needs its **own** README and LICENSE inside the package
directory; npm ignores files at the repository root, and the package page
renders blank without them. Each needs `prepack` running the build, or a stale
`dist` ships silently. Each package `tsconfig.json` must exclude
`src/**/*.test.ts`, or compiled tests are published to consumers.

## Workflow

Work on a `claude/*` branch and open a pull request. The gate is
`npm run format:check`, `npm run check`, and `npm test` — all three, on Node 22
and 24.

Publishing is trusted-publisher only; no tokens exist. A release starts from a
protected signed annotated `vX.Y.Z` tag already on `origin/main`, followed by
`gh release create vX.Y.Z --verify-tag`. The unprivileged preparation job runs
the gate and packs the exact artifacts; only the minimal publish job receives
OIDC authority. See `docs/RELEASING.md`.

## Where things stand

Port, memory store, and conformance suite are implemented in
`@pegma/storage-blobs`. Cloud adapters and the first publish are still open.
Track work in `docs/PROJECT_PLAN.md`.

Siblings: [storage-core](https://github.com/pegma-dev/storage-core),
[spine](https://github.com/pegma-dev/spine),
[support-desk](https://github.com/pegma-dev/support-desk), and the organization
profile at [github.com/pegma-dev](https://github.com/pegma-dev).
