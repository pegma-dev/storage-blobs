# Storage Blobs Architecture

## Place in the stack

```text
┌─────────────────────────────────────────────────────────────┐
│ Host HTTP API (Azure App / Cloudflare Worker / …)           │
│  rate-limit · authorization-core · logging · body limits    │
└────────────────────────────┬────────────────────────────────┘
                             │
          ┌──────────────────┼──────────────────┐
          ▼                  ▼                  ▼
   storage-core          storage-blobs      other ports
   (records,             (bytes,            (mail, …)
    versions,             streams,
    transact)             etags)
          │                  │
          ▼                  ▼
   Tables / D1         Blob / R2 / S3
```

`@pegma/storage-core` and `@pegma/storage-blobs` are sibling foundations. They
do not embed each other. Components that need both (for example Support Desk
attachments) hold **metadata and lifecycle** in storage-core and **payload
bytes** in storage-blobs, linked by an opaque key and an etag snapshot on the
record.

## Primary data path

The default, agent-taught path is API-mediated:

```text
Client ──HTTPS──► Host route ──► Application service ──► BlobStore ──► provider
                     │                    │
                     │                    └── storage-core metadata
                     └── authz, rate limit, validation, logs
```

Clients do not call Azure, R2, or S3 directly. Provider choice is a host
composition detail. This preserves:

- per-request authorization and immediate revocation on download;
- durable rate limits on expensive upload routes;
- one logging and correlation model;
- validation while streaming (size, declared content-type policy);
- no browser exposure of bucket hostnames or capability secrets.

Provider-signed URLs are intentionally **out of the v1 architecture**. They
optimize bandwidth by removing the app process from the byte path and thereby
move rate limiting, validation, and transfer logging off the Pegma control
plane. A future host may still use them under a written threat model; they are
not the port's job and not the default pattern.

## Port boundaries

### In the port

- Opaque object keys (validated charset/length).
- Put / get / head / delete of object bytes.
- Content-type, content-length, opaque etag, optional constrained user metadata.
- Conditional create / replace / delete via etag.
- Store-level maximum object size; per-call limits may only lower it.
- Bounded prefix listing with opaque continuation cursors.
- Web-standard streams for bodies.

### Outside the port

- Who may read or write (Authorization Core + resource checks).
- Rate limiting (`@pegma/rate-limit` at the host).
- Audit of accepted domain changes (`@pegma/audit` in the component).
- Malware scanning and quarantine state machines.
- HTTP routes, multipart form parsing, and browser UX.
- Ticket/message domain models.
- CDN configuration and custom domains.

## Trust and threat model

1. **`BlobStore` is called by trusted server code.** It does not authenticate
   end users.
2. **Object bytes are untrusted content** once a client could influence them.
   Consuming apps must treat payloads as hostile (safe `Content-Disposition`,
   nosniff, no scripted inline render of arbitrary types).
3. **Content-type and user metadata are not security decisions.** Allowlists
   and policy live in the application service.
4. **Keys are not capabilities.** Guessable keys are a design error; components
   mint high-entropy keys. Authorization always checks the storage-core record
   (or equivalent), never “knows the key ⇒ may download.”
5. **No body logging** in this package or in routine host logs.
6. **Credentials for cloud SDKs** stay in the host environment; adapters receive
   preconfigured clients or bindings.

## Concurrency and durability

- Etag-conditioned operations make confirm/replace/delete safe under races.
- Listing is not a snapshot; GC must use conditional delete with the etag it
  observed or accept that a newer object must not be removed.
- There is no multi-object transaction. Application protocols must tolerate
  orphans and repair them.

## Adapter rules

- One package per backend family in this monorepo.
- No behaviour that components rely on unless the conformance suite asserts it.
- Prefer mapping to native conditional headers and streaming APIs.
- Hide multipart implementation details behind streaming `put` until a separate
  resumable-upload design exists.
- Fail closed on oversize and illegal keys.

## Relationship to Support Desk Phase 9

Support Desk will:

- declare attachment metadata in the ticket partition;
- stream uploads and downloads through host routes;
- inject Azure Blob on retiregolden.org and R2 on pegma.dev;
- keep scan, quarantine, and retention policy in application and host code.

This repository supplies only the byte store and its adapters.
